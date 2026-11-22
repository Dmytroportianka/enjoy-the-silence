import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobCardSchema, renderPrompt } from "./jobcard";
import {
  activeStationFor,
  getStationRoutes,
  runStation,
  STATION_ROUTES,
  setStationRoutes,
} from "./orchestrator";
import { looksLikeQuotaLimit, parseMuseOutput, readSessionUsage } from "./preset";
import { FactoryStore } from "./store";

const SESSION = "01a162dc-682c-79b3-a827-8fb6562bb4d8";
function jsonl(text: string): string {
  return [
    JSON.stringify({
      stream: {
        kind: "session",
        id: SESSION,
      },
      payload_type: "run.output.delta",
      payload: {
        text,
      },
    }),
    JSON.stringify({
      stream: {
        kind: "session",
        id: SESSION,
      },
      payload_type: "run.terminal.completed",
      payload: {
        text,
      },
    }),
  ].join("\n");
}

describe("muse preset parser (probed format)", () => {
  test("extracts session id + terminal text", () => {
    const p = parseMuseOutput(jsonl("echo: ping factory"));
    expect(p.sessionId).toBe(SESSION);
    expect(p.reply).toBe("echo: ping factory");
    expect(p.completed).toBe(true);
  });
  test("raw fallback never blanks", () => {
    expect(parseMuseOutput("plain answer\n").reply).toBe("plain answer");
  });
  test("session usage sums only payload.event.usage, not its record.quantity mirror", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sessions-"));
    const dir = join(root, "2026-01-01", SESSION);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, {
      recursive: true,
    });
    const usage = {
      input_tokens: 100,
      output_tokens: 7,
    };
    writeFileSync(
      join(dir, "session.jsonl"),
      [
        JSON.stringify({
          payload: {
            event: {
              usage,
              record: {
                quantity: usage,
              },
            },
          },
        }),
        JSON.stringify({
          payload: {
            event: {
              usage: {
                input_tokens: 50,
                output_tokens: 3,
              },
            },
          },
        }),
        JSON.stringify({
          payload_type: "run.output.delta",
          payload: {
            text: "x",
          },
        }),
      ].join("\n"),
    );
    expect(looksLikeQuotaLimit("", "Error: usage limit reached, limit resets at 5pm")).toBe(true);
    expect(looksLikeQuotaLimit("", "429 Too Many Requests")).toBe(true);
    expect(looksLikeQuotaLimit("rate limit exceeded", "")).toBe(true);
    expect(looksLikeQuotaLimit("", "agent died on startup")).toBe(false);
    expect(readSessionUsage(SESSION, root)).toEqual({
      inputTokens: 150,
      outputTokens: 10,
    });
    expect(readSessionUsage("missing-session", root)).toBeNull();
  });
  test("session usage is found under the YYYY/MM/DD session layout", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-sessions-"));
    const dir = join(root, "2026", "10", "26", SESSION);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, {
      recursive: true,
    });
    writeFileSync(
      join(dir, "session.jsonl"),
      JSON.stringify({
        payload: {
          event: {
            usage: {
              input_tokens: 42,
              output_tokens: 2,
            },
          },
        },
      }),
    );
    expect(readSessionUsage(SESSION, root)).toEqual({
      inputTokens: 42,
      outputTokens: 2,
    });
  });
  test("mid-stream JSONL (killed agent) is not mistaken for a reply", () => {
    const events = [
      JSON.stringify({
        stream: {
          kind: "session",
          id: SESSION,
        },
        payload_type: "runtime.command.accepted",
        payload: {
          kind: "command_accepted",
        },
      }),
      JSON.stringify({
        stream: {
          kind: "session",
          id: SESSION,
        },
        payload_type: "run.output.delta",
        payload: {
          text: "partial work",
        },
      }),
    ].join("\n");
    const p = parseMuseOutput(events);
    expect(p.completed).toBe(false);
    expect(p.reply).toBe("partial work");
    expect(p.reply).not.toContain("runtime.command.accepted");
    expect(parseMuseOutput(events.split("\n")[0] ?? "").reply).toBe("");
  });
});

describe("live station routes (Settings-editable)", () => {
  test("setStationRoutes applies known models/efforts and ignores unknown ones", () => {
    const before = getStationRoutes().builder;
    setStationRoutes({
      builder: {
        model: "muse-wonder-1.0",
        effort: "low",
      },
    });
    expect(getStationRoutes().builder).toEqual({
      provider: "muse",
      model: "muse-wonder-1.0",
      effort: "low",
    });
    setStationRoutes({
      builder: {
        model: "gpt-nope",
        effort: "low",
      },
    });
    expect(getStationRoutes().builder.model).toBe("muse-wonder-1.0"); // unknown model ignored, route never breaks
    setStationRoutes({
      builder: before,
    });
    expect(getStationRoutes().builder).toEqual(before);
  });
});

