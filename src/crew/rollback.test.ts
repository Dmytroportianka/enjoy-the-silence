import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryPendingPushes } from "./dispatch";
import { findFactoryMerges, rollbackEligibility, rollbackTask } from "./rollback";
import { FactoryStore } from "./store";
import { approvePlan, draftPlan, newTask, type Task, transitionTask } from "./task";

const T0 = "2026-10-22T10:00:00.000Z";
const T1 = "2026-10-22T10:01:00.000Z";
const T2 = "2026-10-22T10:02:00.000Z";
const T3 = "2026-10-22T10:10:00.000Z";

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "rollback-"));
  const repo = join(base, "app");
  mkdirSync(repo, {
    recursive: true,
  });
  const git = (args: string) =>
    execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  git("init -q");
  git("config user.name t");
  git("config user.email t@t");
  await Bun.write(join(repo, "a.txt"), "one\n");
  git("add a.txt");
  git("commit -qm one");
  git("branch -M main");
  const store = new FactoryStore(join(base, "store"));
  await store.registerProject("p1", repo);
  return {
    base,
    repo,
    store,
    git,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function doneTask(id: string): Task {
  const approved = approvePlan(
    draftPlan(
      newTask(
        {
          id,
          projectId: "p1",
          title: id,
          prompt: `do ${id}`,
        },
        T0,
      ),
      "plan",
      T0,
    ),
    T0,
  );
  return transitionTask(
    transitionTask(transitionTask(approved, "running", T0), "in-review", T1),
    "done",
    T2,
  );
}

/** A factory-style landing: branch work merged with the landing subject, pushed when an origin exists. */
async function landMerge(s: Setup, taskId: string, file: string, content: string) {
  s.git(`checkout -qb task/${taskId}`);
  await Bun.write(join(s.repo, file), content);
  s.git(`add ${file}`);
  s.git(`commit -qm "task ${taskId}: work"`);
  s.git("checkout -q main");
  s.git(`merge --no-ff -q task/${taskId} -m "merge task/${taskId}: ${taskId}"`);
}

describe("rollbackTask (revert a done task's merge and push)", () => {
  test("reverts the merge, pushes, stays done and marked rolled back", async () => {
    const s = await setup();
    const bare = join(s.base, "origin.git");
    s.git(`init --bare -q ${bare}`);
    s.git(`remote add origin ${bare}`);
    s.git("push -q origin main");
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    s.git("push -q origin main");

    const result = await rollbackTask(s.store, "t1", () => T3);
    expect(result.status).toBe("rolled-back");
    expect(result.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.revertCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(s.git("ls-tree --name-only main")).not.toContain("feat.txt");
    // History is never rewritten: the merge is still there, undone by a revert on top.
    expect(s.git("log --oneline main")).toContain("merge task/t1: t1");
    expect(s.git("log --oneline -1 main")).toContain("Revert");
    expect(s.git("rev-parse main").trim()).toBe(
      s.git(`ls-remote origin main`).split(/\s+/)[0] ?? "",
    );
    const fresh = await s.store.readTask("t1");
    expect(fresh?.state).toBe("done");
    expect(fresh?.rolledBackAt).toBe(T3);
    expect(fresh?.revertCommit).toBe(result.revertCommit);
    expect(fresh?.mainPushPending).toBeNull();
    expect((await s.store.listPrompts("t1")).some((p) => p.text.startsWith("rollback:"))).toBe(
      true,
    );
    // A second rollback is refused: the task is already rolled back.
    await expect(rollbackTask(s.store, "t1", () => T3)).rejects.toThrow("already rolled back");
    expect((await s.store.readTask("t1"))?.revertCommit).toBe(result.revertCommit);
  }, 60_000);

  test("refuses a dirty checkout and mutates nothing", async () => {
    const s = await setup();
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    await Bun.write(join(s.repo, "a.txt"), "uncommitted\n");
    const head = s.git("rev-parse HEAD");

    await expect(rollbackTask(s.store, "t1", () => T3)).rejects.toThrow("uncommitted work");
    expect(s.git("rev-parse HEAD")).toBe(head);
    expect((await s.store.readTask("t1"))?.rolledBackAt).toBe("");
    expect((await s.store.readTask("t1"))?.revertCommit).toBe("");
  }, 60_000);

  test("refuses when the checkout is not on main and mutates nothing", async () => {
    const s = await setup();
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    s.git("checkout -qb side");
    const head = s.git("rev-parse HEAD");

    await expect(rollbackTask(s.store, "t1", () => T3)).rejects.toThrow("not on main");
    expect(s.git("rev-parse HEAD")).toBe(head);
    // The eligibility check itself must not move the checkout: still on side.
    expect(s.git("branch --show-current")).toBe("side");
    expect((await s.store.readTask("t1"))?.rolledBackAt).toBe("");
  }, 60_000);
});

describe("rollback refusals leave main and the record untouched", () => {
  test("refuses branch-only and hand-merged work: no factory merge, nothing to revert", async () => {
    const s = await setup();
    // Branch-only: work committed on task/t2 but never merged.
    await s.store.writeTask(doneTask("t2"));
    s.git("checkout -qb task/t2");
    await Bun.write(join(s.repo, "branch.txt"), "x\n");
    s.git("add branch.txt");
    s.git('commit -qm "task t2: work"');
    s.git("checkout -q main");
    // Hand-merged: merged without the factory landing subject.
    await s.store.writeTask(doneTask("t3"));
    s.git("checkout -qb task/t3");
    await Bun.write(join(s.repo, "hand.txt"), "y\n");
    s.git("add hand.txt");
    s.git('commit -qm "task t3: work"');
    s.git("checkout -q main");
    s.git('merge --no-ff -q task/t3 -m "hand merge of t3 work"');

    expect(findFactoryMerges(s.repo, "t2")).toEqual([]);
    expect(findFactoryMerges(s.repo, "t3")).toEqual([]);
    const head = s.git("rev-parse HEAD");
    await expect(rollbackTask(s.store, "t2", () => T3)).rejects.toThrow("no factory merge");
    await expect(rollbackTask(s.store, "t3", () => T3)).rejects.toThrow("no factory merge");
    expect(s.git("rev-parse HEAD")).toBe(head);
  }, 60_000);

  test("refuses ambiguous merges: two factory merges for one task", async () => {
    const s = await setup();
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    s.git("checkout -q task/t1");
    await Bun.write(join(s.repo, "more.txt"), "again\n");
    s.git("add more.txt");
    s.git('commit -qm "task t1: more work"');
    s.git("checkout -q main");
    s.git('merge --no-ff -q task/t1 -m "merge task/t1: t1"');
    expect(findFactoryMerges(s.repo, "t1")).toHaveLength(2);

    const head = s.git("rev-parse HEAD");
    await expect(rollbackTask(s.store, "t1", () => T3)).rejects.toThrow("ambiguous");
    expect(s.git("rev-parse HEAD")).toBe(head);
    expect((await s.store.readTask("t1"))?.rolledBackAt).toBe("");
  }, 60_000);

  test("a conflicting revert aborts and mutates nothing", async () => {
    const s = await setup();
    await s.store.writeTask(doneTask("t1"));
    s.git("checkout -qb task/t1");
    await Bun.write(join(s.repo, "a.txt"), "t-one\n");
    s.git("add a.txt");
    s.git('commit -qm "task t1: work"');
    s.git("checkout -q main");
    s.git('merge --no-ff -q task/t1 -m "merge task/t1: t1"');
    // Main moves the same line after the merge: reverting now conflicts.
    await Bun.write(join(s.repo, "a.txt"), "main-line\n");
    s.git("add a.txt");
    s.git('commit -qm "main moves on"');
    const head = s.git("rev-parse HEAD");
    const promptsBefore = await s.store.listPrompts("t1");

    await expect(rollbackTask(s.store, "t1", () => T3)).rejects.toThrow("revert conflict");
    expect(s.git("rev-parse HEAD")).toBe(head);
    expect(s.git("status --porcelain --untracked-files=no")).toBe("");
    const fresh = await s.store.readTask("t1");
    expect(fresh?.rolledBackAt).toBe("");
    expect(fresh?.revertCommit).toBe("");
    expect(await s.store.listPrompts("t1")).toEqual(promptsBefore);
  }, 60_000);
});

describe("rollback eligibility and the owed-push retry", () => {
  test("non-done tasks are ineligible; done tasks with a merge are eligible", async () => {
    const s = await setup();
    const planned = newTask(
      {
        id: "t9",
        projectId: "p1",
        title: "t9",
        prompt: "do t9",
      },
      T0,
    );
    expect(rollbackEligibility(s.repo, planned).eligible).toBe(false);
    expect(rollbackEligibility(s.repo, planned).reason).toContain("not done");
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    const check = rollbackEligibility(s.repo, (await s.store.readTask("t1"))!);
    expect(check.eligible).toBe(true);
    expect(check.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test("failed main push is held with the push owed; the retry sweep delivers it and the task stays done", async () => {
    const s = await setup();
    const bare = join(s.base, "origin.git");
    s.git(`init --bare -q ${bare}`);
    s.git(`remote add origin ${bare}`);
    s.git("push -q origin main");
    await s.store.writeTask(doneTask("t1"));
    await landMerge(s, "t1", "feat.txt", "hi\n");
    s.git("push -q origin main");
    // Break pushes: the revert lands locally, the push is owed.
    s.git(`remote set-url origin ${join(s.base, "missing.git")}`);

    const result = await rollbackTask(s.store, "t1", () => T2);
    expect(result.status).toBe("held");
    expect(s.git("ls-tree --name-only main")).not.toContain("feat.txt");
    const held = await s.store.readTask("t1");
    expect(held?.state).toBe("done");
    expect(held?.rolledBackAt).toBe(T2);
    expect(held?.revertCommit).toBe(result.revertCommit);
    expect(held?.mainPushPending?.commit).toBe(result.revertCommit);

    // Restore origin: the sweep admits the done task and pushes the revert.
    s.git(`remote set-url origin ${bare}`);
    const retried = await retryPendingPushes(s.store, () => T3);
    expect(retried).toContain("t1");
    const after = await s.store.readTask("t1");
    expect(after?.state).toBe("done");
    expect(after?.mainPushPending).toBeNull();
    expect(after?.rolledBackAt).toBe(T2);
    expect(s.git("rev-parse main").trim()).toBe(
      s.git("ls-remote origin main").split(/\s+/)[0] ?? "",
    );
  }, 120_000);
});
