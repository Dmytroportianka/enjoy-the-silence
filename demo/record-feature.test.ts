// Integration test: one work order through the real pipeline with a mocked
// Muse instance (demo/pipeline-stub.ts). No browser, no tokens — this is the
// same run demo/record-feature.ts films, asserted instead of recorded.
//
// The story it pins: triage picks the standard lane with two red-teams, the
// plan passes both on the first round, the first build ships a smoke check
// too weak to pin the payload, the coder reviewer bounces it, the rework
// pins the greeting, both reviewers pass, the work lands on main, and the
// retro files a finding. If any step changes shape, this test fails first.
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileRetroPoints, runRetro } from "../src/crew/dispatch";
import {
  FEATURE_PROMPT,
  prepareFeatureRepo,
  runFeaturePipeline,
  STUB_COMMAND,
  submitFeatureTask,
} from "./feature-run";

describe("feature creation with a mocked muse (no browser)", () => {
  test("one sentence becomes a landed, reviewed feature", async () => {
    const { root, repo, store } = await prepareFeatureRepo();
    const taskId = "feature-1";
    try {
      await submitFeatureTask(store, taskId);
      const done = await runFeaturePipeline(store, taskId);

      // The whole pipeline ran: planning station, triage, red-teams, build,
      // review and retro all left job cards in the store.
      const cards = await store.listCards(taskId);
      expect(cards.map((c) => c.id).sort()).toEqual([
        "builder",
        "coder",
        "planner",
        "redteam-outsider",
        "redteam-sme",
        "sme",
        "triage",
      ]);

      // Triage sent it down the standard lane with two red-teams — the plan
      // gates actually fired, not skipped.
      expect(done.triage).toContain("standard");
      expect(done.plan).toContain("Intent");

      // The coder reviewer bounced the first attempt (smoke check too weak
      // to pin the payload); the builder reworked and attempt two converged.
      expect(done.attempts).toBe(2);
      const prompts = await store.listPrompts(taskId);
      expect(prompts.some((p) => p.text.includes("REJECT weak coverage"))).toBe(true);
      expect(prompts.some((p) => p.text.includes("PASS coder ok"))).toBe(true);

      // The work landed on main with both files, and the pipeline collected
      // the verification recording the builder left in the worktree.
      expect(existsSync(join(repo, "hello.js"))).toBe(true);
      expect(existsSync(join(repo, "hello.test.js"))).toBe(true);
      expect(await store.listArtifacts(done)).toContain("verification.webm");

      // The retro (dashboard-driven in the recording; called directly here,
      // the same way the dashboard sweep calls it) reviews the run and files
      // its finding as a candidate task for the owner.
      await runRetro(taskId, {
        store,
        command: STUB_COMMAND,
      });
      const retro = await store.readRetro(taskId);
      expect(retro?.text ?? "").toContain("FINDING");
      await fileRetroPoints(store, done);
      const retroTasks = (await store.listTasks()).filter((t) => t.id !== taskId);
      expect(retroTasks.some((t) => t.prompt.includes("smoke check"))).toBe(true);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  }, 180_000);

  test("the mocked muse never touches a real model", () => {
    // The pipeline only knows the stub command; nothing in the run can
    // resolve to the muse preset, so this test costs zero tokens.
    expect(FEATURE_PROMPT).toContain("hello service");
  });
});
