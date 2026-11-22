import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerPlanQuestions,
  assessMergeability,
  assessPickup,
  availableMbFromMeminfo,
  changedPlanSections,
  commentOnPlan,
  composeFindings,
  decisionsHashAt,
  defaultVerifyCommand,
  digestVerifyFailure,
  dispatchTick,
  effectiveVerifyCommand,
  encryptPushPayload,
  ensureWarmWorktrees,
  executionBrief,
  fileRetroPoints,
  finalizeTaskWork,
  isAdditionsOnlyDiff,
  isAllowlistedIgnoredCarryover,
  isDecisionsFile,
  isSafeVerifyCommand,
  isSecretLikeFile,
  isSettledQuestion,
  isTighteningOnlyDiff,
  landTaskWork,
  looksLikeProse,
  normalizeDecisionLine,
  notifyNeedsInput,
  ownerQuestions,
  parseTriage,
  prepareWorktree,
  ramAdvice,
  releaseWorktree,
  resolveRebaseWithAgent,
  resolveStalePlan,
  retryPendingPushes,
  runningCount,
  runPlanPipeline,
  runRetro,
  runRetroFollowup,
  runTaskPipeline,
  sanitizeGateVeto,
  saveAndRebaseWorktree,
  saveRebaseWithAgentFallback,
  stalePlanRefusal,
  taskDiff,
  vapidJwt,
  WorktreePoolFullError,
  worktreeActivity,
  worktreeLeasedByTask,
} from "./dispatch";
import { FactoryStore } from "./store";
import { approvePlan, draftPlan, newTask } from "./task";

const T0 = "2026-10-22T10:00:00.000Z";

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "dispatch-"));
  const repo = join(base, "app");
  mkdirSync(repo, {
    recursive: true,
  });
  const git = (args: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
      cwd: repo,
      encoding: "utf8",
    });
  git("init -q");
  await Bun.write(join(repo, "a.txt"), "one\n");
  git("add a.txt");
  git("commit -qm one");
  const store = new FactoryStore(join(base, "store"));
  await store.registerProject("p1", repo);
  const stub = join(base, "stub.ts");
  await Bun.write(
    stub,
    [
      `import { execSync } from "node:child_process";`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const prompt = process.argv[process.argv.length - 1] ?? "";`,
      `const cwd = process.cwd();`,
      `let text = "built the feature";`,
      `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Why\\nNeeded.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
      `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps, with a test.\\n## Red-team decisions\\nCHANGED: add a test (sme)\\nKEPT: no simpler solution needed (outsider), the change is already minimal\\nOWNER: is the hello service public?\\n## Questions for the owner\\n- Should the hello service be public?\\n"); text = "PLAN_REVISED"; }`,
      `else if (prompt.includes("The owner answered your open questions")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, public.\\n## Red-team decisions\\nCHANGED: made public per owner\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
      `else if (prompt.includes("commented on individual lines")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, revised per owner line comments.\\n## Red-team decisions\\nCHANGED: applied line comments\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
      `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme plan ok\\nArgument: intent is narrow enough to test\\nArgument: approach reuses existing routes";`,
      `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: why-now holds, problem is current\\nArgument: no simpler solution was named";`,
      `else if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nIntent as I understand it: ship the route\\nArgument: diff matches the plan";`,
      `else if (prompt.includes("Review as a code reviewer")) { const flag = join(cwd, ".coder-rejected"); if (!existsSync(flag)) { writeFileSync(flag, "1"); text = "REJECT missing coverage\\nArgument: no test exercises the new route"; } else text = "PASS coder ok\\nArgument: coverage now exists"; }`,
      `else if ((prompt.includes("is not runnable") || prompt.includes("not a real check")) && !prompt.includes("unnameable")) text = "found how this project is verified\\nVERIFY: true";`,
      `else if (prompt.includes("Write the retrospective")) text = "RETRO_DONE\\nThe verify command failed twice before the builder named one.\\nFINDING: extract the repeated curl checks into a reusable health script\\nFINDING: add a regression test for the verify reroute path";`,
      `else if (prompt.includes("commented on the retrospective")) text = "RETRO_DONE\\n## Answers\\nThe verify command was a sentence, not a program.\\nFINDING: extract the repeated curl checks into a reusable health script";`,
      `else if (prompt.includes("impact judge for a decisions-file change")) text = prompt.includes("contradicts-the-plan") ? "ASK-OWNER this reverses a recorded decision the plan relies on" : "PROCEED tightening only\\nThe change only adds a rule; nothing contradicts the plan";`,
      `else if (prompt.includes("Resolve the git rebase conflict")) { const head = (prompt.match(/git rebase ([0-9a-f]{7,40})/) ?? [])[1] ?? "HEAD"; const g = (a: string) => execSync("git -c user.name=t -c user.email=t@t " + a, { cwd, encoding: "utf8" }); try { g("rebase " + head); } catch { /* conflict expected */ } for (const f of g("diff --name-only --diff-filter=U").split("\\n").filter(Boolean)) { g('checkout --theirs -- "' + f + '"'); g('add -- "' + f + '"'); } g("-c core.editor=true rebase --continue"); text = "RESOLVED"; }`,
      `else if (prompt.includes("its git commit failed")) { const g = (a: string) => execSync("git -c user.name=t -c user.email=t@t " + a, { cwd, encoding: "utf8" }); const head = (prompt.match(/new main base ([0-9a-f]{7,40})/) ?? [])[1] ?? "HEAD"; const absGitDir = execSync("git rev-parse --absolute-git-dir", { cwd, encoding: "utf8" }).trim(); try { execSync('rm -f "' + absGitDir + '/index.lock"', { cwd, encoding: "utf8" }); } catch { /* no stale lock */ } g("add -A"); g('commit -qm "factory: save uncommitted work before pickup on new base (task t1)"'); try { g("rebase " + head); } catch { /* may conflict */ } for (const f of g("diff --name-only --diff-filter=U").split("\\n").filter(Boolean)) { g('checkout --theirs -- "' + f + '"'); g('add -- "' + f + '"'); } try { g("-c core.editor=true rebase --continue"); } catch { /* already finished */ } text = "RESOLVED"; }`,
      `else { writeFileSync(join(cwd, "verification.webm"), "fake-video-bytes"); }`,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));`,
    ].join("\n"),
  );
  const failStub = join(base, "fail-stub.ts");
  await Bun.write(
    failStub,
    [
      `console.error("agent died on startup");`,
      `process.exit(1);`,
    ].join("\n"),
  );
  return {
    base,
    repo,
    store,
    stub,
    failStub,
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("plan pipeline (planner + dual red-team -> artifact)", () => {
  test("a plan both red-teams pass on the first round is accepted as drafted — no reviser, no re-review", async () => {
    const { repo, store, stub } = await setup();
    const proj = await store.readProject("p1");
    if (proj)
      await store.writeProject({
        ...proj,
        description: "candle shop",
        rules: "never discount over 20%",
      });
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      tags: [
        "css",
      ],
    };
    await store.writeTask(task);
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.planState).toBe("draft");
    expect(drafted.plan).toContain("Intent");
    const artifact = await Bun.file(join(repo, "data", "plans", "t1.md")).text();
    expect(artifact).toContain("outside reviewer");
    expect(artifact).toContain("PASS");
    // Red-team thoughts/arguments are shown, not just the verdict line.
    expect(artifact).toContain("Argument: intent is narrow enough to test");
    expect(artifact).toContain("Argument: why-now holds, problem is current");
    // A unanimous first-round PASS accepts the draft as-is: no reviser pass,
    // no second red-team round, no "Revised plan" section.
    expect(artifact).not.toContain("Revised plan");
    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id).sort()).toEqual([
      "planner",
      "redteam-outsider",
      "redteam-sme",
      "triage",
    ]);
    expect(drafted.plan).not.toContain("Red-team decisions");
    expect(drafted.planQuestions).toEqual([]);
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("accepted as drafted")),
    ).toBe(true);
    // No open questions: the plan can be approved without the owner's click.
    expect(approvePlan(drafted, T0).planState).toBe("approved");
    // The outsider judges without codebase access: its cwd is the plans dir.
    expect(cards.find((c) => c.id === "redteam-outsider")?.worktree).toBe(
      join(repo, "data", "plans"),
    );
    // The SME carries the project's soul (context + rules); the outsider does not.
    expect(cards.find((c) => c.id === "redteam-sme")?.task).toContain("never discount over 20%");
    expect(cards.find((c) => c.id === "redteam-sme")?.task).toContain("subject-matter expert for");
    expect(cards.find((c) => c.id === "redteam-outsider")?.task).not.toContain(
      "never discount over 20%",
    );
    // Owner decisions are authoritative unless facts or decisions.md conflict.
    expect(cards.find((c) => c.id === "redteam-sme")?.task).toContain("conflict with decisions.md");
    expect(cards.find((c) => c.id === "redteam-outsider")?.task).toContain(
      "instead of silently overriding the recorded decision",
    );
    expect(cards.find((c) => c.id === "planner")?.worktree).toContain("worktrees");
  }, 120_000);

  test("a rejected plan reaches the reviser, whose open question blocks approval until answered", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-owner-question.ts");
    await Bun.write(
      stub,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=standard size=M redteams=2 risks=none est=~8 stations\\nmoderate behaviour change";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) { const flag = join(cwd, ".sme-rejected"); if (!existsSync(flag)) { writeFileSync(flag, "1"); text = "REJECT missing a test\\nArgument: no test is named"; } else text = "PASS sme ok\\nArgument: the test is named now"; }`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: why-now holds";`,
        `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, with a test.\\n## Approach\\nSmall steps.\\n## Red-team decisions\\nCHANGED: add a test (sme)\\nOWNER: is the hello service public?\\n## Questions for the owner\\n- Should the hello service be public?\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("The owner answered your open questions")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, public.\\n## Red-team decisions\\nCHANGED: made public per owner\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-oq" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    await store.writeTask(task);
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    // A rejection reached the reviser, which escalated one point to the owner.
    expect(drafted.planState).toBe("draft");
    expect(drafted.plan).toContain("Red-team decisions");
    expect(drafted.planQuestions).toEqual([
      "Should the hello service be public?",
    ]);
    expect(() => approvePlan(drafted, T0)).toThrow(/needs your decision/);
    const answered = await answerPlanQuestions("t1", "1. yes, public", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    // The answer re-runs the red-teams, which now pass on the first round.
    expect(answered.planQuestions).toEqual([]);
    expect(answered.plan).toContain("Do the thing");
    expect(answered.settledQuestions).toEqual([
      "Should the hello service be public?",
    ]);
  });

  test("owner answers are recorded and queued, not lost, when the worktree pool is full", async () => {
    const { store, stub } = await setup();
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "plan",
      T0,
      [
        "Should the hello service be public?",
      ],
    );
    await store.writeTask(task);
    const holder = await prepareWorktree(
      store,
      newTask(
        {
          id: "t-holder",
          projectId: "p1",
          title: "holder",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 1,
      },
    );
    const queued = await answerPlanQuestions("t1", "1. yes, public", {
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      now: () => T0,
    });
    expect(queued.planState).toBe("none");
    expect(queued.planRequested).toBe(true);
    expect(queued.planQuestions).toEqual([]);
    expect(queued.settledQuestions).toEqual([
      "Should the hello service be public?",
    ]);
    expect(
      (await store.listPrompts("t1")).some(
        (p) => p.kind === "user" && p.text.includes("yes, public"),
      ),
    ).toBe(true);
    releaseWorktree(holder);
  });

  test("a stale lease from a missing task does not block the worktree pool", async () => {
    const { store } = await setup();
    const holder = await prepareWorktree(
      store,
      newTask(
        {
          id: "t-holder",
          projectId: "p1",
          title: "holder",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 1,
      },
    );
    releaseWorktree(holder);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${holder.worktree}.lease`, "task-ghost-missing");
    const next = await prepareWorktree(
      store,
      newTask(
        {
          id: "t-next",
          projectId: "p1",
          title: "t-next",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 1,
      },
    );
    expect(next.worktree).toBe(holder.worktree);
    releaseWorktree(next);
  });

  test("owner line comments revise the plan without needing open questions", async () => {
    const { store, stub } = await setup();
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "1. add route\n2. test",
      T0,
    );
    await store.writeTask(task);
    const revised = await commentOnPlan(
      "t1",
      'Line 1: "1. add route"\nOwner comment: make it POST',
      {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      },
    );
    // Comments also trigger a red-team review of the updated plan.
    expect(revised.plan).toContain("Do the thing");
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("line comments and re-reviewed")),
    ).toBe(true);
    expect(revised.planState).toBe("draft");
    // No rejection, so no reviser ran and no open question was raised.
    expect(revised.planQuestions).toEqual([]);
  });

  test("worktreeActivity lists changed files newest first for the worker view", async () => {
    const { repo, store } = await setup();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      worktree: repo,
    };
    await store.writeTask(task);
    await Bun.write(join(repo, "new-file.txt"), "x\n");
    const rows = worktreeActivity(task);
    expect(rows[0]?.file).toBe("new-file.txt");
    expect(rows[0]?.status).toBe("??");
    expect(rows[0]?.modifiedAt).not.toBe("");
    expect(
      worktreeActivity({
        ...task,
        worktree: "",
      }),
    ).toEqual([]);
  }, 120_000);
});