describe("station model routing", () => {
  test("judgment stations route to the strong model, execution to the fast one", () => {
    expect(STATION_ROUTES.planner.model).toBe("muse-wonder-1.0");
    expect(STATION_ROUTES.redteam.model).toBe("muse-wonder-1.0");
    expect(STATION_ROUTES.sme.model).toBe("muse-wonder-1.0");
    expect(STATION_ROUTES.builder.model).toBe("muse-spark-1.3");
    expect(STATION_ROUTES.outsider.effort).toBe("low");
  });

  test("a custom stub command receives the prompt untouched (no routing flags)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: process.argv.slice(2).join(" ") } }));`,
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    expect(note.status).toBe("done");
    expect(note.summary).not.toContain("--model");
    expect(note.summary).toContain("WORK ORDER j1 / STATION s1");
  });

  test("a resumed session receives the delta task, not the full card again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: process.argv.slice(2).join(" ") } }));`,
    );
    const card = {
      id: "s1",
      jobId: "j-delta",
      role: "builder" as const,
      task: "FULLCARD build the thing",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const first = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
      deltaTask: "DELTA only the change",
    });
    expect(first.detail).toContain("FULLCARD");
    const second = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
      deltaTask: "DELTA only the change",
    });
    expect(second.detail).toContain("DELTA only the change");
    expect(second.detail).not.toContain("FULLCARD");
  });
});

describe("live station registry (dashboard 'Now' bar)", () => {
  test("a running station is visible by job, and gone when it finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      `await new Promise((r) => setTimeout(r, 400));\nconsole.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: "done" } }));`,
    );
    const card = {
      id: "s1",
      jobId: "j-live",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    expect(activeStationFor("j-live")).toBeNull();
    const pending = runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 100));
    const live = activeStationFor("j-live");
    expect(live?.stationId).toBe("s1");
    expect(live?.role).toBe("builder");
    expect(live?.model).toBe("custom command");
    // The Now-bar modal shows the exact spawn and the prompt it carried.
    expect(live?.commandLine).toContain("bun");
    expect(live?.commandLine).toContain("WORK ORDER j-live / STATION s1");
    expect(live?.prompt).toContain("WORK ORDER j-live / STATION s1");
    expect(live?.sessionId).toBeNull();
    expect(live?.outputBytes).toBe(0);
    await pending;
    expect(activeStationFor("j-live")).toBeNull();
  });
});

describe("job card expected input", () => {
  test("renders work order and rejects malformed cards", () => {
    const card = JobCardSchema.parse({
      id: "s1",
      jobId: "j1",
      role: "builder",
      task: "add hello service",
      worktree: "/tmp/wt",
      constraints: [],
      gates: [
        "redteam",
      ],
    });
    expect(renderPrompt(card)).toContain("WORK ORDER j1 / STATION s1");
    expect(
      JobCardSchema.safeParse({
        id: "s1",
      }).success,
    ).toBe(false);
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("store + reconcile + station run (stub agent)", () => {
  test("run records delivery + session; reconcile clears done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      `console.log(JSON.stringify({stream:{kind:"session",id:"${SESSION}"},payload_type:"run.terminal.completed",payload:{text:"built hello service"}}))`,
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    expect(note.status).toBe("done");
    expect(await store.getSession("j1", "s1")).toBe(SESSION);
    const rec = await store.reconcile("j1");
    expect(rec.done).toEqual([
      "s1",
    ]);
    expect(rec.pending).toEqual([]);
  });

  test("a final answer counts as done even when the agent process exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      [
        `console.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: "status: done" } }));`,
        `process.exit(1); // agent printed its answer, then died on cleanup`,
      ].join("\n"),
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    expect(note.status).toBe("done");
    expect(note.summary).toBe("status: done");
  });

  test("a session created in another workspace is dropped and retried fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    await store.setSession("j1", "s1", "old-session-id");
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      [
        `if (process.argv.includes("--session-id")) { console.error("session old was created in workspace /slot-1; refusing to resume in workspace /slot-0"); process.exit(1); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: "fresh session done" } }));`,
      ].join("\n"),
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    expect(note.status).toBe("done");
    expect(note.summary).toBe("fresh session done");
    expect(await store.getSession("j1", "s1")).toBe(SESSION);
  });

  test("a session locked by an orphaned process is dropped and retried fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    await store.setSession("j1", "s1", "old-session-id");
    const stub = join(dir, "stub.ts");
    await Bun.write(
      stub,
      [
        `if (process.argv.includes("--session-id")) { console.error("muse: workspace root: /slot-0 (cwd default)"); console.error("session old-session-id is already in use"); process.exit(1); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "${SESSION}" }, payload_type: "run.terminal.completed", payload: { text: "fresh session done" } }));`,
      ].join("\n"),
    );
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 10_000,
    });
    expect(note.status).toBe("done");
    expect(note.summary).toBe("fresh session done");
    expect(await store.getSession("j1", "s1")).toBe(SESSION);
  });

  test("an agent killed mid-stream is failed, with the timeout in the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(dir);
    const stub = join(dir, "stub.ts");
    await Bun.write(stub, `await Bun.sleep(5000);`);
    const card = {
      id: "s1",
      jobId: "j1",
      role: "builder" as const,
      task: "add hello service",
      worktree: dir,
      constraints: [],
      gates: [],
    };
    await store.writeCard(card);
    const note = await runStation(card, {
      store,
      command: [
        "bun",
        stub,
      ],
      timeoutMs: 200,
    });
    expect(note.status).toBe("failed");
    expect(note.summary).toContain("timed out");
  });
});
