import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobCard } from "./jobcard";
import {
  decodeStoredSession,
  getActivePresetId,
  getPresets,
  getStationRoutes,
  runStation,
  setPresets,
  setStationRoutes,
} from "./orchestrator";
import {
  classifyProviderOutcome,
  healthFromOutcomes,
  PROVIDERS,
  parseProviderOutput,
  presetSwitchReason,
  providerInstalled,
  suggestedPresets,
  validateRoute,
} from "./providers";
import { FactoryStore } from "./store";

describe("provider registry", () => {
  test("each provider builds a headless argv with model, effort and resume where supported", () => {
    const input = {
      model: "m1",
      effort: "high",
      resumeId: "sess-9",
      prompt: "do it",
    };
    expect(PROVIDERS.muse.buildArgs(input)).toEqual([
      "muse",
      "exec",
      "--json",
      "--model",
      "m1",
      "--reasoning-effort",
      "high",
      "--session-id",
      "sess-9",
      "do it",
    ]);
    expect(PROVIDERS.agy.buildArgs(input)).toContain("--conversation");
    expect(PROVIDERS.agy.buildArgs(input)).toContain("--dangerously-skip-permissions");
    expect(PROVIDERS.gemini.buildArgs(input)).toEqual([
      "gemini",
      "-p",
      "do it",
      "-y",
      "--skip-trust",
      "-m",
      "m1",
    ]);
    expect(PROVIDERS.claude.buildArgs(input)).toContain("--resume");
    expect(PROVIDERS.codex.buildArgs(input)[0]).toBe("codex");
  });
  test("installed detection is a PATH fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    writeFileSync(join(dir, "agy"), "#!/bin/sh\n");
    expect(providerInstalled("agy", dir)).toBe(true);
    expect(providerInstalled("codex", dir)).toBe(false);
  });
  test("text and claude-json outputs parse; routes validate", () => {
    expect(parseProviderOutput(PROVIDERS.gemini, "hello\n", 0)).toEqual({
      reply: "hello",
      sessionId: null,
      completed: true,
    });
    expect(parseProviderOutput(PROVIDERS.gemini, "", 1).completed).toBe(false);
    const claude = parseProviderOutput(
      PROVIDERS.claude,
      JSON.stringify({
        result: "done",
        session_id: "s1",
        usage: {
          input_tokens: 10,
          output_tokens: 3,
        },
      }),
      0,
    );
    expect(claude).toEqual({
      reply: "done",
      sessionId: "s1",
      completed: true,
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(
      validateRoute({
        provider: "agy",
        model: "gemini-3-pro",
        effort: "low",
      })?.provider,
    ).toBe("agy");
    expect(
      validateRoute({
        provider: "nope",
        model: "x",
      }),
    ).toBeNull();
    expect(decodeStoredSession("agy:abc", "agy")).toBe("abc");
    expect(decodeStoredSession("agy:abc", "muse")).toBeNull();
    expect(decodeStoredSession("plain-id", "muse")).toBe("plain-id");
  });
  test("station routes accept other providers, muse models stay a closed set", () => {
    const before = getStationRoutes().qc;
    setStationRoutes({
      qc: {
        provider: "agy",
        model: "gemini-3-flash",
        effort: "low",
      },
    });
    expect(getStationRoutes().qc).toEqual({
      provider: "agy",
      model: "gemini-3-flash",
      effort: "low",
    });
    setStationRoutes({
      qc: {
        provider: "muse",
        model: "gpt-nope",
        effort: "low",
      },
    });
    expect(getStationRoutes().qc.provider).toBe("agy"); // unknown muse model ignored, route never breaks
    setStationRoutes({
      qc: before,
    });
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: preset quota/critical scenarios share one ordered-routing fixture
describe("quota failover (preset swap)", () => {
  const routesWithBuilder = (provider: "muse" | "agy", model: string) => ({
    ...getStationRoutes(),
    builder: {
      provider,
      model,
      effort: "medium",
    },
  });

  test("a quota failure swaps the whole active preset and retries the station under it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "failover-"));
    const store = new FactoryStore(dir);
    const quotaStub = join(dir, "quota-stub.ts");
    const okStub = join(dir, "ok-stub.ts");
    writeFileSync(
      quotaStub,
      `console.error("429 usage limit exceeded, quota resets tomorrow"); process.exit(1);`,
    );
    writeFileSync(okStub, `console.log("fallback did the work");`);
    const beforePresets = getPresets();
    const beforeActive = getActivePresetId();
    setPresets(
      [
        {
          id: "p-agy",
          name: "agy builds",
          routes: routesWithBuilder("agy", "gemini-3-flash"),
        },
        {
          id: "p-muse",
          name: "muse builds",
          routes: routesWithBuilder("muse", "muse-spark-1.3"),
        },
      ],
      "p-agy",
    );
    try {
      const card: JobCard = {
        id: "builder",
        jobId: "j1",
        role: "builder",
        task: "do it",
        worktree: dir,
        constraints: [],
        gates: [],
      };
      await store.writeCard(card);
      const note = await runStation(card, {
        store,
        providerCommands: {
          agy: [
            "bun",
            quotaStub,
          ],
          muse: [
            "bun",
            okStub,
          ],
        },
      });
      expect(note.status).toBe("done");
      expect(note.provider).toBe("muse");
      expect(note.detail).toContain("preset");
      expect(note.detail).toContain("quota exhausted");
      expect(getActivePresetId()).toBe("p-muse"); // the whole factory follows the swap
      expect(await store.providerQuotaUntil("agy")).not.toBe("");
      expect(await store.quotaPausedUntil()).toBe(""); // no global pause when a preset carried the station
    } finally {
      setPresets(beforePresets, beforeActive);
    }
  }, 60_000);

  test("critical levels: rates computed from recent outcomes, quota excluded", () => {
    const health = healthFromOutcomes([
      "success",
      "failure",
      "error",
      "quota",
      "failure",
    ]);
    expect(health).toEqual({
      samples: 4,
      failures: 3,
      errors: 1,
      failureRatePercent: 75,
      errorRatePercent: 25,
    });
    expect(
      classifyProviderOutcome({
        done: false,
        timedOut: false,
        reply: "",
        stderr: "spawn failed",
      }),
    ).toBe("error");
    expect(
      classifyProviderOutcome({
        done: false,
        timedOut: false,
        reply: "agent replied but exited",
        stderr: "",
      }),
    ).toBe("failure");
    const preset = suggestedPresets([
      "muse",
      "agy",
    ]).find((s) => s.id === "preset-agy-builds");
    if (!preset) throw new Error("suggestion missing");
    const critical = {
      ...preset,
      critical: {
        onQuota: true,
        failureRatePercent: 50,
        errorRatePercent: 0,
        minSamples: 2,
      },
    };
    expect(presetSwitchReason(critical, health)).toContain("failure rate 75%");
    expect(
      presetSwitchReason(critical, {
        ...health,
        samples: 1,
      }),
    ).toBeNull(); // below min samples
    expect(preset.critical.onQuota).toBe(true); // suggestions carry sane defaults
  });

  test("a preset at its failure critical level is skipped for the next preset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "critical-"));
    const store = new FactoryStore(dir);
    for (let i = 0; i < 2; i++)
      await store.appendProviderOutcome("agy", "failure", new Date().toISOString(), "p-agy");
    const okStub = join(dir, "ok-stub.ts");
    writeFileSync(okStub, `console.log("next preset did the work");`);
    const beforePresets = getPresets();
    const beforeActive = getActivePresetId();
    setPresets(
      [
        {
          id: "p-agy",
          name: "agy builds",
          routes: routesWithBuilder("agy", "gemini-3-flash"),
          critical: {
            onQuota: true,
            failureRatePercent: 50,
            errorRatePercent: 0,
            minSamples: 2,
          },
        },
        {
          id: "p-muse",
          name: "muse builds",
          routes: routesWithBuilder("muse", "muse-spark-1.3"),
        },
      ],
      "p-agy",
    );
    try {
      const card: JobCard = {
        id: "builder",
        jobId: "j1",
        role: "builder",
        task: "do it",
        worktree: dir,
        constraints: [],
        gates: [],
      };
      await store.writeCard(card);
      const note = await runStation(card, {
        store,
        providerCommands: {
          agy: [
            "bun",
            okStub,
          ],
          muse: [
            "bun",
            okStub,
          ],
        },
      });
      expect(note.provider).toBe("muse"); // agy never spent a call: its preset was already critical
      expect(note.detail).toContain("critical level");
      expect(getActivePresetId()).toBe("p-muse");
      const health = await store.providerHealth("agy");
      expect(health.failureRatePercent).toBe(100);
    } finally {
      setPresets(beforePresets, beforeActive);
    }
  }, 60_000);

  test("when every preset is out of quota the station reports quota (existing park behaviour)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "failover-all-"));
    const store = new FactoryStore(dir);
    const quotaStub = join(dir, "quota-stub.ts");
    writeFileSync(quotaStub, `console.error("quota exceeded"); process.exit(1);`);
    const beforePresets = getPresets();
    const beforeActive = getActivePresetId();
    setPresets(
      [
        {
          id: "p-agy",
          name: "agy builds",
          routes: routesWithBuilder("agy", "gemini-3-flash"),
        },
        {
          id: "p-muse",
          name: "muse builds",
          routes: routesWithBuilder("muse", "muse-spark-1.3"),
        },
      ],
      "p-agy",
    );
    try {
      const card: JobCard = {
        id: "builder",
        jobId: "j1",
        role: "builder",
        task: "do it",
        worktree: dir,
        constraints: [],
        gates: [],
      };
      const note = await runStation(card, {
        store,
        providerCommands: {
          agy: [
            "bun",
            quotaStub,
          ],
          muse: [
            "bun",
            quotaStub,
          ],
        },
      });
      expect(note.status).toBe("failed");
      expect(note.summary.startsWith("quota:")).toBe(true);
    } finally {
      setPresets(beforePresets, beforeActive);
    }
  }, 60_000);

  test("suggested presets cross families: a second provider builds, muse checks", () => {
    const suggestions = suggestedPresets([
      "muse",
      "agy",
      "gemini",
    ]);
    const cross = suggestions.find((s) => s.id === "preset-agy-builds");
    expect(cross?.routes.builder.provider).toBe("agy");
    expect(cross?.routes.planner.provider).toBe("muse"); // judgment stays on muse
    expect(
      suggestions.find((s) => s.id === "preset-muse-builds-agy")?.routes.builder.provider,
    ).toBe("muse");
    expect(
      suggestedPresets([
        "muse",
      ]).map((s) => s.id),
    ).toEqual([
      "preset-muse",
    ]);
  });
});
