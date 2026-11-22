import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerPlanQuestions, runPlanPipeline } from "./dispatch";
import { FactoryStore } from "./store";
import { newTask } from "./task";

const T0 = "2026-10-22T10:00:00.000Z";

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "deferred-pipe-"));
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
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add a.txt");
  git("commit -qm one");
  const store = new FactoryStore(join(base, "store"));
  await store.registerProject("p1", repo);
  const stub = join(base, "stub.ts");
  await Bun.write(
    stub,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { join } from "node:path";`,
      `const prompt = process.argv[process.argv.length - 1] ?? "";`,
      `const cwd = process.cwd();`,
      `let text = "ok";`,
      `if (prompt.includes("Write the implementation plan")) { writeFileSync(join(cwd, "PLAN-DRAFT.md"), "# Intent\\nImprove checkout.\\n## Why\\nNeeded.\\n## Approach\\nSmall steps.\\n## Success criteria\\ntests pass\\n"); text = "PLAN_WRITTEN"; }`,
      `else if (prompt.includes("The owner answered your open questions")) { const m = prompt.match(/\\[deferred:([^\\]]+)\\]/); writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nImprove checkout.\\n## Approach\\nSmall steps.\\n## Deferred points included\\n- [deferred:" + (m?.[1] ?? "none") + "] add a loading spinner to the checkout page\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
      `else if (prompt.includes("Two red-teams reviewed your plan")) { writeFileSync(join(cwd, "PLAN-REVISED.md"), "# Intent\\nRevised.\\n## Questions for the owner\\nNone\\n"); text = "PLAN_REVISED"; }`,
      `else if (prompt.includes("Red-team this plan as a subject-matter expert")) text = "REJECT sme has one small point\\n- MINOR: add a loading spinner to the checkout page";`,
      `else if (prompt.includes("Red-team this plan as an outside reviewer")) text = "PASS outsider ok\\n- MINOR: add a loading spinner to the checkout page";`,
      `console.log(JSON.stringify({ stream: { kind: "session", id: "sess-1" }, payload_type: "run.terminal.completed", payload: { text } }));`,
    ].join("\n"),
  );
  return {
    base,
    repo,
    store,
    stub,
  };
}

describe("deferred minor red-team points", () => {
  test("minor-only rejection accepts the plan without a reviser and defers the point", async () => {
    const { store, stub } = await setup();
    await store.writeTask({
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "Checkout page",
          prompt: "build the checkout page",
        },
        T0,
      ),
      tags: [
        "ui",
      ],
    });
    const drafted = await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.plan).toContain("Intent");
    const cards = await store.listCards("t1");
    expect(cards.map((c) => c.id)).not.toContain("plan-reviser");
    const deferred = await store.listDeferred("p1");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.text).toContain("loading spinner");
    expect(deferred[0]?.status).toBe("open");
    expect((await store.listPrompts("t1")).some((p) => p.text.includes("only minor points"))).toBe(
      true,
    );
  }, 120_000);

  test("a related later task is asked about the deferred point, and include closes it", async () => {
    const { store, stub } = await setup();
    await store.writeTask({
      ...newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "Checkout page",
          prompt: "build the checkout page",
        },
        T0,
      ),
      tags: [
        "ui",
      ],
    });
    await runPlanPipeline("t1", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    await store.writeTask({
      ...newTask(
        {
          id: "t2",
          projectId: "p1",
          title: "Checkout polish",
          prompt: "polish the checkout page loading state and spinner behaviour",
        },
        T0,
      ),
      tags: [
        "ui",
      ],
    });
    const drafted = await runPlanPipeline("t2", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(drafted.planQuestions.join("\n")).toContain("[deferred:def-t1-0]");
    expect(drafted.plan).toContain("Deferred minor points offered");
    // Owner answers include -> reviser folds it in with the marker -> factory closes the point.
    const answered = await answerPlanQuestions("t2", "include the deferred spinner point", {
      store,
      command: [
        "bun",
        stub,
      ],
      now: () => T0,
    });
    expect(answered.plan).toContain("Deferred points included");
    const deferred = await store.listDeferred("p1");
    expect(deferred[0]?.status).toBe("included");
    expect(deferred[0]?.includedInTaskId).toBe("t2");
  }, 120_000);
});