describe("iterative red-team re-review (review, revise, review again until agreed)", () => {
  test("a rejected plan is revised and re-reviewed until both red-teams pass", async () => {
    const { base, repo, store } = await setup();
    const stub2 = join(base, "stub2.ts");
    await Bun.write(
      stub2,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) { const flag = join(cwd, ".sme-rejected"); if (!existsSync(flag)) { writeFileSync(flag, "1"); text = "REJECT missing a test\\nArgument: no test is named"; } else text = "PASS sme ok\\nArgument: the test is named now"; }`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: why-now holds";`,
        `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, with a test.\\n## Approach\\nSmall steps.\\n## Red-team decisions\\nCHANGED: add a test (sme)\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-2" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    await store.writeTask(task);
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(drafted.planState).toBe("draft");
    expect(drafted.planQuestions).toEqual([]);
    expect(drafted.plan).toContain("with a test");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("red-teams agreed on round 2"))).toBe(true);
    const artifact = await Bun.file(join(repo, "data", "plans", "t1.md")).text();
    expect(artifact).toContain("Red-team round 1");
    expect(artifact).toContain("Red-team round 2");
    // Two SME deliveries happened; the latest (round 2) is the PASS.
    const cards = await store.listCards("t1");
    expect(cards.filter((c) => c.id === "redteam-sme").length).toBe(1);
  }, 120_000);

  test("a plan that needs a decisions.md change records it at planning, not at merge", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-decisions-change.ts");
    await Bun.write(
      stub,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=standard size=S redteams=2 risks=none\\nsmall and safe";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n## decisions.md change\\n- never skip lint\\n- always run typecheck\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: fine";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: fine";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-dc" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    await store.writeTask(task);
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.decisionsChange).toContain("never skip lint");
    expect(drafted.decisionsChange).toContain("always run typecheck");
    expect(drafted.plan).not.toContain("decisions.md change"); // lifted out of the plan
    expect(drafted.plan).toContain("Success criteria");
    expect(
      (await store.listPrompts("t1")).some((p) =>
        p.text.includes("decisions.md change identified at planning"),
      ),
    ).toBe(true);
  });
});

const CONSISTENCY_CONTRADICTORY =
  "# Intent\\nDo the thing.\\n## Approach\\nforce-push the branch to share it\\nSmall steps.\\n## Success criteria\\nnever rewrite shared history\\nbun test passes\\n";
const CONSISTENCY_CLEAN =
  "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nnever rewrite shared history\\nbun test passes\\n";

async function consistencyStub(
  base: string,
  name: string,
  correctionBody: string,
  triage = "TRIAGE lane=standard size=M redteams=2 risks=none est=~8 stations\\nmoderate change",
) {
  const stub = join(base, name);
  await Bun.write(
    stub,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const prompt = process.argv[process.argv.length - 1] ?? "";`,
      `const cwd = process.cwd();`,
      `let text = "built";`,
      `if (prompt.includes("Triage this task")) text = "${triage}";`,
      `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "${CONSISTENCY_CONTRADICTORY}"); text = "PLAN_WRITTEN"; }`,
      `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "${correctionBody}"); text = "PLAN_CORRECTED"; }`,
      `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: consistent now";`,
      `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: consistent now";`,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-c" }, payload_type: "run.terminal.completed", payload: { text } }));`,
    ].join("\n"),
  );
  return stub;
}

describe("plan consistency (contradiction fixed once at authoring)", () => {
  test("a contradictory draft is corrected before either red-team sees it", async () => {
    const { base, store } = await setup();
    const stub = await consistencyStub(base, "stub-consistency.ts", CONSISTENCY_CLEAN);
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.planState).toBe("draft");
    expect(drafted.plan).toContain("never rewrite shared history");
    expect(drafted.plan).not.toContain("force-push");
    const cards = await store.listCards("t1");
    expect(cards.some((c) => c.id === "plan-consistency-fix")).toBe(true);
    // Neither red-team saw the contradictory draft: both reviewer cards
    // carry the corrected plan (proposal gone, rule kept).
    const sme = cards.find((c) => c.id === "redteam-sme");
    const outsider = cards.find((c) => c.id === "redteam-outsider");
    expect(sme?.task).toContain("never rewrite shared history");
    expect(sme?.task).not.toContain("force-push the branch");
    expect(outsider?.task).toContain("never rewrite shared history");
    expect(outsider?.task).not.toContain("force-push the branch");
    // The correction settled at authoring, before the review verdict.
    const prompts = await store.listPrompts("t1");
    const fixIdx = prompts.findIndex((p) => p.text.includes("plan contradiction corrected"));
    const reviewIdx = prompts.findIndex((p) => p.text.includes("red-teams passed the plan"));
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeGreaterThan(fixIdx);
    // The correction card carries only the sanitised form, never clause text.
    const fixCard = cards.find((c) => c.id === "plan-consistency-fix");
    expect(fixCard?.task).toContain("force-push");
    expect(fixCard?.task).not.toContain("force-push the branch to share it");
    expect(sanitizeGateVeto(fixCard?.task ?? "").removed).toEqual([]);
  }, 120_000);

  test("a correction that keeps the proposal fails prohibition-wins with the quoted pair", async () => {
    const { base, store } = await setup();
    const keepProposal =
      "# Intent\\nDo the thing.\\n## Approach\\nforce-push the branch to share it\\nSmall steps.\\n";
    const stub = await consistencyStub(base, "stub-prohibition-wins.ts", keepProposal);
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    let err: unknown = null;
    try {
      await runPlanPipeline("t1", {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/prohibition wins/);
    expect(String(err)).toMatch(/force-push the branch to share it/);
    expect(String(err)).toMatch(/never rewrite shared history/);
    const task = await store.readTask("t1");
    expect(task?.planState).toBe("none"); // no drafted plan
    const cards = await store.listCards("t1");
    expect(cards.some((c) => c.id === "builder")).toBe(false); // no builder card
  }, 120_000);

  test("a draft the correction pass cannot fix fails with the quoted line pair", async () => {
    const { base, store } = await setup();
    const stub = await consistencyStub(base, "stub-unfixable.ts", CONSISTENCY_CONTRADICTORY);
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    await expect(
      runPlanPipeline("t1", {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      }),
    ).rejects.toThrow(/contradicts itself/);
    const task = await store.readTask("t1");
    expect(task?.planState).toBe("none");
    expect((await store.listCards("t1")).some((c) => c.id === "builder")).toBe(false);
  }, 120_000);
});

describe("plan consistency (fast lane, reviser, owner flows, decisions)", () => {
  test("a contradictory plan on the fast lane is corrected, not auto-approved as-is", async () => {
    const { base, store } = await setup();
    const stub = await consistencyStub(
      base,
      "stub-fast-contradiction.ts",
      CONSISTENCY_CLEAN,
      "TRIAGE lane=fast size=XS redteams=0 risks=none est=~2 stations\\nsmall and safe",
    );
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    const done = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.planState).toBe("approved"); // fast lane still auto-approves — the clean plan
    expect(done.plan).not.toContain("force-push");
    expect(done.plan).toContain("never rewrite shared history");
  }, 120_000);

  test("a contradiction introduced by the reviser is corrected and re-reviewed", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-reviser-contradiction.ts");
    await Bun.write(
      stub,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=standard size=M redteams=2 risks=none est=~8 stations\\nmoderate change";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) { const flag = join(cwd, ".sme-rejected"); if (!existsSync(flag)) { writeFileSync(flag, "1"); text = "REJECT missing rollback\\nArgument: no rollback named"; } else text = "PASS sme ok\\nArgument: rollback settled"; }`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: fine";`,
        `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Red-team decisions\\nCHANGED: added rollback (sme)\\n## Questions for the owner\\n- Should the rollback be automatic?\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps with rollback.\\n## Success criteria\\nnever rewrite shared history\\n## Red-team decisions\\nCHANGED: added rollback (sme)\\n## Questions for the owner\\nNone\\n"); text = "PLAN_CORRECTED"; }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-rc" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.plan).not.toContain("force-push");
    expect(drafted.plan).toContain("never rewrite shared history");
    // Questions were recomputed from the corrected plan: the reviser's
    // stale question did not survive a correction that drops the section.
    expect(drafted.planQuestions).toEqual([]);
  }, 120_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("plan consistency (owner flows, decisions section)", () => {
  test("a contradictory plan entering through owner answers is settled before drafting", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-answer-contradiction.ts");
    await Bun.write(
      stub,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("The owner answered your open questions")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, public.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "# Intent\\nDo the thing, public.\\n## Approach\\nSmall steps.\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_CORRECTED"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: consistent";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: consistent";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-ac" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "plan",
      T0,
      [
        "Should the hello service be public?",
      ],
    );
    await store.writeTask(task);
    const answered = await answerPlanQuestions("t1", "1. yes, public", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(answered.plan).not.toContain("force-push");
    expect(answered.plan).toContain("never rewrite shared history");
  }, 120_000);

  test("an unfixable contradictory plan entering through owner answers is rejected before either red-team runs", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-answer-unfixable.ts");
    await Bun.write(
      stub,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("The owner answered your open questions")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, public.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "# Intent\\nDo the thing, public.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_CORRECTED"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: consistent";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: consistent";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-au" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "plan",
      T0,
      [
        "Should the hello service be public?",
      ],
    );
    await store.writeTask(task);
    let err: unknown = null;
    try {
      await answerPlanQuestions("t1", "1. yes, public", {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/planning failed: plan contradicts itself/);
    expect(String(err)).toMatch(/force-push the branch to share it/);
    expect(String(err)).toMatch(/never rewrite shared history/);
    // The reviser ran and the gate fired, but neither red-team was invoked.
    const cardIds = (await store.listCards("t1")).map((c) => c.id);
    expect(cardIds).toContain("plan-reviser");
    expect(cardIds).toContain("plan-consistency-fix");
    expect(cardIds).not.toContain("redteam-sme");
    expect(cardIds).not.toContain("redteam-outsider");
    // No new draft was written: the seeded plan and its state stand.
    const stored = await store.readTask("t1");
    expect(stored?.plan).toBe("plan");
    expect(stored?.planState).toBe("draft");
  }, 120_000);

  test("an unfixable contradictory plan entering through line comments is rejected before either red-team runs", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-comment-unfixable.ts");
    await Bun.write(
      stub,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("commented on individual lines")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, revised per owner line comments.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "# Intent\\nDo the thing, revised per owner line comments.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_CORRECTED"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: consistent";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: consistent";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-cu" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "1. add route\n2. test",
      T0,
    );
    await store.writeTask(task);
    let err: unknown = null;
    try {
      await commentOnPlan("t1", 'Line 1: "1. add route"\nOwner comment: make it POST', {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/planning failed: plan contradicts itself/);
    expect(String(err)).toMatch(/force-push the branch to share it/);
    expect(String(err)).toMatch(/never rewrite shared history/);
    // The reviser ran and the gate fired, but neither red-team was invoked.
    const cardIds = (await store.listCards("t1")).map((c) => c.id);
    expect(cardIds).toContain("plan-reviser");
    expect(cardIds).toContain("plan-consistency-fix");
    expect(cardIds).not.toContain("redteam-sme");
    expect(cardIds).not.toContain("redteam-outsider");
    // No new draft was written: the seeded plan and its state stand.
    const stored = await store.readTask("t1");
    expect(stored?.plan).toBe("1. add route\n2. test");
    expect(stored?.planState).toBe("draft");
  }, 120_000);

  test("a contradictory plan entering through line comments is settled before drafting", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-comment-contradiction.ts");
    await Bun.write(
      stub,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("commented on individual lines")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, revised per owner line comments.\\n## Approach\\nforce-push the branch to share it\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("Fix the plan contradiction")) { writeFileSync(join(cwd, "PLAN-CORRECTED.md"), "# Intent\\nDo the thing, revised per owner line comments.\\n## Approach\\nSmall steps.\\n## Success criteria\\nnever rewrite shared history\\n## Questions for the owner\\nNone\\n"); text = "PLAN_CORRECTED"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme ok\\nArgument: consistent";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: consistent";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-cc" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = draftPlan(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      "1. add route\n2. test",
      T0,
    );
    await store.writeTask(task);
    const revised = await commentOnPlan(
      "t1",
      'Line 1: "1. add route"\nOwner comment: make it POST',
      {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      },
    );
    expect(revised.planState).toBe("draft");
    expect(revised.plan).not.toContain("force-push");
    expect(revised.plan).toContain("never rewrite shared history");
    // Both red-teams judged the corrected plan, never the contradiction.
    const cards = await store.listCards("t1");
    const sme = cards.find((c) => c.id === "redteam-sme");
    const outsider = cards.find((c) => c.id === "redteam-outsider");
    expect(sme?.task).toContain("never rewrite shared history");
    expect(sme?.task).not.toContain("force-push the branch");
    expect(outsider?.task).toContain("never rewrite shared history");
    expect(outsider?.task).not.toContain("force-push the branch");
  }, 120_000);

  test("a correction that rewrites the decisions section is recorded and lifted out", async () => {
    const { base, store } = await setup();
    const withDecisions =
      "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nnever rewrite shared history\\n## decisions.md change\\n- corrected rule: never rewrite history\\n";
    const stub = await consistencyStub(base, "stub-decisions-correction.ts", withDecisions);
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    );
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.decisionsChange).toContain("corrected rule: never rewrite history");
    expect(drafted.plan).not.toContain("decisions.md change");
    expect(drafted.plan).not.toContain("force-push");
  }, 120_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("implementation <-> review loop (Ralph loop, escalation, artifacts)", () => {
  test("coder rejection bounces to implementation, escalates, then converges to done", async () => {
    const { base, repo, store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      tags: [
        "css",
      ],
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0), T0);
    await store.writeTask(task);
    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "add hello service",
    });

    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    expect(done.attempts).toBe(2); // first attempt rejected by coder, second converged
    expect(done.worktree).toBe(join(base, ".enjoy-worktrees", "p1", "t1"));
    // Finalized on finish: the legacy per-task worktree is removed once
    // its work is proven merged into main.
    expect(existsSync(done.worktree)).toBe(false);

    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id).sort()).toEqual([
      "builder",
      "coder",
      "sme",
    ]);
    // The coder reviewer carries its own derived soul, not the SME's.
    expect(cards.find((c) => c.id === "coder")?.task).toContain("pragmatic senior coder");
    for (const c of cards) expect(c.worktree).toBe(done.worktree);
    expect(cards.find((c) => c.id === "builder")?.constraints.join(" ")).toContain("model tier:");

    // Playwright-style video evidence was collected into the project data.
    expect(await store.listArtifacts(done)).toContain("verification.webm");
    expect(existsSync(join(repo, "data", "artifacts", "t1", "verification.webm"))).toBe(true);
    // Reviewer arguments reach the task history, not only verdicts.
    const history = await store.listPrompts("t1");
    expect(history.some((p) => p.text.includes("Argument: no test exercises the new route"))).toBe(
      true,
    );
    expect(history.some((p) => p.text.includes("Intent as I understand it"))).toBe(true);
    // Finished work entered the tag history for future planning.
    const similar = await store.similarTasks("p1", [
      "css",
    ]);
    expect(similar.map((s) => s.taskId)).toContain("t1");
  }, 60_000);

  test("failing verification loops the Ralph station, then asks the owner", async () => {
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "false",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const stuck = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 2,
    });
    expect(stuck.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.kind === "system" && p.text.includes("verification failed"))).toBe(
      true,
    );
  }, 120_000);

  test("a task that exhausts its attempt budget fails terminally instead of running again", async () => {
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      attempts: 2,
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const failed = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxAttempts: 2,
    });
    expect(failed.state).toBe("failed");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.kind === "system" && p.text.includes("attempt cap reached"))).toBe(
      true,
    );
    // The budget was already spent: no builder station launched.
    expect(prompts.some((p) => p.text.includes("builder (attempt"))).toBe(false);
  });

  test("an unrunnable verify command is rerouted to the builder, whose named command is saved and used", async () => {
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "the file selector allows navigation",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 3,
    });
    expect(done.state).toBe("done");
    expect((await store.readTask("t1"))?.verifyCommand).toBe("true");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("rerouting to the builder"))).toBe(true);
    expect(prompts.some((p) => p.text.includes("builder named a working one"))).toBe(true);
  }, 60_000);

  test("when the builder cannot name a working verify command, the owner is asked", async () => {
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "unnameable check please",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const stuck = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 3,
    });
    expect(stuck.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("builder could not name a working one"))).toBe(true);
    // One build + one rerouted build, then it stops asking the agent.
    expect(prompts.filter((p) => p.text.includes("builder (attempt")).length).toBe(2);
  }, 120_000);

  test("a verify command that runs green but reads like a sentence is not trusted — the builder names a real check", async () => {
    // `file selector allows navigation` runs the real `file` binary and
    // exits 0, so a green exit code alone would call the task done. The
    // factory must treat prose as no verification at all and reroute.
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "file selector allows navigation",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 3,
    });
    expect(done.state).toBe("done");
    expect((await store.readTask("t1"))?.verifyCommand).toBe("true");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("reads like a sentence"))).toBe(true);
    expect(prompts.some((p) => p.text.includes("builder named a working one"))).toBe(true);
  }, 60_000);

  test("when the builder also names prose, the owner is asked instead of a false pass", async () => {
    // Green + prose on the first pass reroutes; the stub falls through
    // (no VERIFY line) because the stored command contains "unnameable",
    // so the second pass still faces prose — that parks for the owner.
    const { store, stub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "file unnameable selector navigation",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const stuck = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 3,
    });
    expect(stuck.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("builder could not name a real one"))).toBe(true);
    expect(prompts.filter((p) => p.text.includes("builder (attempt")).length).toBe(2);
  }, 120_000);

  test("builder station failure pauses resumably (needs-input), never terminally Failed", async () => {
    const { store, failStub } = await setup();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      tags: [
        "css",
      ],
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0), T0);
    await store.writeTask(task);
    const paused = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        failStub,
      ],
      now: () => T0,
    });
    expect(paused.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(
      prompts.some(
        (p) => p.kind === "system" && p.text.includes("builder station did not complete"),
      ),
    ).toBe(true);
    // The dead station was retried automatically on fresh sessions
    // before it parked — the owner was not asked between failures.
    expect(
      prompts.filter((p) => p.text.includes("automatically retrying with a fresh session")).length,
    ).toBe(2);
  }, 120_000);

  test("a builder station that dies once recovers on its own and finishes", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-flaky-builder.ts");
    await Bun.write(
      stub2,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built the feature";`,
        `if (prompt.includes("Review as")) text = "PASS ok\\nArgument: fine";`,
        `else { const flag = join(cwd, ".builder-died"); if (!existsSync(flag)) { writeFileSync(flag, "1"); console.error("builder blew up"); process.exit(1); } writeFileSync(join(cwd, "verification.webm"), "video"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-b" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    expect(
      (await store.listPrompts("t1")).some((p) =>
        p.text.includes("automatically retrying with a fresh session"),
      ),
    ).toBe(true);
  }, 60_000);

  test("unwritable or vanished project blocks the task with a plain reason", async () => {
    const { repo, store } = await setup();
    let task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    rmSync(repo, {
      recursive: true,
      force: true,
    });
    await expect(prepareWorktree(store, task)).rejects.toThrow("offline");
    const blocked = await runTaskPipeline("t1", {
      store,
      now: () => T0,
    });
    expect(blocked.state).toBe("blocked");
  }, 120_000);
});

describe("dispatch capacity", () => {
  test("a running task whose pipeline is active counts once", () => {
    const tasks = [
      {
        ...newTask(
          {
            id: "t1",
            projectId: "p",
            title: "x",
            prompt: "x",
          },
          "2026-01-01T00:00:00Z",
        ),
        state: "running" as const,
      },
      newTask(
        {
          id: "t2",
          projectId: "p",
          title: "y",
          prompt: "y",
        },
        "2026-01-01T00:00:01Z",
      ),
    ];
    expect(
      runningCount(
        tasks,
        new Set([
          "t1",
        ]),
      ),
    ).toBe(1);
    expect(
      runningCount(
        tasks,
        new Set([
          "t1",
          "t2",
        ]),
      ),
    ).toBe(2);
    expect(runningCount(tasks, new Set())).toBe(1);
  }, 120_000);

  test("free RAM reads MemAvailable, not just unused pages", () => {
    const meminfo =
      "MemTotal:       32545356 kB\nMemFree:         2549000 kB\nMemAvailable:   21144000 kB\n";
    expect(availableMbFromMeminfo(meminfo)).toBe(20648);
    expect(availableMbFromMeminfo("MemTotal: 1 kB\n")).toBeNull();
  }, 120_000);
});

describe("warm worktree pool (size = maxParallelTasks)", () => {
  test("slots are created once, leased, reset on release, and reused warm", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    await Bun.write(join(repo, ".gitignore"), "warm-cache/\n");
    git("add .gitignore");
    git("commit -qm ignore-cache");
    const head = git("rev-parse HEAD").trim();

    const slots = ensureWarmWorktrees(repo, "p1", 2, head);
    const [slot0 = "", slot1 = ""] = slots;
    expect(slots).toEqual([
      join(base, ".enjoy-worktrees", "p1", "slot-0"),
      join(base, ".enjoy-worktrees", "p1", "slot-1"),
    ]);
    expect(ensureWarmWorktrees(repo, "p1", 2, head)).toEqual(slots); // warm: no recreation

    const first = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 2,
      },
    );
    expect(first.worktree).toBe(slot0);
    await Bun.write(join(first.worktree, "a.txt"), "dirty\n");
    await Bun.write(join(first.worktree, "junk.txt"), "junk\n");
    mkdirSync(join(first.worktree, "warm-cache"), {
      recursive: true,
    });
    await Bun.write(join(first.worktree, "warm-cache", "keep.txt"), "warm\n");
    releaseWorktree(first);
    expect(await Bun.file(join(slot0, "a.txt")).text()).toBe("one\n"); // tracked reset
    expect(existsSync(join(slot0, "junk.txt"))).toBe(false); // untracked dropped
    expect(existsSync(join(slot0, "warm-cache", "keep.txt"))).toBe(true); // ignored cache stays warm
    expect(taskDiff(first)).toContain("dirty"); // diff snapshot survives the release

    const second = await prepareWorktree(
      store,
      newTask(
        {
          id: "t2",
          projectId: "p1",
          title: "t2",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 2,
      },
    );
    expect(second.worktree).toBe(slot0); // same warm slot reused
    const third = await prepareWorktree(
      store,
      newTask(
        {
          id: "t3",
          projectId: "p1",
          title: "t3",
          prompt: "x",
        },
        T0,
      ),
      {
        maxParallelTasks: 2,
      },
    );
    expect(third.worktree).toBe(slot1);
    await expect(
      prepareWorktree(
        store,
        newTask(
          {
            id: "t4",
            projectId: "p1",
            title: "t4",
            prompt: "x",
          },
          T0,
        ),
        {
          maxParallelTasks: 2,
        },
      ),
    ).rejects.toThrow(WorktreePoolFullError);
    releaseWorktree(second);
    releaseWorktree(third);

    // A task returning to the pool prefers its previous slot, so its
    // stored agent sessions resume in the workspace they were made in.
    const returning = await prepareWorktree(
      store,
      {
        ...newTask(
          {
            id: "t5",
            projectId: "p1",
            title: "t5",
            prompt: "x",
          },
          T0,
        ),
        worktree: slot1,
      },
      {
        maxParallelTasks: 2,
      },
    );
    expect(returning.worktree).toBe(slot1);
    releaseWorktree(returning);
  }, 120_000);
});

describe("decisions baseline (phase 1: hash first, additions-only free, judge last)", () => {
  test("hash changes only when a decisions file changes; additions-only detection", async () => {
    const { repo } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const empty = decisionsHashAt(repo, git("rev-parse HEAD").trim());
    expect(empty).not.toBe(""); // no decisions files yet: hash of nothing
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    expect(decisionsHashAt(repo, git("rev-parse HEAD").trim())).toBe(empty); // unrelated change: same hash
    await Bun.write(join(repo, "decisions.md"), "# Decisions\n- rule one\n");
    git("add decisions.md");
    git("commit -qm decisions");
    const withDecisions = decisionsHashAt(repo, git("rev-parse HEAD").trim());
    expect(withDecisions).not.toBe(empty);

    expect(isAdditionsOnlyDiff("+++ b/decisions.md\n@@ -0,0 +1 @@\n+- rule one\n")).toBe(true);
    expect(isAdditionsOnlyDiff("+- rule one\n+- rule two\n")).toBe(true);
    expect(isAdditionsOnlyDiff("-- rule one\n+- rule two\n")).toBe(false);
    expect(isAdditionsOnlyDiff("")).toBe(true);
  }, 120_000);

  test("tightening-only: additions that weaken a decision still need the judge", () => {
    expect(isTighteningOnlyDiff("+++ b/decisions.md\n+- never skip tests\n")).toBe(true);
    expect(
      isTighteningOnlyDiff(
        "+++ b/decisions.md\n+- never skip tests\n+- exception: fast lane may skip tests\n",
      ),
    ).toBe(false);
    expect(
      isTighteningOnlyDiff(
        "+++ b/decisions.md\n+- always run lint\n+- tasks may skip lint only when the owner approves\n",
      ),
    ).toBe(false);
    expect(isTighteningOnlyDiff("-- old rule\n+- new rule\n")).toBe(false); // removal is never additions-only
    expect(isTighteningOnlyDiff("")).toBe(true);
  });

  test("decisions files: singular/log variants count, vendored/generated paths do not", () => {
    expect(isDecisionsFile("decisions.md")).toBe(true);
    expect(isDecisionsFile("DECISIONS.md")).toBe(true);
    expect(isDecisionsFile("decision.md")).toBe(true);
    expect(isDecisionsFile("docs/DECISION_LOG.md")).toBe(true);
    expect(isDecisionsFile("sub/decisions-ops.md")).toBe(true);
    expect(isDecisionsFile("node_modules/x/decisions.md")).toBe(false);
    expect(isDecisionsFile("data/decisions.md")).toBe(false);
    expect(isDecisionsFile(".enjoy-worktrees/slot-1/decisions.md")).toBe(false);
    expect(isDecisionsFile("notes.md")).toBe(false);
    expect(isDecisionsFile("my-decisions.md")).toBe(false);
  });

  test("normalizeDecisionLine folds case, punctuation and bullet prefixes for duplicate detection", () => {
    expect(normalizeDecisionLine("- Rule One!")).toBe(normalizeDecisionLine("- rule one"));
    expect(normalizeDecisionLine("* never skip tests ")).toBe(
      normalizeDecisionLine("NEVER skip tests"),
    );
    expect(normalizeDecisionLine("# Decisions")).toBe("decisions");
  });

  test("prepareWorktree pins the baseline from the task's base commit", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    await Bun.write(join(repo, "decisions.md"), "# Decisions\n- rule one\n");
    git("add decisions.md");
    git("commit -qm decisions");
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    expect(task.decisionsBaselineHash).toBe(decisionsHashAt(repo, task.baseCommit));
    expect(task.decisionsBaselineHash).not.toBe("");
  }, 120_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("stale-plan gate (plan pinned to its drafting commit)", () => {
  test("main moved since drafting: builder is stopped and the task parks for a re-plan", async () => {
    const { repo, store, stub } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const base = git("rev-parse HEAD").trim();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0, [], base), T0);
    await store.writeTask(task);
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");

    expect(await stalePlanRefusal(store, task)).toContain("stale plan");
    const parked = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(parked.state).toBe("needs-input");
    const history = await store.listPrompts("t1");
    expect(history.some((p) => p.text.startsWith("stale plan:"))).toBe(true);
    // The builder never ran on the stale plan.
    expect((await store.listCards("t1")).map((c) => c.id)).not.toContain("builder");
  }, 120_000);

  test("agent stale check: STILL_HOLDS re-pins and proceeds; NEEDS_REPLAN parks with its questions", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const baseCommit = git("rev-parse HEAD").trim();
    const holdsStub = join(base, "holds-stub.ts");
    await Bun.write(
      holdsStub,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "s1" }, payload_type: "run.terminal.completed", payload: { text: "STILL_HOLDS\\nchecked: named files unchanged" } }));`,
    );
    const replanStub = join(base, "replan-stub.ts");
    await Bun.write(
      replanStub,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "s2" }, payload_type: "run.terminal.completed", payload: { text: "NEEDS_REPLAN\\n- Should the route stay public after the rename?" } }));`,
    );
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      worktree: repo,
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0, [], baseCommit), T0);
    await store.writeTask(task);
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    const head = git("rev-parse HEAD").trim();

    const holds = await resolveStalePlan(store, task, {
      store,
      command: [
        "bun",
        holdsStub,
      ],
    });
    expect(holds.proceed).toBe(true);
    expect((await store.readTask("t1"))?.planBaseCommit).toBe(head); // re-pinned, builder continues

    await store.writeTask({
      ...(await store.readTask("t1"))!,
      planBaseCommit: baseCommit,
    });
    const replan = await resolveStalePlan(store, (await store.readTask("t1"))!, {
      store,
      command: [
        "bun",
        replanStub,
      ],
    });
    expect(replan.proceed).toBe(false);
    expect(replan.note).toContain("Should the route stay public");
  });

  test("proceed anyway re-pins and lets the builder run; legacy unpinned plans are pinned, not parked", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const base = git("rev-parse HEAD").trim();
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0, [], base), T0);
    await store.writeTask(task);
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "proceed anyway",
    });
    expect(await stalePlanRefusal(store, task)).toBeNull();
    expect((await store.readTask("t1"))?.planBaseCommit).not.toBe(base);

    const legacy = approvePlan(
      draftPlan(
        {
          ...newTask(
            {
              id: "t2",
              projectId: "p1",
              title: "t2",
              prompt: "x",
            },
            T0,
          ),
        },
        "plan",
        T0,
      ),
      T0,
    );
    expect(legacy.planBaseCommit).toBe("");
    await store.writeTask(legacy);
    expect(await stalePlanRefusal(store, legacy)).toBeNull();
    expect((await store.readTask("t2"))?.planBaseCommit).toBe(git("rev-parse HEAD").trim());
  }, 120_000);
});

describe("input-token cuts (execution brief + plan delta)", () => {
  const plan = [
    "# Plan: big",
    "## 1. Intent",
    "Do the thing because it matters and the user asked for it explicitly.",
    "## 2. Approach",
    "Step one: change the file. Step two: run the checks. Step three: report the result to the owner.",
    "## 3. Success criteria",
    "The checks pass and the diff shows only the intended change, verified end to end.",
    "## Red-team decisions",
    "- CHANGED point one with a long rationale that execution stations never need to see again",
    "## Questions for the owner",
    "- None",
  ].join("\n");
  test("executionBrief keeps intent/approach/success and drops red-team logs", () => {
    const brief = executionBrief(plan);
    expect(brief).toContain("Do the thing");
    expect(brief).toContain("checks pass");
    expect(brief).not.toContain("CHANGED point one");
    expect(brief).not.toContain("Questions for the owner");
  });
  test("executionBrief caps oversized plans", () => {
    const huge = `## Approach\n${"x".repeat(20000)}`;
    expect(executionBrief(huge).length).toBeLessThan(6200);
  });
  test("changedPlanSections returns only sections that differ", () => {
    const before = "## Intent\nsame intent text here\n## Approach\nold approach text";
    const after = "## Intent\nsame intent text here\n## Approach\nnew approach text";
    const delta = changedPlanSections(before, after);
    expect(delta).toContain("new approach text");
    expect(delta).not.toContain("same intent text");
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("quota handling (token limit is not a failure)", () => {
  test("quota builder failure parks as quota-wait, pauses dispatch globally, and resumes after the pause", async () => {
    const { base, store } = await setup();
    const quotaStub = join(base, "quota-stub.ts");
    await Bun.write(
      quotaStub,
      [
        `console.error("Error: usage limit reached — limit resets later");`,
        `process.exit(1);`,
      ].join("\n"),
    );
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0, [], ""), T0);
    await store.writeTask(task);

    const parked = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        quotaStub,
      ],
      now: () => T0,
    });
    expect(parked.state).toBe("needs-input");
    const history = await store.listPrompts("t1");
    expect(history.some((p) => p.text.startsWith("quota:"))).toBe(true);
    // The station recorded a global pause in the future.
    const until = await store.quotaPausedUntil();
    expect(Date.parse(until)).toBeGreaterThan(Date.now());

    // While paused, a dispatch tick launches nothing — not even the resume.
    const active = new Set<string>();
    expect(
      await dispatchTick({
        store,
        command: [
          "bun",
          quotaStub,
        ],
        maxParallelTasks: 2,
        ramFloorMb: 0,
        active,
        now: () => T0,
      }),
    ).toEqual([]);

    // After the pause passes, the quota park auto-resumes (and the stub
    // fails quota again, re-parking — the loop is bounded by the pause).
    await store.noteQuotaPause(new Date(Date.now() - 1000).toISOString());
    const launched = await dispatchTick({
      store,
      command: [
        "bun",
        quotaStub,
      ],
      maxParallelTasks: 2,
      ramFloorMb: 0,
      active,
      now: () => new Date().toISOString(),
    });
    expect(launched).toContain("t1");
    for (let i = 0; i < 50 && (await store.readTask("t1"))?.state !== "needs-input"; i++)
      await Bun.sleep(100);
    expect((await store.readTask("t1"))?.state).toBe("needs-input");
  });

  test("a quota pause does not consume the implementation-attempt budget", async () => {
    const { base, store } = await setup();
    const quotaStub = join(base, "quota-stub.ts");
    await Bun.write(
      quotaStub,
      [
        `console.error("Error: usage limit reached — limit resets later");`,
        `process.exit(1);`,
      ].join("\n"),
    );
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      attempts: 3,
    };
    task = approvePlan(draftPlan(task, "1. add route 2. test", T0, [], ""), T0);
    await store.writeTask(task);
    await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        quotaStub,
      ],
      now: () => T0,
    });
    // The round loop incremented attempts before the builder ran, then the
    // quota branch put it back: the stored attempt count is unchanged.
    expect((await store.readTask("t1"))?.attempts).toBe(3);
  });

  test("quota probe: one task probes every interval before the recorded reset, never a flood", async () => {
    const { base, store } = await setup();
    const quotaStub = join(base, "quota-stub.ts");
    await Bun.write(
      quotaStub,
      [
        `console.error("Error: usage limit reached — limit resets later");`,
        `process.exit(1);`,
      ].join("\n"),
    );
    for (const id of [
      "t1",
      "t2",
    ]) {
      let task = {
        ...newTask(
          {
            id,
            projectId: "p1",
            title: id,
            prompt: "add hello service",
          },
          T0,
        ),
      };
      task = {
        ...approvePlan(draftPlan(task, "1. add route 2. test", T0, [], ""), T0),
        state: "needs-input" as const,
      };
      await store.writeTask(task);
      await store.appendPrompt(id, {
        at: T0,
        kind: "system",
        text: "quota: builder paused — usage limit reached — resumes automatically",
      });
    }
    // Reset is far in the future, but a probe is due now.
    await Bun.write(
      join(store.dir, "quota-pause.json"),
      JSON.stringify({
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        nextProbeAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const active = new Set<string>();
    const probed = await dispatchTick({
      store,
      command: [
        "bun",
        quotaStub,
      ],
      maxParallelTasks: 2,
      ramFloorMb: 0,
      active,
      now: () => new Date().toISOString(),
    });
    expect(probed.length).toBe(1);
    // The probe claimed the next slot: an immediate second tick launches nothing.
    expect(
      await dispatchTick({
        store,
        command: [
          "bun",
          quotaStub,
        ],
        maxParallelTasks: 2,
        ramFloorMb: 0,
        active,
        now: () => new Date().toISOString(),
      }),
    ).toEqual([]);
    // The probe hits quota again and re-parks; the pause stands.
    for (let i = 0; i < 50 && (await store.readTask(probed[0] ?? ""))?.state !== "needs-input"; i++)
      await Bun.sleep(100);
    expect(Date.parse(await store.quotaPausedUntil())).toBeGreaterThan(Date.now());
  });
});

test("legacy quota park (raw 429 note, pre-classification) auto-resumes after its named reset, never before", async () => {
  const { base, store, stub } = await setup();
  let task = newTask(
    {
      id: "t1",
      projectId: "p1",
      title: "t1",
      prompt: "add hello service",
    },
    T0,
  );
  task = {
    ...approvePlan(draftPlan(task, "1. add route 2. test", T0, [], ""), T0),
    state: "needs-input" as const,
  };
  await store.writeTask(task);
  await store.appendPrompt("t1", {
    at: T0,
    kind: "system",
    text: "builder station did not complete: run ended with Failed: API error 429 [request_id=x]: Subscription quota exhausted. Your usage window resets at 2999-01-01T00:00:00Z. (rate_limit_error) — reply to resume this task",
  });
  const active = new Set<string>();
  // Reset is in the future: no resume.
  expect(
    await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 2,
      ramFloorMb: 0,
      active,
      now: () => new Date().toISOString(),
    }),
  ).not.toContain("t1");
  expect((await store.readTask("t1"))?.state).toBe("needs-input");
  // Rewrite the note with a past reset: the next tick resumes it.
  const history = await store.listPrompts("t1");
  expect(history.length).toBeGreaterThan(0);
  await store.appendPrompt("t1", {
    at: new Date().toISOString(),
    kind: "system",
    text: "builder station did not complete: run ended with Failed: API error 429 [request_id=y]: Subscription quota exhausted. Your usage window resets at 2000-01-01T00:00:00Z. (rate_limit_error) — reply to resume this task",
  });
  const launched = await dispatchTick({
    store,
    command: [
      "bun",
      stub,
    ],
    maxParallelTasks: 2,
    ramFloorMb: 0,
    active,
    now: () => new Date().toISOString(),
  });
  expect(launched).toContain("t1");
  void base;
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("pickup gate (main / DECISIONS.md moved since planning)", () => {
  test("assessPickup: unchanged = pickup, other files = rebase, decisions = ask-user", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const base = git("rev-parse HEAD").trim();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
      baseCommit: base,
    };
    await store.writeTask(task);
    expect(assessPickup(repo, task).action).toBe("pickup");

    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    const moved = assessPickup(repo, task);
    expect(moved.action).toBe("rebase");
    if (moved.action === "rebase") expect(moved.changedFiles).toContain("b.txt");

    await Bun.write(join(repo, "DECISIONS.md"), "# Decisions\n- use bun\n");
    git("add DECISIONS.md");
    git("commit -qm decisions");
    const decided = assessPickup(repo, task);
    expect(decided.action).toBe("ask-user");
    if (decided.action === "ask-user") expect(decided.reason).toContain("DECISIONS.md");
  }, 120_000);

  test("secret-like files are never auto-committed", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/.env.production",
      "id_rsa",
      "keys/id_ed25519.pub",
      "cert.pem",
      "tls/server.key",
      "app/credentials.json",
      "secrets.yaml",
      ".aws/credentials",
      "home/.ssh/config",
      "x.p12",
    ]) {
      expect(isSecretLikeFile(p)).toBe(true);
    }
    for (const p of [
      ".env.example",
      ".env.sample",
      "README.md",
      "src/env.ts",
      "keys/readme.md",
      "monkey.ts",
    ]) {
      expect(isSecretLikeFile(p)).toBe(false);
    }
  }, 120_000);

  test("pickup with uncommitted work: save-and-rebase by default, secrets park", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    // Main moves; the task has uncommitted work in its worktree.
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    await Bun.write(join(task.worktree, "a.txt"), "one\ntask work in progress\n");

    const assessed = assessPickup(repo, task);
    expect(assessed.action).toBe("save-and-rebase");

    const head = git("rev-parse HEAD").trim();
    const saved = saveAndRebaseWorktree(task, head);
    expect(saved.ok).toBe(true);
    // Work preserved on top of the new base, worktree clean afterwards.
    expect(await Bun.file(join(task.worktree, "a.txt")).text()).toContain("task work in progress");
    expect(await Bun.file(join(task.worktree, "b.txt")).text()).toContain("two");
    expect(
      execSync("git status --porcelain", {
        cwd: task.worktree,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(
      execSync("git log --oneline", {
        cwd: task.worktree,
        encoding: "utf8",
      }),
    ).toContain("save uncommitted work");

    // Secret-like dirty files are the exception: nothing is committed.
    await Bun.write(join(task.worktree, ".env"), "TOKEN=abc\n");
    await Bun.write(join(repo, "c.txt"), "three\n");
    git("add c.txt");
    git("commit -qm three");
    const refused = saveAndRebaseWorktree(task, git("rev-parse HEAD").trim());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain(".env");
    expect(
      execSync("git status --porcelain", {
        cwd: task.worktree,
        encoding: "utf8",
      }),
    ).toContain(".env");
    expect(
      execSync("git log --oneline -3", {
        cwd: task.worktree,
        encoding: "utf8",
      }),
    ).not.toContain("TOKEN");
  }, 120_000);

  test("pickup with committed (clean) task work ahead of base also saves-and-rebases", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    // Task work is COMMITTED in the worktree (e.g. by an earlier save):
    // a dirty check sees a clean tree, but a reset would drop the commit.
    await Bun.write(join(task.worktree, "a.txt"), "one\ncommitted task work\n");
    execSync(
      `git -c user.name=t -c user.email=t@t add a.txt && git -c user.name=t -c user.email=t@t commit -qm "task work"`,
      {
        cwd: task.worktree,
        encoding: "utf8",
      },
    );
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");

    const assessed = assessPickup(repo, task);
    expect(assessed.action).toBe("save-and-rebase");
    const saved = saveAndRebaseWorktree(task, git("rev-parse HEAD").trim());
    expect(saved.ok).toBe(true);
    expect(await Bun.file(join(task.worktree, "a.txt")).text()).toContain("committed task work");
    expect(await Bun.file(join(task.worktree, "b.txt")).text()).toContain("two");
  }, 120_000);

  test("rebase conflict at pickup is resolved by a fixer agent automatically", async () => {
    const { repo, store, stub } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    // Task work and main rewrite the same line: the pickup rebase conflicts.
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const head = git("rev-parse HEAD").trim();

    const saved = saveAndRebaseWorktree(task, head);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.kind).toBe("rebase");

    const resolved = await resolveRebaseWithAgent(task, head, {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(resolved.ok).toBe(true);
    // Saved work landed on the new base; worktree clean, base is an ancestor.
    expect(await Bun.file(join(task.worktree, "a.txt")).text()).toBe("task version\n");
    expect(
      execSync("git status --porcelain", {
        cwd: task.worktree,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(
      execSync(`git merge-base --is-ancestor ${head} HEAD`, {
        cwd: task.worktree,
        encoding: "utf8",
      }),
    ).toBe("");
  }, 120_000);

  test("failed save commit at pickup is classified 'commit' and a fixer agent saves+rebases", async () => {
    const { repo, store, stub } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    // Main moves; the task has uncommitted work; a stale index lock makes
    // the factory's own save commit fail (as happened to task-1792725083701).
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    const head = git("rev-parse HEAD").trim();
    await Bun.write(join(task.worktree, "a.txt"), "one\ntask work in progress\n");
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: task.worktree,
      encoding: "utf8",
    }).trim();
    const lockPath = gitDir.startsWith("/")
      ? join(gitDir, "index.lock")
      : join(task.worktree, gitDir, "index.lock");
    await Bun.write(lockPath, "");

    const saved = saveAndRebaseWorktree(task, head);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.kind).toBe("commit");

    // The stale lock stays in place: removing it is the fixer's job, the
    // same judgement a human would make about a lock with no live process.
    const resolved = await saveRebaseWithAgentFallback(
      task,
      head,
      {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      },
      () => T0,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.byAgent).toBe(true);
    expect(await Bun.file(join(task.worktree, "a.txt")).text()).toContain("task work in progress");
    expect(await Bun.file(join(task.worktree, "b.txt")).text()).toContain("two");
    expect(
      execSync("git status --porcelain", {
        cwd: task.worktree,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    expect(
      execSync("git log --oneline", {
        cwd: task.worktree,
        encoding: "utf8",
      }),
    ).toContain("save uncommitted work");
  }, 120_000);

  test("assessMergeability: unmoved = clean, moved clean = clean, same-line edit = conflict", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );
    expect(assessMergeability(repo, task).status).toBe("clean");

    // Task appends to a.txt; main adds an unrelated file: merge stays clean.
    await Bun.write(join(task.worktree, "a.txt"), "one\ntask line\n");
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two");
    const clean = assessMergeability(repo, task);
    expect(clean.status).toBe("clean");
    if (clean.status === "clean") expect(clean.decisions.taskChanged).toEqual([]);

    // Main rewrites the line the task also rewrote: content conflict.
    await Bun.write(join(task.worktree, "a.txt"), "task version\ntask line\n");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const conflict = assessMergeability(repo, task);
    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") expect(conflict.files).toContain("a.txt");
  }, 120_000);

  test("assessMergeability: clean decisions merge is still reported, with restated lines to compress", async () => {
    const { repo, store } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    await Bun.write(join(repo, "decisions.md"), "# Decisions\n- rule one\n- rule two\n");
    git("add decisions.md");
    git("commit -qm decisions-base");
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
    );

    // Task extends decisions at the end and restates rule one; main adds a
    // rule near the top. Git merges cleanly — the owner still gets shown.
    await Bun.write(
      join(task.worktree, "decisions.md"),
      "# Decisions\n- rule one\n- rule two\n- rule three\n- rule one\n",
    );
    await Bun.write(
      join(repo, "decisions.md"),
      "# Decisions\n- rule zero\n- rule one\n- rule two\n",
    );
    git("add decisions.md");
    git("commit -qm decisions-main");

    const merged = assessMergeability(repo, task);
    expect(merged.status).toBe("clean");
    if (merged.status !== "clean") return;
    expect(merged.decisions.mainChanged).toContain("decisions.md");
    expect(merged.decisions.taskChanged).toContain("decisions.md");
    expect(merged.decisions.diff).toContain("rule three");
    expect(merged.decisions.duplicates).toContain("- rule one");
  }, 120_000);

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
  test("decisions change: impact judge proceeds on tightening, owner asked on contradiction", async () => {
    const { repo, store, stub } = await setup();
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: repo,
        encoding: "utf8",
      });
    const base = git("rev-parse HEAD").trim();

    let paused = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    paused = {
      ...paused,
      baseCommit: base,
    };
    await store.writeTask(paused);
    await Bun.write(join(repo, "DECISIONS.md"), "# Decisions\n- use bun\n");
    git("add DECISIONS.md");
    git("commit -qm decisions");
    // A brand-new decisions file is additions-only: proceeds with no agent.
    const proceeded = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(proceeded.state).toBe("done");
    const proceededPrompts = await store.listPrompts("t1");
    expect(proceededPrompts.some((p) => p.text.includes("only adds/tightens decisions"))).toBe(
      true,
    );
    expect(proceededPrompts.some((p) => p.text.includes("decisions-judge:"))).toBe(false);

    // A modified decision line (a removal) does reach the impact judge,
    // which proceeds when nothing contradicts the plan.
    let judged = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t4",
            projectId: "p1",
            title: "t4",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    judged = {
      ...judged,
      baseCommit: git("rev-parse HEAD").trim(),
    };
    await store.writeTask(judged);
    await Bun.write(join(repo, "DECISIONS.md"), "# Decisions\n- use bun for everything\n");
    git("add DECISIONS.md");
    git("commit -qm tighten");
    const judgedDone = await runTaskPipeline("t4", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(judgedDone.state).toBe("done");
    const judgedPrompts = await store.listPrompts("t4");
    expect(judgedPrompts.some((p) => p.text.includes("decisions-judge:"))).toBe(true);
    expect(
      judgedPrompts.some((p) => p.text.includes("impact judge: tightening/extending only")),
    ).toBe(true);

    // A decisions change the judge flags as contradicting the plan asks the owner.
    let contested = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t3",
            projectId: "p1",
            title: "t3",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    contested = {
      ...contested,
      baseCommit: git("rev-parse HEAD").trim(),
    };
    await store.writeTask(contested);
    await Bun.write(
      join(repo, "DECISIONS.md"),
      "# Decisions\n- use bun\n- contradicts-the-plan: never add services\n",
    );
    git("add DECISIONS.md");
    git("commit -qm contested");
    const pausedDone = await runTaskPipeline("t3", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(pausedDone.state).toBe("needs-input");
    const pausedPrompts = await store.listPrompts("t3");
    expect(
      pausedPrompts.some(
        (p) => p.text.includes("pickup paused") && p.text.includes("DECISIONS.md"),
      ),
    ).toBe(true);
    expect(pausedPrompts.some((p) => p.text.includes("What changed in the decisions"))).toBe(true);

    let movedTask = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t2",
            projectId: "p1",
            title: "t2",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    movedTask = {
      ...movedTask,
      baseCommit: git("rev-parse HEAD").trim(),
    }; // planned at the decisions commit
    await store.writeTask(movedTask);
    await Bun.write(join(repo, "b.txt"), "two\n");
    git("add b.txt");
    git("commit -qm two"); // main moves again, without touching decisions
    const movedDone = await runTaskPipeline("t2", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(movedDone.state).toBe("done");
    expect(movedDone.baseCommit).toBe(git("rev-parse HEAD").trim());
    const movedPrompts = await store.listPrompts("t2");
    expect(movedPrompts.some((p) => p.text.includes("picked up on new base"))).toBe(true);
  }, 60_000); // four full pipelines in one test: needs more than the 5s default under load
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("queue at the parallel-task cap", () => {
  test("over-cap tasks stay queued; planning launches first when a slot frees", async () => {
    const { store, stub } = await setup();
    const running = {
      ...approvePlan(
        draftPlan(
          newTask(
            {
              id: "trun",
              projectId: "p1",
              title: "trun",
              prompt: "x",
            },
            T0,
          ),
          "plan",
          T0,
        ),
        T0,
      ),
      state: "running" as const,
    };
    const queued = approvePlan(
      draftPlan(
        newTask(
          {
            id: "tq",
            projectId: "p1",
            title: "tq",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(running);
    await store.writeTask(queued);
    const active = new Set<string>();
    const atCap = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active,
      now: () => T0,
    });
    expect(atCap).toEqual([]); // at cap: nothing launched, nothing dropped
    expect((await store.readTask("tq"))?.state).toBe("planned"); // still queued

    // The running task finishes; the next tick picks the queued one up.
    await store.writeTask({
      ...running,
      state: "done",
    });
    const pickedUp = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active,
      now: () => T0,
    });
    expect(pickedUp).toEqual([
      "tq",
    ]);
    for (let i = 0; i < 50 && (await store.readTask("tq"))?.state !== "done"; i++)
      await Bun.sleep(100);
    expect((await store.readTask("tq"))?.state).toBe("done");
    for (let i = 0; i < 50 && active.size > 0; i++) await Bun.sleep(100); // slot fully freed

    // Planning outranks implementation for a free slot.
    const planTask = {
      ...newTask(
        {
          id: "tp",
          projectId: "p1",
          title: "tp",
          prompt: "plan me",
        },
        T0,
      ),
      planRequested: true,
    };
    const implTask = approvePlan(
      draftPlan(
        newTask(
          {
            id: "ti",
            projectId: "p1",
            title: "ti",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(planTask);
    await store.writeTask(implTask);
    const planLaunches: string[] = [];
    const withPlan = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active,
      now: () => T0,
      launchPlan: async (id) => {
        planLaunches.push(id);
      },
    });
    expect(withPlan).toEqual([
      "tp",
    ]);
    expect(planLaunches).toEqual([
      "tp",
    ]);
    expect((await store.readTask("ti"))?.state).toBe("planned"); // implementation waits its turn
  }, 60_000);

  test("interrupted work resumes itself without owner input", async () => {
    // (two stub pipelines run to completion below; needs more than the default 5s under load)
    const { store, stub } = await setup();
    const orphan = {
      ...approvePlan(
        draftPlan(
          newTask(
            {
              id: "torph",
              projectId: "p1",
              title: "torph",
              prompt: "add hello service",
            },
            T0,
          ),
          "plan",
          T0,
        ),
        T0,
      ),
      state: "running" as const,
    };
    await store.writeTask(orphan);
    const later = "2026-10-22T10:11:00.000Z"; // 11 min after the task was last touched
    const launched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(launched).toContain("torph");
    // The resumed pipeline runs to done on its own (stub agents).
    for (let i = 0; i < 100 && (await store.readTask("torph"))?.state !== "done"; i++)
      await Bun.sleep(200);
    expect((await store.readTask("torph"))?.state).toBe("done");
    const prompts = await store.listPrompts("torph");
    expect(prompts.some((p) => p.text.includes("resuming automatically"))).toBe(true);

    // A task already parked by the old park-on-interrupt behaviour, its
    // interruption note still unanswered, resumes the same way.
    const parked = {
      ...orphan,
      id: "tparked",
      jobId: "tparked",
      state: "needs-input" as const,
    };
    await store.writeTask(parked);
    await store.appendPrompt("tparked", {
      at: T0,
      kind: "system",
      text: "pipeline interrupted (dashboard restarted?) — task parked in needs-input; reply to resume the worker",
    });
    const relaunched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(relaunched).toContain("tparked");
    for (let i = 0; i < 100 && (await store.readTask("tparked"))?.state !== "done"; i++)
      await Bun.sleep(200);
    expect((await store.readTask("tparked"))?.state).toBe("done");

    // A task parked by the old park-on-builder-timeout behaviour also
    // resumes itself: a timeout is a system event, not a question.
    const timedOut = {
      ...orphan,
      id: "ttimeout",
      jobId: "ttimeout",
      state: "needs-input" as const,
    };
    await store.writeTask(timedOut);
    await store.appendPrompt("ttimeout", {
      at: T0,
      kind: "system",
      text: "builder station did not complete: builder timed out with no progress (intermediate state evaluated: 0 file change(s) in the last run) — likely looped or stale; reply to resume — reply to resume this task",
    });
    const timeoutLaunched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(timeoutLaunched).toContain("ttimeout");
    for (let i = 0; i < 100 && (await store.readTask("ttimeout"))?.state !== "done"; i++)
      await Bun.sleep(200);
    expect((await store.readTask("ttimeout"))?.state).toBe("done");

    // A fresh running task (within grace) is never reclaimed.
    const fresh = {
      ...orphan,
      id: "tfresh",
      jobId: "tfresh",
      updatedAt: later,
    };
    await store.writeTask(fresh);
    await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect((await store.readTask("tfresh"))?.state).toBe("running");
  }, 60_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("triage: effort/lane evaluation before planning", () => {
  test("parseTriage reads the small meaningful title triage wrote", () => {
    const v = parseTriage(
      'TRIAGE lane=standard size=S redteams=2 risks=none est=4 title="Status page at /status"\nreason',
    );
    expect(v.title).toBe("Status page at /status");
    expect(parseTriage("TRIAGE lane=standard size=S redteams=2").title).toBe("");
  });

  test("parseTriage defaults up on ambiguity and on fast-for-large", () => {
    expect(
      parseTriage("TRIAGE lane=fast size=XS risks=none est=~3 stations\none class swap").lane,
    ).toBe("fast");
    expect(
      parseTriage("TRIAGE lane=careful size=L risks=auth est=~9 stations\ntouches auth").lane,
    ).toBe("careful");
    expect(parseTriage("TRIAGE lane=fast size=L risks=none\nbig really").lane).toBe("standard");
    expect(parseTriage("I think it is small").lane).toBe("standard");
    expect(parseTriage("").lane).toBe("standard");
  }, 120_000);

  test("the triage agent decides how many red-teams a task gets, bounded by its lane", () => {
    expect(
      parseTriage(
        "TRIAGE lane=standard size=S redteams=1 risks=none\nsmall and behaviour-preserving",
      ).redteams,
    ).toBe(1);
    expect(
      parseTriage("TRIAGE lane=standard size=M redteams=2 risks=none\nbehaviour changes").redteams,
    ).toBe(2);
    expect(parseTriage("TRIAGE lane=standard size=S risks=none\nno depth stated").redteams).toBe(2); // doubt means 2
    expect(
      parseTriage("TRIAGE lane=fast size=XS redteams=2 risks=none\ncontradictory").redteams,
    ).toBe(0); // fast never gets red-teams
    expect(
      parseTriage("TRIAGE lane=careful size=L redteams=1 risks=auth\nwants fewer").redteams,
    ).toBe(2); // careful always gets both
  }, 120_000);

  test("a one-red-team task is planned with only the SME reviewer", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-triage1.ts");
    await Bun.write(
      stub2,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built the feature";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=standard size=S redteams=1 risks=none est=~4 stations\\nsmall and behaviour-preserving";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nSmall change.\\n## Approach\\nSwap one class.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "PASS sme fine\\nArgument: narrow";`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider fine\\nArgument: why-now holds";`,
        `else if (prompt.includes("decide on each red-team point") || prompt.includes("Apply the comments below")) text = "## Open questions for the owner\\n(none)\\n\\nfinal plan - intended final text with the requested behaviour change";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-t1r" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "make the button slightly smaller",
      },
      T0,
    );
    await store.writeTask(task);
    const planned = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(planned.lane).toBe("standard");
    expect(planned.redteams).toBe(1);
    expect(planned.planState).toBe("draft"); // standard lane still waits for the owner
    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id)).toContain("redteam-sme");
    expect(cards.map((c) => c.id)).not.toContain("redteam-outsider"); // agent decided: one is enough
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("one red-team reviewer")),
    ).toBe(true);
  }, 60_000);

  test("a fast-lane task skips red-teams, auto-approves, and gets a single review", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-triage.ts");
    await Bun.write(
      stub2,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built the feature";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=fast size=XS risks=none est=~3 stations\\none small surface, reversible";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nSmall change.\\n## Approach\\nSwap one class.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nArgument: fine";`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: fine";`,
        `else if (prompt.includes("Write the retrospective")) text = "RETRO_DONE\\nclean\\nFINDING: none";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-tr" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "make the button smaller",
      },
      T0,
    );
    await store.writeTask(task);
    const planned = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(planned.lane).toBe("fast");
    expect(planned.planState).toBe("approved"); // auto-approved, no owner wait
    expect(planned.planQuestions).toEqual([]);
    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id)).not.toContain("redteam-sme"); // red-teams skipped
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const cards2 = await store.listCards("t1");
    expect(cards2.map((c) => c.id)).not.toContain("sme"); // single (coder) review only
    expect((await store.listPrompts("t1")).some((p) => p.text.includes("triage: fast lane"))).toBe(
      true,
    );
  }, 60_000);

  test("a fast-lane diff touching an expensive path escalates to standard dual review", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-triage2.ts");
    await Bun.write(
      stub2,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built the feature";`,
        `if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nArgument: fine";`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: fine";`,
        `else if (prompt.includes("touches expensive path(s)")) text = "## Tradeoffs\\nOption 1 (taken): edit the existing server in place. Option 2 (alternative): a separate service. The taken option wins on cost.";`,
        `else { mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, "src", "server.ts"), "touch\\n"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-tr2" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    let task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "tweak the server thing",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    task = {
      ...task,
      lane: "fast",
      triage: "TRIAGE lane=fast size=XS risks=none (owner-set in test)",
    };
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    expect(done.lane).toBe("standard"); // escalated at review
    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id)).toContain("sme"); // dual review happened
    expect((await store.listPrompts("t1")).some((p) => p.text.includes("triage escalation"))).toBe(
      true,
    );
  }, 60_000);
});

describe("auto-approve (Settings: plans move forward without a click)", () => {
  test("a drafted plan with no open questions auto-approves and dispatches; questions still park", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-autoapprove.ts");
    await Bun.write(
      stub2,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built the feature";`,
        `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nSmall change.\\n## Approach\\nDo it.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan")) text = "PASS fine\\nArgument: narrow";`,
        `else if (prompt.includes("decide on each red-team point") || prompt.includes("Apply the comments below")) text = "## Open questions for the owner\\n(none)\\n\\nfinal plan - intended final text with the requested behaviour change";`,
        `else if (prompt.includes("Review as")) text = "PASS ok\\nArgument: fine";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-aa" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    await store.writeTask(task);
    // Without the setting, the plan waits as a draft (existing behaviour).
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(drafted.planState).toBe("draft");
    // The dispatcher auto-approves it on its next tick and launches it.
    const active = new Set<string>();
    await dispatchTick({
      store,
      command: [
        "bun",
        stub2,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active,
      now: () => T0,
      autoApprove: true,
    });
    for (let i = 0; i < 100 && (await store.readTask("t1"))?.state !== "done"; i++)
      await Bun.sleep(200);
    expect((await store.readTask("t1"))?.state).toBe("done");
    expect((await store.listPrompts("t1")).some((p) => p.text.includes("plan auto-approved"))).toBe(
      true,
    );
  }, 60_000);
});

describe("RAM capacity advice (dynamic, owner-approved)", () => {
  const rich = Array(60).fill(21000);
  test("suggests raising only when saturated, queued, and RAM-funded", () => {
    const advice = ramAdvice(rich, 10, {
      running: 10,
      queued: 3,
      planning: 1,
    });
    expect(advice?.action).toBe("raise");
    expect(advice?.suggested).toBe(13);
    expect(advice?.reason).toContain("21000 MB");
    // Not saturated or nothing waiting: no advice.
    expect(
      ramAdvice(rich, 10, {
        running: 4,
        queued: 3,
        planning: 0,
      }),
    ).toBeNull();
    expect(
      ramAdvice(rich, 10, {
        running: 10,
        queued: 0,
        planning: 0,
      }),
    ).toBeNull();
  }, 120_000);
  test("suggests lowering when RAM stays scarce; silent otherwise", () => {
    const poor = Array(60).fill(1500);
    const advice = ramAdvice(poor, 10, {
      running: 10,
      queued: 2,
      planning: 0,
    });
    expect(advice?.action).toBe("lower");
    expect(advice?.suggested).toBe(7);
    expect(
      ramAdvice(Array(60).fill(5000), 10, {
        running: 10,
        queued: 2,
        planning: 0,
      }),
    ).toBeNull();
    // Too few samples to judge yet.
    expect(
      ramAdvice(
        [
          21000,
          21000,
        ],
        10,
        {
          running: 10,
          queued: 2,
          planning: 0,
        },
      ),
    ).toBeNull();
  }, 120_000);
});

describe("web push (PWA owner notifications)", () => {
  test("payload encryption round-trips and the VAPID JWT verifies", async () => {
    const { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, verify } = await import(
      "node:crypto"
    );
    const ua = createECDH("prime256v1");
    const uaPublic = ua.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const plain = JSON.stringify({
      title: "t",
      body: "b",
      taskId: "task-1",
    });
    const wire = encryptPushPayload(
      plain,
      uaPublic.toString("base64url"),
      auth.toString("base64url"),
    );
    const salt = wire.subarray(0, 16);
    const asPublic = wire.subarray(21, 21 + wire[20]!);
    const ct = wire.subarray(21 + wire[20]!);
    const secret = ua.computeSecret(asPublic);
    const ikmInfo = Buffer.concat([
      Buffer.from("WebPush: info\0"),
      uaPublic,
      asPublic,
    ]);
    const prk = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.from("auth\0"), 32));
    const ikm = Buffer.from(hkdfSync("sha256", prk, Buffer.alloc(0), ikmInfo, 32));
    const cek = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
    );
    const nonce = Buffer.from(
      hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
    );
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const out = Buffer.concat([
      decipher.update(ct.subarray(0, ct.length - 16)),
      decipher.final(),
    ]);
    expect(out.subarray(0, out.length - 1).toString()).toBe(plain);

    const pair = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const pubJwk = pair.publicKey.export({
      format: "jwk",
    });
    const stored = {
      publicKey: Buffer.concat([
        Buffer.from([
          4,
        ]),
        Buffer.from(pubJwk.x ?? "", "base64url"),
        Buffer.from(pubJwk.y ?? "", "base64url"),
      ]).toString("base64url"),
      privateKey: Buffer.from(
        JSON.stringify(
          pair.privateKey.export({
            format: "jwk",
          }),
        ),
      ).toString("base64url"),
      subject: "mailto:o@e.c",
    };
    const jwt = vapidJwt("https://push.example.com", stored.subject, stored, 1700000000);
    const [h, p, s] = jwt.split(".");
    expect(
      verify(
        "SHA256",
        Buffer.from(`${h}.${p}`),
        {
          key: pair.publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(s ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(p ?? "", "base64url").toString()).aud).toBe(
      "https://push.example.com",
    );
  }, 120_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("retrospective", () => {
  test("retro reviews the whole run and stores findings the owner can task", async () => {
    const { store, stub } = await setup();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
      attempts: 2,
      verifyCommand: "bun test",
    };
    await store.writeTask(task);
    await store.appendPrompt("t1", {
      at: T0,
      kind: "system",
      text: "verification failed (the file selector allows navigation): command not found",
    });
    const retro = await runRetro("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(retro.findings).toEqual([
      "extract the repeated curl checks into a reusable health script",
      "add a regression test for the verify reroute path",
    ]);
    const stored = await store.readRetro("t1");
    expect(stored?.findings).toEqual(retro.findings);
    expect(stored?.text).toContain("verify command failed twice");
    const cards = await store.listCards("t1");
    expect(cards.find((c) => c.id === "retro")?.task).toContain("command not found"); // history fed to the retro agent
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("retro written: 2 finding")),
    ).toBe(true);

    // Owner comments/questions go back to the retro agent, which answers
    // and returns a revised retro (owner-rejected findings dropped).
    const revised = await runRetroFollowup(
      "t1",
      [
        {
          finding: "add a regression test for the verify reroute path",
          comment: "why did verify fail at all? drop the test finding",
        },
      ],
      {
        store,
        command: [
          "bun",
          stub,
        ],
        now: () => T0,
      },
    );
    expect(revised.text).toContain("## Answers");
    expect(revised.findings).toEqual([
      "extract the repeated curl checks into a reusable health script",
    ]);
    expect((await store.readRetro("t1"))?.findings).toEqual(revised.findings);
    expect(
      (await store.listPrompts("t1")).some(
        (p) => p.kind === "user" && p.text.includes("retro comment"),
      ),
    ).toBe(true);
  }, 120_000);

  test("findings compose title + WHAT + WHY into one inbox-readable point", () => {
    const text = [
      "body",
      "FINDING: extract the repeated curl checks into a health script",
      "WHAT: create scripts/health.ts wrapping the three curl probes and use it in verify",
      "WHY: the same checks were hand-run 4 times and failed twice on typos",
      "FINDING: add a regression test for the verify reroute path",
      "WHAT: cover the sentence-as-command case in dispatch tests",
      "WHY: it parked three tasks before the reroute existed",
    ].join("\n");
    const findings = composeFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain("extract the repeated curl checks");
    expect(findings[0]).toContain("create scripts/health.ts");
    expect(findings[0]).toContain("Why: the same checks were hand-run 4 times");
    expect(findings[0]?.length).toBeLessThanOrEqual(500);
    // Old single-line findings still parse as title-only points.
    expect(composeFindings("FINDING: just a title")).toEqual([
      "just a title",
    ]);
  }, 120_000);

  test("retro points file as separate candidate tasks and the feature closes itself", async () => {
    const { store } = await setup();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(task);
    await store.writeRetro("t1", {
      text: "body",
      findings: [
        "extract the curl checks — create scripts/health.ts. Why: hand-run 4 times",
        "add a regression test — cover the reroute. Why: it parked tasks",
      ],
      at: T0,
    });
    const created = await fileRetroPoints(store, task, {
      now: () => T0,
    });
    expect(created).toHaveLength(2);
    const source = await store.readTask("t1");
    expect(source?.retroReviewedAt).toBe(T0); // closed without the owner
    for (const id of created) {
      const child = await store.readTask(id);
      expect(child?.state).toBe("planned");
      expect(child?.planRequested).toBe(false); // waits for its own accept
      expect(child?.tags).toContain("retro-point");
    }
    // Filing is idempotent: a second pass creates nothing new.
    const again = await fileRetroPoints(store, (await store.readTask("t1"))!, {
      now: () => T0,
    });
    expect(again).toEqual([]);
    expect(
      (await store.listTasks("p1")).filter((t) => t.tags.includes("retro-point")),
    ).toHaveLength(2);
  }, 120_000);

  test("retro points skip findings already covered by a done task", async () => {
    const { store } = await setup();
    const done = {
      ...newTask(
        {
          id: "t0",
          projectId: "p1",
          title: "extract the curl checks",
          prompt: "extract the repeated curl checks into a reusable health script",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(done);
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(task);
    await store.writeRetro("t1", {
      text: "body",
      findings: [
        "extract the repeated curl checks into a reusable health script — create scripts/health.ts. Why: hand-run 4 times",
        "add a regression test — cover the reroute. Why: it parked tasks",
      ],
      at: T0,
    });
    const created = await fileRetroPoints(store, task, {
      now: () => T0,
    });
    expect(created).toHaveLength(1);
    const child = await store.readTask(created[0]!);
    expect(child?.title.toLowerCase()).toContain("add a regression test");
  });

  test("concurrent retro filing creates only one set of points", async () => {
    const { store } = await setup();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(task);
    await store.writeRetro("t1", {
      text: "body",
      findings: [
        "extract the curl checks — create scripts/health.ts. Why: hand-run 4 times",
        "add a regression test — cover the reroute. Why: it parked tasks",
      ],
      at: T0,
    });
    const [a, b] = await Promise.all([
      fileRetroPoints(store, task, {
        now: () => T0,
      }),
      fileRetroPoints(store, task, {
        now: () => T0,
      }),
    ]);
    expect(a.length + b.length).toBe(2);
    expect(
      (await store.listTasks("p1")).filter((t) => t.tags.includes("retro-point")),
    ).toHaveLength(2);
  });

  test("retro filing caps points per task, rest stay in the retro text", async () => {
    const { store } = await setup();
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(task);
    await store.writeRetro("t1", {
      text: "body",
      findings: [
        "point one alpha",
        "point two bravo",
        "point three charlie",
        "point four delta",
        "point five echo",
      ],
      at: T0,
    });
    const created = await fileRetroPoints(store, task, {
      now: () => T0,
    });
    expect(created).toHaveLength(3);
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("2 point(s) not filed")),
    ).toBe(true);
  });

  test("an over-long finding is hard-capped to a scannable title", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-retro-long.ts");
    const long = "x".repeat(400);
    await Bun.write(
      stub2,
      [
        `const text = "RETRO_DONE\\nbody with all the evidence\\nFINDING: ${long}";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-rl" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "done" as const,
    };
    await store.writeTask(task);
    const retro = await runRetro("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(retro.findings[0]?.length).toBeLessThanOrEqual(200);
    expect(retro.findings[0]).toEndWith("…");
    expect(retro.text).toContain("body with all the evidence"); // detail stays in the body
  }, 120_000);
});

describe("timed-out builder: intermediate state evaluation", () => {
  test("progress before the timeout resumes the worker; it then finishes", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-timeout.ts");
    await Bun.write(
      stub2,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "status: done";`,
        `if (prompt.includes("Review as")) text = "PASS ok\\nArgument: fine";`,
        `else if (prompt.includes("hit the time limit")) text = "status: done — saved intermediate state and finished";`,
        `else { writeFileSync(join(cwd, "progress.txt"), "half done"); await Bun.sleep(3000); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-t" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
      timeoutMs: 400,
    });
    expect(done.state).toBe("done");
    const prompts = await store.listPrompts("t1");
    expect(
      prompts.some(
        (p) => p.text.includes("intermediate state check") && p.text.includes("real progress"),
      ),
    ).toBe(true);
  }, 120_000);

  test("a timeout with no file changes automatically reiterates without the owner, and only parks after every iteration times out", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-loop.ts");
    await Bun.write(
      stub2,
      [
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `let text = "status: done";`,
        `if (prompt.includes("Review as")) text = "PASS ok\\nArgument: fine";`,
        `else await Bun.sleep(3000);`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-l" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const parked = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
      timeoutMs: 400,
    });
    expect(parked.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    // Two automatic reiterations happened before the park — the owner
    // was never asked in between.
    expect(
      prompts.filter((p) => p.text.includes("automatically reiterating without owner input"))
        .length,
    ).toBe(2);
    expect(prompts.some((p) => p.text.includes("timed out on every iteration"))).toBe(true);
    expect(prompts.filter((p) => p.kind === "agent" && p.text.startsWith("builder (")).length).toBe(
      3,
    );
  }, 60_000);
});

describe("gate-skip block: factory ruling", () => {
  test("a builder blocked on skipping a quality gate is ruled back to work without the owner", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-gate.ts");
    await Bun.write(
      stub2,
      [
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `let text = "status: done";`,
        `if (prompt.includes("Review as")) text = "PASS ok\\nArgument: fine";`,
        `else if (prompt.includes("Factory ruling")) text = "status: done — implemented the gate-compliant path";`,
        `else text = "blocked: redteam: proposes skipping a quality gate";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-g" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const prompts = await store.listPrompts("t1");
    expect(
      prompts.some((p) => p.text.includes("factory ruling: quality gates are never skipped")),
    ).toBe(true);
  }, 60_000);
});

describe("boundary-gate veto cannot loop a task", () => {
  test("sanitizeGateVeto strips only the offending lines and rules in their place", () => {
    const out = sanitizeGateVeto("do the work\nskip the lint gate to save time\nship it");
    expect(out.removed).toEqual([
      "proposes skipping a quality gate",
    ]);
    expect(out.text).not.toContain("skip the lint");
    expect(out.text).toContain("never bypassed");
    expect(sanitizeGateVeto("clean plan\nship it").removed).toEqual([]);
  }, 120_000);

  test("sanitizeGateVeto keeps a defensive rule and strips only the real proposal", () => {
    const out = sanitizeGateVeto(
      "never skip the lint gate\nskip the typecheck gate to save time\nship it",
    );
    expect(out.removed).toEqual([
      "proposes skipping a quality gate",
    ]);
    expect(out.text).toContain("never skip the lint gate"); // the rule survives
    expect(out.text).not.toContain("skip the typecheck");
  });

  test("a plan line proposing to bypass a check no longer vetoes the builder card forever", async () => {
    const { store, stub } = await setup();
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "1. build it\n2. skip the typecheck gate to save time\n3. ship",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "use the global settings as the default",
    });
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const cards = await store.listCards("t1");
    const builderCard = cards.find((c) => c.id === "builder");
    expect(builderCard?.task).not.toContain("skip the typecheck");
    expect(builderCard?.task).toContain("factory ruling");
    expect(builderCard?.task).toContain("do NOT ask any of this again"); // settled owner answers ride in the card
    expect(builderCard?.task).toContain("use the global settings as the default");
    // Reviewer cards are sanitized at write time too, so a reviewer is never
    // vetoed for reading its own plan's anti-pattern description.
    const smeCard = cards.find((c) => c.id === "sme");
    const coderCard = cards.find((c) => c.id === "coder");
    expect(smeCard?.task).not.toContain("skip the typecheck");
    expect(smeCard?.task).toContain("factory ruling");
    expect(coderCard?.task).not.toContain("skip the typecheck");
    expect(coderCard?.task).toContain("factory ruling");
    expect(
      (await store.listPrompts("t1")).some((p) =>
        p.text.includes("boundary gate: removed 1 plan line"),
      ),
    ).toBe(true);
    expect(
      (await store.listPrompts("t1")).some((p) => p.text.includes("from the sme reviewer card")),
    ).toBe(true);
  }, 60_000);
});

describe("verify failure digest (only error lines, no passing noise)", () => {
  test("keeps failure/error/location lines and drops passing test noise", () => {
    const out = [
      "(pass) should handle the happy path [12ms]",
      "(pass) should handle the other path [8ms]",
      "(fail) dashboard projects API > DELETE permanently removes a task [245ms]",
      "AssertionError: expected undefined to be a function",
      "    at <anonymous> (/app/dashboard/dashboard.test.ts:361:18)",
      "154 pass",
      "1 fail",
      "1 error",
      'error: script "test" exited with code 1',
    ].join("\n");
    const digest = digestVerifyFailure(out);
    expect(digest).toContain("dashboard projects API");
    expect(digest).toContain("AssertionError");
    expect(digest).toContain("dashboard.test.ts:361:18");
    expect(digest).toContain("1 fail");
    expect(digest).not.toContain("should handle the happy path");
    expect(digest).not.toContain("should handle the other path");
  });

  test("preserves the not-runnable signal so the factory can still reroute", () => {
    const digest = digestVerifyFailure(
      "/bin/bash: line 1: definitely-not-a-command: command not found",
    );
    expect(digest).toContain("command not found");
  });
});

describe("reviewer station retry", () => {
  test("a reviewer station that dies is retried once with a fresh session instead of blocking", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-reviewer.ts");
    await Bun.write(
      stub2,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Review as a subject-matter expert")) { const flag = join(cwd, ".sme-died"); if (!existsSync(flag)) { writeFileSync(flag, "1"); console.error("station blew up"); process.exit(1); } text = "PASS sme ok\\nArgument: fine"; }`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: fine";`,
        `else { const { writeFileSync: wf } = await import("node:fs"); wf(join(cwd, "verification.webm"), "video-bytes"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-r" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("reviewer station sme did not complete"))).toBe(
      true,
    );
    expect(prompts.some((p) => p.text.includes("sme (retry):"))).toBe(true);
  }, 60_000);

  test("a reviewer station that dies twice escalates to the strong model instead of blocking", async () => {
    const { base, store } = await setup();
    const stub2 = join(base, "stub-reviewer2.ts");
    await Bun.write(
      stub2,
      [
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Review as a subject-matter expert")) { const flag = join(cwd, ".sme-deaths"); const n = existsSync(flag) ? Number(readFileSync(flag, "utf8")) : 0; if (n < 2) { writeFileSync(flag, String(n + 1)); console.error("station blew up"); process.exit(1); } text = "PASS sme ok\\nArgument: fine"; }`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: fine";`,
        `else { const { writeFileSync: wf } = await import("node:fs"); wf(join(cwd, "verification.webm"), "video-bytes"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-r2" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub2,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("escalating to the strong model"))).toBe(true);
    expect(prompts.some((p) => p.text.includes("sme (escalated):"))).toBe(true);
  }, 60_000);
});

describe("auto-commit on finish", () => {
  test("a done task's work is committed on task/<id> and pushed", async () => {
    const { base, repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    // The branch was merged into main by the finalize path, so both the
    // local and remote task branches are deleted; the work is on main.
    const remote = git(`ls-remote origin task/t1`);
    expect(remote).not.toContain("refs/heads/task/t1");
    expect(() => git("rev-parse --verify -q refs/heads/task/t1")).toThrow();
    const log = git(`log --oneline main`);
    expect(log).toContain("task t1:");
    expect(
      (await store.listPrompts("t1")).some((p) =>
        p.text.includes("auto-commit: pushed branch task/t1"),
      ),
    ).toBe(true);
  }, 60_000);

  test("a finished task auto-merges into a clean main checkout and pushes main", async () => {
    const { base, repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    expect(git("log --oneline -3 main")).toContain("merge task/t1");
    expect(git("ls-tree --name-only main")).toContain("verification.webm");
    expect(git(`ls-remote origin main`)).toContain("refs/heads/main");
    expect(
      (await store.listPrompts("t1")).some(
        (p) => p.text.startsWith("auto-commit:") && p.text.includes("merged into main"),
      ),
    ).toBe(true);
  }, 60_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("auto-commit push-pending and retry", () => {
  const landingLines = (
    prompts: {
      text: string;
    }[],
  ) =>
    prompts.filter(
      (p) =>
        p.text.startsWith("auto-commit:") ||
        p.text.startsWith("auto-merge:") ||
        p.text.startsWith("push retry:"),
    );

  test("push failure: one committed-locally line, branch pending, held in-review; retry lands it", async () => {
    const { base, repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M master"); // no main checkout: merge is skipped, branch push is the owed obligation
    git(`remote set-url origin ${join(base, "missing.git")}`);
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const held = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(held.state).toBe("in-review");
    const prompts = await store.listPrompts("t1");
    const lines = landingLines(prompts);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("committed-locally, push-pending");
    expect(
      prompts.some(
        (p) => p.text.includes("branch missing") || p.text.includes("nothing was committed"),
      ),
    ).toBe(false);
    const fresh = await store.readTask("t1");
    expect(fresh?.branchPushPending?.targetRef).toBe("task/t1");
    expect(fresh?.branchPushPending?.nextRetryAt).toBe("2026-10-22T10:01:00.000Z");
    expect(fresh?.mainPushPending).toBeNull();
    expect(git("rev-parse task/t1").trim()).toBe(fresh?.branchPushPending?.commit ?? "");
    // Restore origin: concurrent sweeps perform one push and one retry line.
    git(`remote set-url origin ${bare}`);
    await Promise.all([
      retryPendingPushes(store, () => "2026-10-22T10:02:00.000Z"),
      retryPendingPushes(store, () => "2026-10-22T10:02:00.000Z"),
    ]);
    expect(git(`ls-remote origin task/t1`)).toContain("refs/heads/task/t1");
    expect((await store.readTask("t1"))?.state).toBe("done");
    expect((await store.readTask("t1"))?.branchPushPending).toBeNull();
    const after = landingLines(await store.listPrompts("t1"));
    expect(after.filter((p) => p.text.startsWith("push retry:"))).toHaveLength(1);
  }, 180_000);

  test("missing origin: local-only repo lands locally on both paths, no push owed, never reported pushed", async () => {
    const { repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    git("branch -M master"); // no main checkout and no origin remote at all: branch path
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "tnoorigin",
          projectId: "p1",
          title: "tnoorigin",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "noorigin.txt"), "work\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    const fresh = await store.readTask("tnoorigin");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending).toBeNull();
    expect(git("rev-parse task/tnoorigin").trim()).not.toBe(baseCommit);
    const lines = landingLines(await store.listPrompts("tnoorigin"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("committed-locally");
    expect(lines[0]?.text).toContain("no origin remote configured");
    expect(lines[0]?.text).not.toContain("push-pending");
    expect(lines[0]?.text).not.toContain("pushed");
    expect(await retryPendingPushes(store, () => T0)).toEqual([]);
    // Main path: fresh local-only repo on main — merged locally, done, no "pushed" claim.
    const s2 = await setup();
    const git2 = (args: string, cwd = s2.repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    git2("branch -M main");
    const mainBase = git2("rev-parse HEAD").trim();
    const task1 = {
      ...newTask(
        {
          id: "tnooriginmain",
          projectId: "p1",
          title: "tnooriginmain",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit: mainBase,
    };
    const prepared1 = await prepareWorktree(s2.store, task1);
    await Bun.write(join(prepared1.worktree, "noorigin-main.txt"), "work\n");
    expect(await landTaskWork(s2.store, prepared1, () => T0)).toBe("done");
    expect((await s2.store.readTask("tnooriginmain"))?.branchPushPending).toBeNull();
    expect((await s2.store.readTask("tnooriginmain"))?.mainPushPending).toBeNull();
    expect(git2("ls-tree --name-only main")).toContain("noorigin-main.txt");
    const mainLines = landingLines(await s2.store.listPrompts("tnooriginmain"));
    expect(mainLines).toHaveLength(1);
    expect(mainLines[0]?.text).toContain("merged into main");
    expect(mainLines[0]?.text).toContain("locally");
    expect(mainLines[0]?.text).toContain("no origin remote configured");
    expect(mainLines[0]?.text).not.toContain("and pushed");
  }, 180_000);

  test("dirty main checkout: branch merges via an isolated worktree and git fast-forwards the dirty checkout, owner work exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "tdirty",
          projectId: "p1",
          title: "tdirty",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "dirtyfeat.txt"), "work\n");
    // The owner leaves uncommitted work (one unstaged edit, one staged
    // file) in the main checkout. The merge touches neither, so git can
    // fast-forward the dirty checkout itself and carry both untouched.
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    await Bun.write(join(repo, "owner-staged.txt"), "owner staged work\n");
    git("add owner-staged.txt");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    const fresh = await store.readTask("tdirty");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending).toBeNull();
    expect(git("rev-parse main").trim()).not.toBe(baseCommit);
    expect(git("log --oneline -3 main")).toContain("merge task/tdirty");
    expect(git("ls-tree --name-only main")).toContain("dirtyfeat.txt");
    expect(git(`ls-remote origin main`)).toContain(git("rev-parse main").trim());
    // The landed file is really in the owner's working tree, and the
    // exact status is only the owner's own work: no staged deletion.
    expect(await Bun.file(join(repo, "dirtyfeat.txt")).text()).toBe("work\n");
    expect(await Bun.file(join(repo, "a.txt")).text()).toBe("owner uncommitted edit\n");
    expect(git("symbolic-ref HEAD").trim()).toBe("refs/heads/main");
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\nA  owner-staged.txt\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("tdirty"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merged into main");
    expect(lines[0]?.text).toContain("and pushed");
  }, 180_000);

  test("dirty main checkout whose work the merge would overwrite: parks, main and owner work exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "tdirtyover",
          projectId: "p1",
          title: "tdirtyover",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    // The owner's uncommitted edit is to the very file the task changed:
    // git must refuse the fast-forward rather than overwrite it.
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("parked");
    expect(git("rev-parse main").trim()).toBe(baseCommit);
    expect(git("show main:a.txt")).toBe("one\n");
    expect(await Bun.file(join(repo, "a.txt")).text()).toBe("owner uncommitted edit\n");
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("tdirtyover"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("parked");
    expect(lines[0]?.text).toContain("would overwrite uncommitted work");
  }, 180_000);

  test("off-main checkout: pushed branch merges via an isolated worktree, owner status exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    git("checkout -q -b owner-scratch");
    const baseCommit = git("rev-parse main").trim();
    const task0 = {
      ...newTask(
        {
          id: "toffmain",
          projectId: "p1",
          title: "toffmain",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "offmainfeat.txt"), "work\n");
    // Uncommitted work on a different branch: moving main cannot strand it.
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    const fresh = await store.readTask("toffmain");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending).toBeNull();
    expect(git("log --oneline -3 main")).toContain("merge task/toffmain");
    expect(git("ls-tree --name-only main")).toContain("offmainfeat.txt");
    expect(git(`ls-remote origin main`)).toContain(git("rev-parse main").trim());
    // Owner is still on the scratch branch with exactly their own edit.
    expect(git("symbolic-ref HEAD").trim()).toBe("refs/heads/owner-scratch");
    expect(await Bun.file(join(repo, "a.txt")).text()).toBe("owner uncommitted edit\n");
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("toffmain"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merged into main");
    expect(lines[0]?.text).toContain("and pushed");
  }, 180_000);

  test("off-main checkout, main push rejected: isolated merge lands locally, held for main-push retry", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    // Reject only main at the remote.
    writeFileSync(
      join(bare, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo reject-main >&2; exit 1; fi; done\nexit 0\n',
      {
        mode: 0o755,
      },
    );
    git("checkout -q -b owner-scratch");
    const baseCommit = git("rev-parse main").trim();
    const task0 = {
      ...newTask(
        {
          id: "toffpush",
          projectId: "p1",
          title: "toffpush",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "offpushfeat.txt"), "work\n");
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("held");
    const fresh = await store.readTask("toffpush");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending?.targetRef).toBe("main");
    expect(git("log --oneline -3 main")).toContain("merge task/toffpush");
    expect(git(`ls-remote origin main`)).not.toContain(fresh?.mainPushPending?.commit ?? "nope");
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("toffpush"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merged-locally, push-pending");
    // Retry pushes only main and lands the task.
    rmSync(join(bare, "hooks", "pre-receive"), {
      force: true,
    });
    await retryPendingPushes(store, () => "2026-10-22T10:02:00.000Z");
    expect(git(`ls-remote origin main`)).toContain(fresh?.mainPushPending?.commit ?? "");
    expect((await store.readTask("toffpush"))?.state).toBe("done");
    expect((await store.readTask("toffpush"))?.mainPushPending).toBeNull();
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
  }, 180_000);

  test("off-main checkout with a conflicting main: parks before any isolated worktree, owner status exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "toffconf",
          projectId: "p1",
          title: "toffconf",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    // Advance main with a conflicting edit, then leave the owner off-main.
    git("checkout -q main");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-conflict");
    const advancedMain = git("rev-parse main").trim();
    git("checkout -q -b owner-scratch");
    await Bun.write(join(repo, "owner.txt"), "owner untracked\n");
    const statusBefore = git("status --porcelain");
    expect(statusBefore).toContain("?? owner.txt\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("parked");
    expect(git("rev-parse main").trim()).toBe(advancedMain);
    expect(git("status --porcelain")).toBe(statusBefore);
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("toffconf"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merge conflict");
  }, 180_000);

  test("main checked out in a second worktree: git fast-forwards that worktree, both checkouts exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    git("checkout -q -b owner-scratch");
    const mainWt = join(base, "main-wt");
    git(`worktree add -q ${mainWt} main`);
    const baseCommit = git("rev-parse main").trim();
    const task0 = {
      ...newTask(
        {
          id: "tmainwt",
          projectId: "p1",
          title: "tmainwt",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "mainwtfeat.txt"), "work\n");
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(git("rev-parse main").trim()).not.toBe(baseCommit);
    expect(git("log --oneline -3 main")).toContain("merge task/tmainwt");
    expect(git("ls-tree --name-only main")).toContain("mainwtfeat.txt");
    expect(git(`ls-remote origin main`)).toContain(git("rev-parse main").trim());
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
    // The main worktree was fast-forwarded by git: clean, landed file present.
    expect(git("status --porcelain --untracked-files=no", mainWt)).toBe("");
    expect(await Bun.file(join(mainWt, "mainwtfeat.txt")).text()).toBe("work\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("tmainwt"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merged into main");
  }, 180_000);

  test("off-main CAS race: main moving during the isolated merge fails without overwriting it", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    git("checkout -q -b owner-scratch");
    const baseCommit = git("rev-parse main").trim();
    const racerCommit = git(`commit-tree main^{tree} -p main -m racer`).trim();
    const task0 = {
      ...newTask(
        {
          id: "tcas",
          projectId: "p1",
          title: "tcas",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "casfeat.txt"), "work\n");
    await Bun.write(join(repo, "a.txt"), "owner uncommitted edit\n");
    // Move main from the merge commit-msg hook, which fires inside the
    // isolated worktree after mainHead was captured but before the CAS
    // update-ref — a deterministic main-moved race.
    writeFileSync(
      join(repo, ".git", "hooks", "commit-msg"),
      `#!/bin/sh\ncase "$PWD" in *factory-land-*) git update-ref refs/heads/main ${racerCommit} ;; esac\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    const landed = await landTaskWork(store, task, () => T0);
    expect(landed).toBe("done");
    expect(git("rev-parse main").trim()).toBe(racerCommit);
    expect(git("ls-tree --name-only main")).not.toContain("casfeat.txt");
    expect(git("status --porcelain --untracked-files=no")).toBe(" M a.txt\n");
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("tcas"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("ready to merge into main");
    expect(lines[0]?.text).not.toContain("merged into main");
  }, 180_000);

  test("isolated merge conflict: parks, aborts and removes the temporary worktree, owner exactly preserved", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "tisoconf",
          projectId: "p1",
          title: "tisoconf",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    git("checkout -q -b owner-scratch");
    await Bun.write(join(repo, "owner.txt"), "owner untracked\n");
    const statusBefore = git("status --porcelain");
    expect(statusBefore).toContain("?? owner.txt\n");
    // Dirty a.txt inside the isolated worktree as it is checked out, so
    // the assessment (against clean main) passes but the real merge in
    // the temporary worktree fails and must be cleaned up.
    writeFileSync(
      join(repo, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ncase "$PWD" in *factory-land-*) printf 'hook version\\n' > a.txt ;; esac\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    const landed = await landTaskWork(store, task, () => T0);
    expect(landed).toBe("parked");
    expect(git("rev-parse main").trim()).toBe(baseCommit);
    expect(git("status --porcelain")).toBe(statusBefore);
    expect(git("worktree list --porcelain")).not.toContain("factory-land-");
    const lines = landingLines(await store.listPrompts("tisoconf"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merge conflict");
  }, 180_000);

  test("main push failure: merged-locally pending, branch superseded; retry pushes only main to done", async () => {
    const { base, repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    // Reject only main at the remote.
    writeFileSync(
      join(bare, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo reject-main >&2; exit 1; fi; done\nexit 0\n',
      {
        mode: 0o755,
      },
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const held = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(held.state).toBe("in-review");
    const lines = landingLines(await store.listPrompts("t1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("merged-locally, push-pending");
    const fresh = await store.readTask("t1");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending?.targetRef).toBe("main");
    expect(git("log --oneline -3 main")).toContain("merge task/t1");
    expect(git(`ls-remote origin main`)).not.toContain(fresh?.mainPushPending?.commit ?? "nope");
    rmSync(join(bare, "hooks", "pre-receive"), {
      force: true,
    });
    await retryPendingPushes(store, () => "2026-10-22T10:02:00.000Z");
    expect(git(`ls-remote origin main`)).toContain(fresh?.mainPushPending?.commit ?? "");
    expect((await store.readTask("t1"))?.state).toBe("done");
    expect((await store.readTask("t1"))?.mainPushPending).toBeNull();
    expect(
      landingLines(await store.listPrompts("t1")).filter((p) => p.text.startsWith("push retry:")),
    ).toHaveLength(1);
  }, 180_000);

  test("supersession: branch push fails but merge and main push succeed — done, no branch retry owed", async () => {
    const { base, repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    git("branch -M main");
    git(`push -q origin main`);
    // Reject only task/* branches at the remote; main pushes succeed.
    writeFileSync(
      join(bare, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/task/*) echo reject-branch >&2; exit 1;; esac; done\nexit 0\n',
      {
        mode: 0o755,
      },
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    const fresh = await store.readTask("t1");
    expect(fresh?.branchPushPending).toBeNull();
    expect(fresh?.mainPushPending).toBeNull();
    expect(git(`ls-remote origin task/t1`)).not.toContain("refs/heads/task/t1");
    expect(git(`ls-remote origin main`)).toContain(git("rev-parse main").trim());
    expect(git("log --oneline -3 main")).toContain("merge task/t1");
    const lines = landingLines(await store.listPrompts("t1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).not.toContain("push-pending");
    // No retry is queued or attempted for the superseded branch push.
    expect(await retryPendingPushes(store, () => "2026-10-22T12:00:00.000Z")).toEqual([]);
    expect(git(`ls-remote origin task/t1`)).not.toContain("refs/heads/task/t1");
  }, 180_000);

  test("secret files fold into the single landing line; nothing-changed writes no line", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    git("branch -M master");
    git(`remote add origin ${join(base, "missing.git")}`);
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "tsec",
          projectId: "p1",
          title: "tsec",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "b.txt"), "safe\n");
    await Bun.write(join(task.worktree, ".env"), "SECRET=1\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("held");
    const lines = landingLines(await store.listPrompts("tsec"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("secret-like");
    expect(lines[0]?.text).toContain("committed-locally, push-pending");
    // Nothing changed.
    const clean0 = {
      ...newTask(
        {
          id: "tclean",
          projectId: "p1",
          title: "tclean",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const clean = await prepareWorktree(store, clean0);
    expect(await landTaskWork(store, clean, () => T0)).toBe("done");
    expect(landingLines(await store.listPrompts("tclean"))).toHaveLength(0);
    expect((await store.readTask("tclean"))?.branchPushPending).toBeNull();
  }, 180_000);

  test("exhaustion parks in needs-input without parked/conflict wording", async () => {
    const { repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const wt = await prepareWorktree(
      store,
      newTask(
        {
          id: "tex",
          projectId: "p1",
          title: "tex",
          prompt: "x",
        },
        T0,
      ),
    );
    await Bun.write(join(wt.worktree, "ex.txt"), "work\n");
    git("add ex.txt", wt.worktree);
    git(`commit -qm "task work"`, wt.worktree);
    const commit = git("rev-parse HEAD", wt.worktree).trim();
    const task = {
      ...wt,
      state: "in-review" as const,
      branchPushPending: {
        targetRef: "task/tex",
        commit,
        attempts: 7,
        lastError: "down",
        nextRetryAt: T0,
      },
    };
    await store.writeTask(task);
    await retryPendingPushes(store, () => T0);
    expect((await store.readTask("tex"))?.state).toBe("needs-input");
    const lines = landingLines(await store.listPrompts("tex"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("automatic retries stopped");
    expect(lines[0]?.text).not.toContain("parked");
    expect(lines[0]?.text).not.toContain("merge conflict");
  }, 180_000);

  test("ref-based assessment ignores a reused pooled slot", async () => {
    const { repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "tslot",
          projectId: "p1",
          title: "tslot",
          prompt: "x",
        },
        T0,
      ),
    );
    await Bun.write(join(task.worktree, "c.txt"), "clean task file\n");
    git("add c.txt", task.worktree);
    git(`commit -qm "task work"`, task.worktree);
    // Main moves on a.txt.
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    // Reused slot held by another task, with a would-be conflicting dirty edit.
    const slots = ensureWarmWorktrees(repo, "p1", 1, git("rev-parse HEAD").trim());
    const slot = slots[0] ?? "";
    writeFileSync(`${slot}.lease`, "other-task");
    await Bun.write(join(slot, "a.txt"), "slot version\n");
    const assessed = assessMergeability(repo, {
      ...task,
      worktree: slot,
    });
    expect(assessed.status).toBe("clean");
    expect(await Bun.file(join(slot, "a.txt")).text()).toBe("slot version\n");
    expect(
      execSync("git status --porcelain", {
        cwd: slot,
        encoding: "utf8",
      }),
    ).toContain("a.txt");
  }, 180_000);

  test("legacy worktree named by a numeric task id is trusted and commits its dirty work", async () => {
    const { repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...newTask(
        {
          id: "task-1790000000000",
          projectId: "p1",
          title: "legacy",
          prompt: "x",
        },
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    expect(task.worktree.endsWith("task-1790000000000")).toBe(true);
    expect(worktreeLeasedByTask(task)).toBe(true);
    await Bun.write(join(task.worktree, "legacy.txt"), "legacy work\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(git("ls-tree --name-only main")).toContain("legacy.txt");
    // Finalized: merged branch deleted and the legacy worktree removed.
    expect(() => git("rev-parse --verify -q refs/heads/task/task-1790000000000")).toThrow();
    expect(existsSync(task.worktree)).toBe(false);
  }, 180_000);

  test("verification-failed park auto-resumes once without owner input, then stays parked", async () => {
    const { store, stub } = await setup();
    const mk = async (id: string, extra: string[]) => {
      const t = {
        ...newTask(
          {
            id,
            projectId: "p1",
            title: id,
            prompt: "x",
          },
          T0,
        ),
        state: "needs-input" as const,
      };
      await store.writeTask(t);
      for (const text of extra)
        await store.appendPrompt(id, {
          at: T0,
          kind: "system",
          text,
        });
      await store.appendPrompt(id, {
        at: T0,
        kind: "system",
        text: "verification failed (bun run verify): (fail) demo test in a fresh worktree",
      });
    };
    await mk("tverify", []);
    const launched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => "2026-10-22T10:11:00.000Z",
    });
    expect(launched).toContain("tverify");
    expect(
      (await store.listPrompts("tverify")).some((p) => p.text.includes("verification auto-resume")),
    ).toBe(true);
    // Already auto-resumed once and parked again on the same failure: owner.
    await mk("tverify2", [
      "verification auto-resume: resuming automatically; re-running verification",
    ]);
    const launched2 = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => "2026-10-22T10:12:00.000Z",
    });
    expect(launched2).not.toContain("tverify2");
  }, 180_000);

  test("slot-reuse branch retry lands from this task's ref and leaves the other slot untouched", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "tslotretry",
          projectId: "p1",
          title: "tslotretry",
          prompt: "x",
        },
        T0,
      ),
    );
    await Bun.write(join(task.worktree, "c.txt"), "clean task file\n");
    git("add c.txt", task.worktree);
    git(`commit -qm "task work"`, task.worktree);
    const commit = git("rev-parse HEAD", task.worktree).trim();
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const slots = ensureWarmWorktrees(repo, "p1", 1, git("rev-parse HEAD").trim());
    const slot = slots[0] ?? "";
    writeFileSync(`${slot}.lease`, "other-task");
    await Bun.write(join(slot, "a.txt"), "slot version\n");
    const slotHead = git("rev-parse HEAD", slot).trim();
    const held = {
      ...task,
      state: "in-review" as const,
      worktree: slot,
      branchPushPending: {
        targetRef: "task/tslotretry",
        commit,
        attempts: 1,
        lastError: "down",
        nextRetryAt: T0,
      },
    };
    await store.writeTask(held);
    await retryPendingPushes(store, () => T0);
    expect((await store.readTask("tslotretry"))?.state).toBe("done");
    expect((await store.readTask("tslotretry"))?.branchPushPending).toBeNull();
    expect((await store.readTask("tslotretry"))?.mainPushPending).toBeNull();
    // Finalized by the retry: the merged task branch is deleted remotely.
    expect(git(`ls-remote origin task/tslotretry`)).not.toContain("refs/heads/task/tslotretry");
    expect(git(`ls-remote origin main`)).toContain(git("rev-parse main").trim());
    expect(git("ls-tree --name-only main")).toContain("c.txt");
    const lines = landingLines(await store.listPrompts("tslotretry"));
    expect(lines.filter((l) => l.text.startsWith("push retry:"))).toHaveLength(1);
    // The other task's slot, lease and HEAD are untouched.
    expect(await Bun.file(`${slot}.lease`).text()).toBe("other-task");
    expect(git("rev-parse HEAD", slot).trim()).toBe(slotHead);
    expect(await Bun.file(join(slot, "a.txt")).text()).toBe("slot version\n");
    expect(
      execSync("git status --porcelain", {
        cwd: slot,
        encoding: "utf8",
      }),
    ).toContain("a.txt");
  }, 180_000);

  test("slot-reuse vice versa: clean slot but conflicting ref parks from the ref, slot untouched", async () => {
    const { base, repo, store } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    const bare = join(base, "origin.git");
    git(`init --bare -q ${bare}`);
    git(`remote add origin ${bare}`);
    const task = await prepareWorktree(
      store,
      newTask(
        {
          id: "tslotconf",
          projectId: "p1",
          title: "tslotconf",
          prompt: "x",
        },
        T0,
      ),
    );
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    git("add a.txt", task.worktree);
    git(`commit -qm "task work"`, task.worktree);
    const commit = git("rev-parse HEAD", task.worktree).trim();
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const slots = ensureWarmWorktrees(repo, "p1", 1, git("rev-parse HEAD").trim());
    const slot = slots[0] ?? "";
    writeFileSync(`${slot}.lease`, "other-task");
    const slotHead = git("rev-parse HEAD", slot).trim();
    const held = {
      ...task,
      state: "in-review" as const,
      worktree: slot,
      branchPushPending: {
        targetRef: "task/tslotconf",
        commit,
        attempts: 1,
        lastError: "down",
        nextRetryAt: T0,
      },
    };
    await store.writeTask(held);
    await retryPendingPushes(store, () => T0);
    expect((await store.readTask("tslotconf"))?.state).toBe("needs-input");
    const lines = landingLines(await store.listPrompts("tslotconf"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.startsWith("auto-commit: parked")).toBe(true);
    expect(lines[0]?.text).toContain("merge conflict");
    expect(git(`ls-remote origin task/tslotconf`)).toContain("refs/heads/task/tslotconf");
    expect(await Bun.file(`${slot}.lease`).text()).toBe("other-task");
    expect(git("rev-parse HEAD", slot).trim()).toBe(slotHead);
    expect(
      execSync("git status --porcelain", {
        cwd: slot,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  }, 180_000);

  test("merge conflict parks with single auto-commit line and auto-resumes once; decisions and legacy handling", async () => {
    const { repo, store, stub } = await setup();
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task0 = {
      ...approvePlan(
        draftPlan(
          newTask(
            {
              id: "tconf",
              projectId: "p1",
              title: "tconf",
              prompt: "add hello service",
            },
            T0,
          ),
          "plan",
          T0,
        ),
        T0,
      ),
      state: "in-review" as const,
      baseCommit,
    };
    const task = await prepareWorktree(store, task0);
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    expect(await landTaskWork(store, task, () => T0)).toBe("parked");
    const lines = landingLines(await store.listPrompts("tconf"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.startsWith("auto-commit: parked")).toBe(true);
    expect(lines[0]?.text).toContain("merge conflict");
    await store.moveTask("tconf", "needs-input", T0);
    const later = "2026-10-22T10:11:00.000Z";
    const launched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(launched).toContain("tconf");
    expect(
      (await store.listPrompts("tconf")).some((p) => p.text.includes("merge conflict auto-resume")),
    ).toBe(true);
    const launched2 = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(launched2).not.toContain("tconf");
    // Decisions park is not auto-resumed.
    const dec = {
      ...newTask(
        {
          id: "tdec",
          projectId: "p1",
          title: "tdec",
          prompt: "x",
        },
        T0,
      ),
      state: "needs-input" as const,
    };
    await store.writeTask(dec);
    await store.appendPrompt("tdec", {
      at: T0,
      kind: "system",
      text: "auto-commit: parked — decisions change in decisions.md; owner to decide",
    });
    const decLaunched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(decLaunched).not.toContain("tdec");
    // Legacy wording still resumes once.
    const leg = {
      ...newTask(
        {
          id: "tleg",
          projectId: "p1",
          title: "tleg",
          prompt: "add hello service",
        },
        T0,
      ),
      state: "needs-input" as const,
      planState: "approved" as const,
      plan: "plan",
    };
    await store.writeTask(leg);
    await store.appendPrompt("tleg", {
      at: T0,
      kind: "system",
      text: "auto-merge paused: merging task/tleg into current main conflicts in a.txt — the branch is pushed",
    });
    const legLaunched = await dispatchTick({
      store,
      command: [
        "bun",
        stub,
      ],
      maxParallelTasks: 1,
      ramFloorMb: 0,
      active: new Set<string>(),
      now: () => later,
    });
    expect(legLaunched).toContain("tleg");
  }, 180_000);
});

const gitInRepo =
  (repo: string) =>
  (args: string, cwd = repo) =>
    execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
      cwd,
      encoding: "utf8",
    });
const mkLandingTask = (id: string, baseCommit: string) => ({
  ...newTask(
    {
      id,
      projectId: "p1",
      title: id,
      prompt: "x",
    },
    T0,
  ),
  state: "in-review" as const,
  baseCommit,
});
const resolverStubFor = async (base: string, oneSided: boolean) => {
  const stub = join(base, oneSided ? "resolver-one-sided.ts" : "resolver-both.ts");
  await Bun.write(
    stub,
    [
      `import { execSync } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const prompt = process.argv[process.argv.length - 1] ?? "";`,
      `const cwd = process.cwd();`,
      `let text = "built";`,
      `if (prompt.includes("Resolve the git merge conflict")) {`,
      `  const g = (a: string) => execSync("git -c user.name=t -c user.email=t@t " + a, { cwd, encoding: "utf8" });`,
      `  const files = g("diff --name-only --diff-filter=U").split("\\n").filter(Boolean);`,
      oneSided
        ? `  for (const f of files) { g('checkout --theirs -- "' + f + '"'); g('add -- "' + f + '"'); }`
        : `  for (const f of files) { let ours = ""; let theirs = ""; try { ours = g('show ":2:' + f + '"'); } catch { /* deleted side */ } try { theirs = g('show ":3:' + f + '"'); } catch { /* deleted side */ } writeFileSync(join(cwd, f), ours + theirs); g('add -- "' + f + '"'); }`,
      `  execSync("git -c user.name=t -c user.email=t@t -c core.editor=true commit -q --no-edit", { cwd });`,
      `  text = "RESOLVED";`,
      `}`,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));`,
    ].join("\n"),
  );
  return stub;
};

describe("finalize: clean worktree on finish", () => {
  test("merged pool-slot task: branch deleted, slot clean, detached, unleased on main", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tfin", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "feat.txt"), "work\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(git("ls-tree --name-only main")).toContain("feat.txt");
    // Branch deleted locally once proven merged; slot resolved for reuse.
    expect(() => git("rev-parse --verify -q refs/heads/task/tfin")).toThrow();
    expect(git("status --porcelain", task.worktree)).toBe("");
    expect(git("rev-parse HEAD", task.worktree).trim()).toBe(git("rev-parse main").trim());
    expect(() => git("symbolic-ref -q HEAD", task.worktree)).toThrow();
    expect(existsSync(join(task.worktree, "..", "slot-0.lease"))).toBe(false);
    const prompts = await store.listPrompts("tfin");
    expect(prompts.some((p) => p.text.includes("finalized on main"))).toBe(true);
  }, 180_000);

  test("merged legacy task: worktree removed and pruned, branch deleted", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tleg", baseCommit));
    await Bun.write(join(task.worktree, "feat4.txt"), "work\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(git("ls-tree --name-only main")).toContain("feat4.txt");
    expect(existsSync(task.worktree)).toBe(false);
    expect(git("worktree list --porcelain")).not.toContain(task.worktree);
    expect(() => git("rev-parse --verify -q refs/heads/task/tleg")).toThrow();
  }, 180_000);

  test("finalizeTaskWork keeps branch and worktree when not merged into main", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tkeep", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "unmerged.txt"), "not on main\n");
    git("add unmerged.txt", task.worktree);
    git("commit -qm unmerged-work", task.worktree);
    git("branch task/tkeep", task.worktree);
    const outcome = await finalizeTaskWork(store, "tkeep", baseCommit);
    expect(outcome.status).toBe("kept");
    expect(git("rev-parse --verify -q refs/heads/task/tkeep")).toContain("");
    expect(existsSync(task.worktree)).toBe(true);
  }, 180_000);

  test("merged task with uncommitted secret leftover keeps slot, lease, branch and file", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tsecfin", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "feat2.txt"), "work\n");
    await Bun.write(join(task.worktree, ".env"), "SECRET=1\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(git("ls-tree --name-only main")).toContain("feat2.txt");
    expect(await Bun.file(join(task.worktree, ".env")).text()).toBe("SECRET=1\n");
    expect(existsSync(join(task.worktree, "..", "slot-0.lease"))).toBe(true);
    expect(git("rev-parse --verify -q refs/heads/task/tsecfin")).toContain("");
    // The pipeline finally must not reset the preserved secret away either.
    const fresh = await store.readTask("tsecfin");
    if (fresh) releaseWorktree(fresh);
    expect(await Bun.file(join(task.worktree, ".env")).text()).toBe("SECRET=1\n");
  }, 180_000);

  test("merged task with an unrecognised ignored file keeps slot, lease, branch and file", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    await Bun.write(join(repo, ".gitignore"), "auth.txt\n");
    git("add .gitignore");
    git("commit -qm ignore");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tign", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "feat3.txt"), "work\n");
    await Bun.write(join(task.worktree, "auth.txt"), "token\n");
    expect(await landTaskWork(store, task, () => T0)).toBe("done");
    expect(await Bun.file(join(task.worktree, "auth.txt")).text()).toBe("token\n");
    expect(existsSync(join(task.worktree, "..", "slot-0.lease"))).toBe(true);
    expect(git("rev-parse --verify -q refs/heads/task/tign")).toContain("");
  }, 180_000);

  test("allowlist matches directory segments only, never a cache substring in a file name", () => {
    expect(isAllowlistedIgnoredCarryover("node_modules/pkg/index.js")).toBe(true);
    expect(isAllowlistedIgnoredCarryover("web/foo-cache/data.bin")).toBe(true);
    expect(isAllowlistedIgnoredCarryover("cache/data.bin")).toBe(true);
    expect(isAllowlistedIgnoredCarryover("auth.txt")).toBe(false);
    expect(isAllowlistedIgnoredCarryover("my-cache-token.json")).toBe(false);
    expect(isAllowlistedIgnoredCarryover("cachebearer/data.bin")).toBe(false);
    expect(isAllowlistedIgnoredCarryover("data/auth.txt")).toBe(false);
  });

  test("releaseWorktree keeps a parked task's slot, lease and contents", async () => {
    const { repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tpark", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "wip.txt"), "unfinished\n");
    releaseWorktree({
      ...task,
      state: "needs-input",
    });
    expect(await Bun.file(join(task.worktree, "wip.txt")).text()).toBe("unfinished\n");
    expect(existsSync(join(task.worktree, "..", "slot-0.lease"))).toBe(true);
  }, 180_000);
});

describe("finalize: agent merge resolution", () => {
  test("merge conflict at finish is resolved by a fixer agent automatically", async () => {
    const { base, repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tres", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const stub = await resolverStubFor(base, false);
    const outcome = await landTaskWork(store, task, () => T0, {
      agent: {
        store,
        command: [
          "bun",
          stub,
        ],
      },
    });
    expect(outcome).toBe("done");
    expect(git("show main:a.txt")).toContain("main version");
    expect(git("show main:a.txt")).toContain("task version");
    const cards = await store.listCards("tres");
    expect(cards.map((c) => c.id)).toContain("merge-resolver");
  }, 180_000);

  test("one-sided agent resolution parks and leaves main unmoved", async () => {
    const { base, repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("toneside", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const mainBefore = git("rev-parse main").trim();
    const stub = await resolverStubFor(base, true);
    const outcome = await landTaskWork(store, task, () => T0, {
      agent: {
        store,
        command: [
          "bun",
          stub,
        ],
      },
    });
    expect(outcome).toBe("parked");
    expect(git("rev-parse main").trim()).toBe(mainBefore);
    expect(git("status --porcelain --untracked-files=no")).toBe("");
    expect(existsSync(join(repo, ".git/MERGE_HEAD"))).toBe(false);
  }, 180_000);

  test("merge conflict in a secret-like file never spawns the agent", async () => {
    const { base, repo, store } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    await Bun.write(join(repo, ".env"), "SECRET=base\n");
    git("add .env");
    git("commit -qm env-base");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tsecconf", baseCommit), {
      maxParallelTasks: 1,
    });
    await Bun.write(join(task.worktree, ".env"), "SECRET=task\n");
    git("add .env", task.worktree);
    git("commit -qm task-env", task.worktree);
    await Bun.write(join(repo, ".env"), "SECRET=main\n");
    git("add .env");
    git("commit -qm main-env");
    const stub = await resolverStubFor(base, false);
    const outcome = await landTaskWork(store, task, () => T0, {
      agent: {
        store,
        command: [
          "bun",
          stub,
        ],
      },
    });
    expect(outcome).toBe("parked");
    expect(git("show main:.env").trim()).toBe("SECRET=main");
    const cards = await store.listCards("tsecconf");
    expect(cards.map((c) => c.id)).not.toContain("merge-resolver");
  }, 180_000);
});

describe("finalize: decisions gate over agent resolution", () => {
  test("merge conflict with unacknowledged decisions change parks without spawning the agent or moving main", async () => {
    const { repo, store, stub } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    await Bun.write(join(repo, "decisions.md"), "# Decisions\n- rule one\n");
    git("add decisions.md");
    git("commit -qm decisions-base");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tdecconf", baseCommit));
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(task.worktree, "decisions.md"), "# Decisions\n- rule one\n- task rule\n");
    git("add a.txt decisions.md", task.worktree);
    git("commit -qm task-work", task.worktree);
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    const mainBefore = git("rev-parse main").trim();
    const outcome = await landTaskWork(store, task, () => T0, {
      agent: {
        store,
        command: [
          "bun",
          stub,
        ],
      },
    });
    expect(outcome).toBe("parked");
    // Owner gate wins over agent resolution: no resolver spawned, main unmoved.
    expect(git("rev-parse main").trim()).toBe(mainBefore);
    expect(git("show main:decisions.md")).toContain("- rule one");
    expect(git("show main:decisions.md")).not.toContain("- task rule");
    expect(git("status --porcelain --untracked-files=no")).toBe("");
    expect(existsSync(join(repo, ".git/MERGE_HEAD"))).toBe(false);
    const cards = await store.listCards("tdecconf");
    expect(cards.map((c) => c.id)).not.toContain("merge-resolver");
    const prompts = await store.listPrompts("tdecconf");
    expect(prompts.some((p) => p.text.includes("decisions change in decisions.md"))).toBe(true);
  }, 180_000);

  test("isolated merge conflict with unacknowledged decisions change parks without spawning the agent or moving main", async () => {
    const { repo, store, stub } = await setup();
    const git = gitInRepo(repo);
    git("branch -M main");
    await Bun.write(join(repo, "decisions.md"), "# Decisions\n- rule one\n");
    await Bun.write(join(repo, "other.txt"), "other\n");
    git("add decisions.md other.txt");
    git("commit -qm decisions-base");
    const baseCommit = git("rev-parse HEAD").trim();
    const task = await prepareWorktree(store, mkLandingTask("tdeciso", baseCommit));
    await Bun.write(join(task.worktree, "a.txt"), "task version\n");
    await Bun.write(join(task.worktree, "decisions.md"), "# Decisions\n- rule one\n- task rule\n");
    git("add a.txt decisions.md", task.worktree);
    git("commit -qm task-work", task.worktree);
    await Bun.write(join(repo, "a.txt"), "main version\n");
    git("add a.txt");
    git("commit -qm main-version");
    // Dirty main checkout forces the isolated merge path.
    await Bun.write(join(repo, "other.txt"), "owner dirty work\n");
    const mainBefore = git("rev-parse main").trim();
    const outcome = await landTaskWork(store, task, () => T0, {
      agent: {
        store,
        command: [
          "bun",
          stub,
        ],
      },
    });
    expect(outcome).toBe("parked");
    expect(git("rev-parse main").trim()).toBe(mainBefore);
    expect(git("show main:decisions.md")).not.toContain("- task rule");
    expect(await Bun.file(join(repo, "other.txt")).text()).toBe("owner dirty work\n");
    const cards = await store.listCards("tdeciso");
    expect(cards.map((c) => c.id)).not.toContain("merge-resolver");
    const prompts = await store.listPrompts("tdeciso");
    expect(prompts.some((p) => p.text.includes("decisions change in decisions.md"))).toBe(true);
  }, 180_000);
});

describe("owner questions in a revised plan", () => {
  test("reads the bullet list under the section, and None means none", () => {
    expect(ownerQuestions("# Plan\n## Questions for the owner\n- A?\n- B?\n")).toEqual([
      "A?",
      "B?",
    ]);
    expect(ownerQuestions("# Plan\n## Questions for the owner\nNone\n")).toEqual([]);
    expect(ownerQuestions("# Plan\n## Questions for the owner\n- None\n")).toEqual([]);
    expect(ownerQuestions("# Plan without the section\n- not a question\n")).toEqual([]);
    expect(ownerQuestions("## Questions for the owner\n- A?\n## Later\n- not this\n")).toEqual([
      "A?",
    ]);
  }, 120_000);

  test("an answered question never comes back, even reworded by punctuation or case", () => {
    const plan =
      "# Plan\n## Questions for the owner\n- Should the hello service be public?\n- A genuinely new question?\n";
    expect(
      ownerQuestions(plan, [
        "Should the hello service be public?",
      ]),
    ).toEqual([
      "A genuinely new question?",
    ]);
    expect(
      ownerQuestions(plan, [
        "should the hello service be public",
      ]),
    ).toEqual([
      "A genuinely new question?",
    ]);
    expect(ownerQuestions(plan, [])).toEqual([
      "Should the hello service be public?",
      "A genuinely new question?",
    ]);
  }, 120_000);

  test("a reworded re-ask of a settled topic is filtered; a new topic is not", () => {
    const settled = [
      "Should the committed baseline live at `docs/decision-conflict-baseline.md`, or at another owner-named committed location?",
    ];
    expect(
      isSettledQuestion(
        "Should the committed baseline and backfill live at docs/decision-conflict-baseline.md or at another owner-named committed location?",
        settled,
      ),
    ).toBe(true);
    expect(
      isSettledQuestion(
        "Should the baseline report also count cases where both reviewers rejected the same feature?",
        settled,
      ),
    ).toBe(false);
    const plan =
      "# Plan\n## Questions for the owner\n- Should the committed baseline and backfill live at docs/decision-conflict-baseline.md or at another owner-named committed location?\n- Should the report be published outside the publish scan?\n";
    expect(ownerQuestions(plan, settled)).toEqual([
      "Should the report be published outside the publish scan?",
    ]);
  }, 120_000);

  test("settled questions persist on the task and survive later planning cycles", async () => {
    const { base, store } = await setup();
    const stub = join(base, "stub-settled.ts");
    await Bun.write(
      stub,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Triage this task")) text = "TRIAGE lane=standard size=M redteams=2 risks=none est=~8 stations\\nmoderate";`,
        `else if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nDo the thing.\\n## Approach\\nSmall steps.\\n## Success criteria\\nbun test passes\\n"); text = "PLAN_WRITTEN"; }`,
        `else if (prompt.includes("Red-team this plan as a subject-matter expert")) { const flag = join(cwd, ".sme-rejected"); if (!existsSync(flag)) { writeFileSync(flag, "1"); text = "REJECT missing a test\\nArgument: no test is named"; } else text = "PASS sme ok\\nArgument: the test is named now"; }`,
        `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\nArgument: why-now holds";`,
        `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, with a test.\\n## Red-team decisions\\nCHANGED: add a test (sme)\\nOWNER: is the hello service public?\\n## Questions for the owner\\n- Should the hello service be public?\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("The owner answered your open questions")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, public.\\n## Red-team decisions\\nCHANGED: made public per owner\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
        `else if (prompt.includes("commented on individual lines")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nDo the thing, per comments.\\n## Red-team decisions\\nCHANGED: applied comments\\n## Questions for the owner\\n- Should the hello service be public?\\n"); text = "PLAN_REVISED"; }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-st" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      tags: [
        "css",
      ],
    };
    await store.writeTask(task);
    await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    const answered = await answerPlanQuestions("t1", "1. yes, public", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(answered.planQuestions).toEqual([]);
    expect(answered.settledQuestions).toEqual([
      "Should the hello service be public?",
    ]);
    // A later line-comment cycle re-runs the review; the reviser re-emits the
    // settled question and it still cannot come back.
    const commented = await commentOnPlan("t1", 'Line 1: "x"\nOwner comment: keep it', {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(commented.planQuestions).toEqual([]);
    expect(commented.settledQuestions).toEqual([
      "Should the hello service be public?",
    ]);
    const reviser = (await store.listCards("t1")).find((c) => c.id === "plan-reviser");
    expect(reviser?.task).toContain("SETTLED OWNER DECISIONS");
  }, 60_000);
});

describe("verify-command safety gate", () => {
  test("only simple single commands auto-run; shell-shaped ones are refused", () => {
    expect(isSafeVerifyCommand("true")).toBe(true);
    expect(isSafeVerifyCommand("bun test")).toBe(true);
    expect(isSafeVerifyCommand("npm run test")).toBe(true);
    expect(isSafeVerifyCommand("./scripts/check.sh --verbose")).toBe(true);
    expect(isSafeVerifyCommand("bun test; rm -rf /tmp/x")).toBe(false);
    expect(isSafeVerifyCommand("echo $(cat .env)")).toBe(false);
    expect(isSafeVerifyCommand("rm -rf /tmp/x | sh")).toBe(false);
    expect(isSafeVerifyCommand("curl http://x && bash")).toBe(false);
    expect(isSafeVerifyCommand("cat `id`")).toBe(false);
    expect(isSafeVerifyCommand("echo 'hi'")).toBe(false);
    expect(isSafeVerifyCommand("")).toBe(false);
  }, 120_000);

  test("prose detection: real check commands never look like sentences, sentences do", () => {
    // Commands: single programs with optional args, flags, paths.
    expect(looksLikeProse("bun test")).toBe(false);
    expect(looksLikeProse("npm run build")).toBe(false);
    expect(looksLikeProse("pytest tests/test_x.py")).toBe(false);
    expect(looksLikeProse("docker compose up -d")).toBe(false);
    expect(looksLikeProse("npm ci && npm test")).toBe(false); // compound, not prose
    expect(looksLikeProse("true")).toBe(false); // the escape hatch stays trusted
    // Sentences: stopword-led or four-plus plain words with no markers.
    expect(looksLikeProse("file selector allows navigation")).toBe(true);
    expect(looksLikeProse("the file selector allows navigation")).toBe(true);
    expect(looksLikeProse("add a test for this")).toBe(true);
    expect(looksLikeProse("run the test suite")).toBe(true);
    expect(looksLikeProse("")).toBe(false);
  }, 120_000);

  test("default verify: per-stack detection, and the JS contract still requires a verify script", async () => {
    const base = mkdtempSync(join(tmpdir(), "dispatch-default-verify-"));

    const bunGate = join(base, "bun-gate");
    await Bun.write(
      join(bunGate, "package.json"),
      JSON.stringify({
        scripts: {
          verify: "bun run typecheck && bun test",
        },
      }),
    );
    await Bun.write(join(bunGate, "bun.lock"), "");
    expect(defaultVerifyCommand(bunGate)).toBe("bun run verify");

    // A verify script without a lockfile runs under npm.
    const npmGate = join(base, "npm-gate");
    await Bun.write(
      join(npmGate, "package.json"),
      JSON.stringify({
        scripts: {
          verify: "npm run typecheck && npm test",
        },
      }),
    );
    expect(defaultVerifyCommand(npmGate)).toBe("npm run verify");

    // No verify script: the project states no gate, even with a biome config.
    const noScript = join(base, "no-script");
    await Bun.write(
      join(noScript, "package.json"),
      JSON.stringify({
        scripts: {
          test: "bun test",
        },
      }),
    );
    await Bun.write(join(noScript, "biome.json"), "{}");
    expect(defaultVerifyCommand(noScript)).toBe("");

    // Compiled and interpreted stacks get their canonical check command.
    const cargoRepo = join(base, "cargo");
    mkdirSync(cargoRepo, {
      recursive: true,
    });
    await Bun.write(join(cargoRepo, "Cargo.toml"), '[package]\nname = "t"\nversion = "0.1.0"\n');
    expect(defaultVerifyCommand(cargoRepo)).toBe("cargo test");

    const goRepo = join(base, "go");
    mkdirSync(goRepo, {
      recursive: true,
    });
    await Bun.write(join(goRepo, "go.mod"), "module example.com/t\n");
    expect(defaultVerifyCommand(goRepo)).toBe("go test ./...");

    const pyRepo = join(base, "py");
    mkdirSync(pyRepo, {
      recursive: true,
    });
    await Bun.write(join(pyRepo, "requirements.txt"), "pytest==8\n");
    expect(defaultVerifyCommand(pyRepo)).toBe("pytest");

    const noPackage = join(base, "no-package");
    mkdirSync(noPackage, {
      recursive: true,
    });
    expect(defaultVerifyCommand(noPackage)).toBe("");
    expect(defaultVerifyCommand(join(base, "missing"))).toBe("");
    rmSync(base, {
      recursive: true,
      force: true,
    });
  }, 120_000);

  test("an unsafe builder-named verify command parks for the owner, not auto-run", async () => {
    const { base, store } = await setup();
    const stub = join(base, "unsafe-verify-stub.ts");
    await Bun.write(
      stub,
      [
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `let text = "built";`,
        `if (prompt.includes("is not runnable")) text = "found it\\nVERIFY: echo $(cat .env) > /tmp/x";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-u" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    let task = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "add hello service",
        },
        T0,
      ),
      verifyCommand: "unnameable check please",
    };
    task = approvePlan(draftPlan(task, "plan", T0), T0);
    await store.writeTask(task);
    const stuck = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxIterations: 3,
    });
    expect(stuck.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("not a safe single command"))).toBe(true);
  }, 60_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("final verify gate before done", () => {
  const passStub = (base: string) => join(base, "final-verify-stub.ts");
  async function writePassStub(base: string): Promise<string> {
    const stub = passStub(base);
    await Bun.write(
      stub,
      [
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `let text = "built";`,
        `if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nArgument: matches plan";`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: clean diff";`,
        `else if (prompt.includes("Judge a deadlocked review")) text = "OWNER final verify must pass first";`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-fv" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    return stub;
  }

  test("effective verify: task command wins, else CI-derived package checks, else none", async () => {
    const { repo } = await setup();
    await Bun.write(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: {
          test: "bun test",
          lint: "true",
        },
      }),
    );
    const withCmd = {
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "x",
        },
        T0,
      ),
      verifyCommand: "true",
    };
    expect(effectiveVerifyCommand(withCmd, repo)).toBe("true");
    expect(
      effectiveVerifyCommand(
        newTask(
          {
            id: "t2",
            projectId: "p1",
            title: "t2",
            prompt: "x",
          },
          T0,
        ),
        repo,
      ),
    ).toBe("bun run test && bun run lint");
    expect(
      effectiveVerifyCommand(
        newTask(
          {
            id: "t3",
            projectId: "p1",
            title: "t3",
            prompt: "x",
          },
          T0,
        ),
        "",
      ),
    ).toBe("");
  });

  test("the project's stated gate outranks the CI-derived suggestion, so loop and final gate agree", async () => {
    const { base, repo } = await setup();
    await Bun.write(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: {
          test: "bun test",
          lint: "true",
        },
      }),
    );
    const stated = join(base, "stated-gate");
    await Bun.write(
      join(stated, "package.json"),
      JSON.stringify({
        scripts: {
          verify: "bun run typecheck && bun test",
        },
      }),
    );
    await Bun.write(join(stated, "bun.lock"), "");
    const t = newTask(
      {
        id: "tg",
        projectId: "p1",
        title: "tg",
        prompt: "x",
      },
      T0,
    );
    // The worktree states its gate: chosen even when a CI-derived command
    // exists for the repo, because it is what the builder loop already ran.
    expect(
      effectiveVerifyCommand(
        {
          ...t,
          worktree: stated,
        },
        repo,
      ),
    ).toBe("bun run verify");
    // The builder loop's chooser is the same function (no CI analysis there).
    expect(
      effectiveVerifyCommand(
        {
          ...t,
          worktree: stated,
        },
        "",
      ),
    ).toBe("bun run verify");
    // Worktree released: the CI-derived suggestion is what is left.
    expect(effectiveVerifyCommand(t, repo)).toBe("bun run test && bun run lint");
  });

  test("a task with no verify command is not done while the CI-derived checks fail", async () => {
    const { base, repo, store } = await setup();
    await Bun.write(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: {
          test: "false",
        },
      }),
    );
    execSync(
      "git -c user.name=t -c user.email=t@t add package.json && git -c user.name=t -c user.email=t@t commit -qm pkg",
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    const stub = await writePassStub(base);
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const stuck = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxReviewRounds: 0,
    });
    expect(stuck.state).not.toBe("done");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("final verify failed"))).toBe(true);
  });

  test("a task with no verify command is done only after the CI-derived checks pass", async () => {
    const { base, repo, store } = await setup();
    await Bun.write(
      join(repo, "package.json"),
      JSON.stringify({
        scripts: {
          test: "true",
        },
      }),
    );
    execSync(
      "git -c user.name=t -c user.email=t@t add package.json && git -c user.name=t -c user.email=t@t commit -qm pkg",
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    const stub = await writePassStub(base);
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add hello service",
          },
          T0,
        ),
        "plan",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
      maxReviewRounds: 0,
    });
    expect(done.state).toBe("done");
    expect((await store.readTask("t1"))?.verifyCommand).toBe("bun run test");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("final verify passed"))).toBe(true);
  });
});

describe("tradeoff gate at the merge gate", () => {
  test("an expensive path without a recorded tradeoff parks for the owner", async () => {
    const { base, store } = await setup();
    const stub = join(base, "tradeoff-stub.ts");
    await Bun.write(
      stub,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nArgument: matches plan";`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: clean diff";`,
        `else { mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, "src", "server.ts"), "touch\\n"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-t" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add server endpoint",
          },
          T0,
        ),
        "plan with no options",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const parked = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(parked.state).toBe("needs-input");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("tradeoff gate") && p.text.includes("server"))).toBe(
      true,
    );
  }, 60_000);

  test("a missing tradeoff is recorded by the planner automatically and the work proceeds", async () => {
    const { base, store } = await setup();
    const stub = join(base, "tradeoff-stub2.ts");
    await Bun.write(
      stub,
      [
        `import { mkdirSync, writeFileSync } from "node:fs";`,
        `import { join } from "node:path";`,
        `const prompt = process.argv[process.argv.length - 1] ?? "";`,
        `const cwd = process.cwd();`,
        `let text = "built";`,
        `if (prompt.includes("Review as a subject-matter expert")) text = "PASS sme ok\\nArgument: matches plan";`,
        `else if (prompt.includes("Review as a code reviewer")) text = "PASS coder ok\\nArgument: clean diff";`,
        `else if (prompt.includes("touches expensive path(s)")) text = "## Tradeoffs\\nOption 1 (taken): a plain endpoint on the existing server — cheap, reuses routing. Option 2 (alternative): a separate service — isolated, but new ops burden. The taken option wins on cost.";`,
        `else { mkdirSync(join(cwd, "src"), { recursive: true }); writeFileSync(join(cwd, "src", "server.ts"), "touch\\n"); }`,
        `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-t2" }, payload_type: "run.terminal.completed", payload: { text } }));`,
      ].join("\n"),
    );
    const task = approvePlan(
      draftPlan(
        newTask(
          {
            id: "t1",
            projectId: "p1",
            title: "t1",
            prompt: "add server endpoint",
          },
          T0,
        ),
        "plan with no options",
        T0,
      ),
      T0,
    );
    await store.writeTask(task);
    const done = await runTaskPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(done.state).toBe("done");
    expect(done.plan).toContain("## Tradeoffs");
    const prompts = await store.listPrompts("t1");
    expect(prompts.some((p) => p.text.includes("tradeoff auto-record"))).toBe(true);
  }, 60_000);
});

describe("needs-input escalation webhook", () => {
  test("fires once when a webhook URL is set, silent otherwise", async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push(await req.text());
        return new Response("ok");
      },
    });
    const prev = process.env.DASHBOARD_WEBHOOK_URL;
    process.env.DASHBOARD_WEBHOOK_URL = `http://127.0.0.1:${server.port}`;
    try {
      await notifyNeedsInput("t1", "pickup paused: DECISIONS.md changed");
      await Bun.sleep(100); // let the fetch land
    } finally {
      process.env.DASHBOARD_WEBHOOK_URL = prev;
      server.stop();
    }
    expect(received.length).toBe(1);
    const payload = JSON.parse(received[0] ?? "{}") as {
      event?: string;
      taskId?: string;
      reason?: string;
    };
    expect(payload.event).toBe("needs-input");
    expect(payload.taskId).toBe("t1");
    expect(payload.reason).toContain("DECISIONS.md");
  }, 120_000);
});
