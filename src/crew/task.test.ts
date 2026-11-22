import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryStore } from "./store";
import {
  approvePlan,
  coderPersona,
  deriveTitle,
  draftPlan,
  findDuplicateTask,
  newTask,
  type Project,
  priorityRank,
  queuedTasks,
  selectDispatch,
  selectPlanDispatch,
  smePersona,
  type Task,
  tierFor,
  transitionTask,
} from "./task";

const T0 = "2026-10-22T10:00:00.000Z";
const T1 = "2026-10-22T10:01:00.000Z";
const T2 = "2026-10-22T10:02:00.000Z";

function approved(id: string, createdAt: string, projectId = "p1"): Task {
  const t = newTask(
    {
      id,
      projectId,
      title: id,
      prompt: `do ${id}`,
    },
    createdAt,
  );
  return approvePlan(draftPlan(t, `plan for ${id}`, createdAt), createdAt);
}

describe("task plan gate (approve plan, then best effort)", () => {
  test("planned task cannot run before its plan is approved", () => {
    const t = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    expect(t.state).toBe("planned");
    expect(t.planState).toBe("none");
    expect(() => transitionTask(t, "running", T1)).toThrow("before the plan is approved");
    expect(() => approvePlan(t, T1)).toThrow("no drafted plan");
    const drafted = draftPlan(t, "1. add route 2. test", T1);
    expect(() => transitionTask(drafted, "running", T1)).toThrow("before the plan is approved");
    const ok = transitionTask(approvePlan(drafted, T1), "running", T2);
    expect(ok.state).toBe("running");
  });

  test("a drafted plan is pinned to the commit it was drafted against", () => {
    const t = newTask(
      {
        id: "t1",
        projectId: "p1",
        title: "t1",
        prompt: "add hello service",
      },
      T0,
    );
    const drafted = draftPlan(t, "1. add route 2. test", T1, [], "abc1234");
    expect(drafted.planBaseCommit).toBe("abc1234");
    // A re-draft against newer code re-pins; a hand edit with no
    // known base keeps the existing pin.
    expect(draftPlan(drafted, "revised plan", T1, [], "def5678").planBaseCommit).toBe("def5678");
    expect(draftPlan(drafted, "hand edit", T1).planBaseCommit).toBe("abc1234");
    expect(approvePlan(drafted, T1).planBaseCommit).toBe("abc1234");
  });

  test("illegal transitions are rejected; QC bounce requires a fresh plan", () => {
    const t = approved("t1", T0);
    expect(() => transitionTask(t, "done", T1)).toThrow("illegal transition");
    const running = transitionTask(t, "running", T1);
    const review = transitionTask(running, "in-review", T2);
    const bounced = transitionTask(review, "planned", T2);
    expect(bounced.planState).toBe("draft");
    expect(() => transitionTask(bounced, "running", T2)).toThrow("before the plan is approved");
    const done = transitionTask(review, "done", T2);
    expect(() => transitionTask(done, "planned", T2)).toThrow("illegal transition");
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("task store (tasks, prompt history, projects)", () => {
  test("tasks roundtrip and filter by project; prompts keep order in the project folder", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(join(base, "store"));
    const proj1 = join(base, "proj1");
    const proj2 = join(base, "proj2");
    mkdirSync(proj1, {
      recursive: true,
    });
    mkdirSync(proj2, {
      recursive: true,
    });
    await store.registerProject("p1", proj1);
    await store.registerProject("p2", proj2);
    await store.writeTask(
      newTask(
        {
          id: "t2",
          projectId: "p2",
          title: "t2",
          prompt: "second",
        },
        T1,
      ),
    );
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "first",
        },
        T0,
      ),
    );
    expect((await store.listTasks()).map((t) => t.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect((await store.listTasks("p1")).map((t) => t.id)).toEqual([
      "t1",
    ]);
    expect(await store.readTask("missing")).toBeNull();

    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "first",
    });
    await store.appendPrompt("t1", {
      at: T1,
      kind: "agent",
      text: "working on it",
    });
    await store.appendPrompt("t1", {
      at: T2,
      kind: "user",
      text: "previous prompt please",
    });
    const prompts = await store.listPrompts("t1");
    expect(prompts.map((p) => p.text)).toEqual([
      "first",
      "working on it",
      "previous prompt please",
    ]);
    expect(prompts.map((p) => p.kind)).toEqual([
      "user",
      "agent",
      "user",
    ]);
    // Dialogue lives in the store's SQLite db (factory.db), so a crash or
    // restart loses nothing; the legacy project JSONL is import-only now.
    expect(existsSync(join(base, "store", "factory.db"))).toBe(true);

    const moved = await store.moveTask("t1", "blocked", T2);
    expect(moved.state).toBe("blocked");
    expect((await store.readTask("t1"))?.state).toBe("blocked");
    await expect(store.moveTask("t1", "done", T2)).rejects.toThrow("illegal transition");
  }, 60_000);

  test("projects are folders adopted by symlink; meta lives in <project>/data", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(join(base, "store"));
    const folder = join(base, "my-app");
    mkdirSync(join(folder, ".git"), {
      recursive: true,
    });
    const registered = await store.registerProject("p1", folder, {
      name: "enjoy-the-silence",
      description: "factory that starts itself",
      goals: [
        "ship while sleeping",
      ],
      moat: "separate QC context",
      features: [
        {
          id: "f1",
          title: "kanban",
          state: "in-progress",
          notes: "",
        },
      ],
    });
    expect(registered.repoPath).toBe(folder);
    expect(lstatSync(join(base, "store", "projects", "p1")).isSymbolicLink()).toBe(true);
    const metaOnDisk = JSON.parse(await Bun.file(join(folder, "data", "project.json")).text());
    expect(metaOnDisk.goals).toEqual([
      "ship while sleeping",
    ]);
    // data/ is git-ignored in the project so runtime data is never committed.
    expect(await Bun.file(join(folder, ".gitignore")).text()).toContain("data/");
    const p = await store.readProject("p1");
    expect(p?.features[0]?.state).toBe("in-progress");
    expect(p?.repoPath).toBe(realpathSync(folder));
    expect((await store.listProjects()).map((x) => x.id)).toEqual([
      "p1",
    ]);
    await expect(store.registerProject("p1", join(base, "elsewhere"))).rejects.toThrow();

    // Unregister removes only the symlink; the folder and its data survive.
    store.unregisterProject("p1");
    expect(await store.readProject("p1")).toBeNull();
    expect(existsSync(join(folder, "data", "project.json"))).toBe(true);
  });

  test("stored commit marks data stale when the folder moves on, until re-synced", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(join(base, "store"));
    const folder = join(base, "app");
    mkdirSync(folder, {
      recursive: true,
    });
    const git = (args: string) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd: folder,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(folder, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const p = await store.registerProject("p1", folder);
    const head1 = git("rev-parse HEAD").trim();
    expect(p.lastCommit).toBe(head1);
    expect((await store.projectStaleness("p1")).stale).toBe(false);

    await Bun.write(join(folder, "a.txt"), "two\n");
    git("commit -qam two");
    const s = await store.projectStaleness("p1");
    expect(s.stale).toBe(true);
    expect(s.lastCommit).toBe(head1);
    expect(s.currentCommit).toBe(git("rev-parse HEAD").trim());

    const synced = await store.syncProjectCommit("p1", T2);
    expect(synced.lastSyncAt).toBe(T2);
    expect((await store.projectStaleness("p1")).stale).toBe(false);
  });

  test("a moved project folder reads as offline, never as corrupt", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-"));
    const store = new FactoryStore(join(base, "store"));
    const folder = join(base, "gone-app");
    mkdirSync(folder, {
      recursive: true,
    });
    await store.registerProject("p1", folder);
    await store.writeTask(
      newTask(
        {
          id: "t1",
          projectId: "p1",
          title: "t1",
          prompt: "first",
        },
        T0,
      ),
    );
    await store.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "first",
    });
    rmSync(folder, {
      recursive: true,
      force: true,
    });
    expect(store.isProjectRegistered("p1")).toBe(true);
    expect(store.isProjectOnline("p1")).toBe(false);
    expect(await store.readProject("p1")).toBeNull();
    expect(await store.listProjects()).toEqual([]);
    expect(await store.listPrompts("t1")).toEqual([]);
    await expect(
      store.appendPrompt("t1", {
        at: T1,
        kind: "user",
        text: "more",
      }),
    ).rejects.toThrow("offline");
    // Queue state stays readable: the kanban does not depend on the folder.
    expect((await store.readTask("t1"))?.state).toBe("planned");
  }, 60_000);
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("deleteTask (complete erasure)", () => {
  async function seeded() {
    const base = mkdtempSync(join(tmpdir(), "factory-del-"));
    const repo = join(base, "repo");
    mkdirSync(repo, {
      recursive: true,
    });
    const git = (args: string, cwd = repo) =>
      execSync(`git -c user.name=t -c user.email=t@t ${args}`, {
        cwd,
        encoding: "utf8",
      });
    git("init -q");
    await Bun.write(join(repo, "a.txt"), "one\n");
    git("add a.txt");
    git("commit -qm one");
    const store = new FactoryStore(join(base, "store"));
    await store.registerProject("p1", repo);
    const task = newTask(
      {
        id: "tdel",
        projectId: "p1",
        title: "tdel",
        prompt: "do tdel",
      },
      T0,
    );
    await store.writeTask(task);
    await store.appendPrompt("tdel", {
      at: T0,
      kind: "user",
      text: "hi",
    });
    await store.recordHistory(task, "done", T0);
    await Bun.write(join(repo, "data", "plans", "tdel.md"), "plan");
    mkdirSync(join(repo, "data", "artifacts", "tdel"), {
      recursive: true,
    });
    await Bun.write(join(repo, "data", "artifacts", "tdel", "v.webm"), "x");
    mkdirSync(join(base, "store", "jobs", "tdel"), {
      recursive: true,
    });
    await Bun.write(join(base, "store", "jobs", "tdel", "builder.session"), "s");
    // legacy per-task worktree on branch task/tdel, dirtied
    const wt = join(base, ".enjoy-worktrees", "p1", "tdel");
    mkdirSync(join(base, ".enjoy-worktrees", "p1"), {
      recursive: true,
    });
    git(`worktree add "${wt}" -b task/tdel HEAD`);
    await Bun.write(join(wt, "dirty.txt"), "uncommitted\n");
    await store.writeTask({
      ...task,
      worktree: wt,
    });
    return {
      base,
      repo,
      store,
      wt,
      git,
    };
  }
  test("erases record, jobs, project files, history row, worktree and branch; stays gone; second delete null", async () => {
    const { base, repo, store, wt } = await seeded();
    const res = await store.deleteTask("tdel");
    expect(res?.centralRemoved).toBe(true);
    expect(await store.readTask("tdel")).toBeNull();
    expect((await store.listTasks()).map((t) => t.id)).not.toContain("tdel");
    expect(existsSync(join(base, "store", "tasks", "tdel"))).toBe(false);
    expect(existsSync(join(base, "store", "jobs", "tdel"))).toBe(false);
    expect(existsSync(join(repo, "data", "plans", "tdel.md"))).toBe(false);
    expect(existsSync(join(repo, "data", "artifacts", "tdel"))).toBe(false);
    expect(
      await store.similarTasks("p1", [
        "x",
      ]),
    ).toEqual([]);
    const db = new Database(join(repo, "data", "history.sqlite"), {
      readonly: true,
    });
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM task_history WHERE task_id='tdel'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    db.close();
    expect(existsSync(wt)).toBe(false);
    expect(() =>
      execSync("git show-ref --verify refs/heads/task/tdel", {
        cwd: repo,
      }),
    ).toThrow();
    expect(await store.deleteTask("tdel")).toBeNull();
  }, 90_000);
  test("invalid ids throw before any fs effect; missing returns null; symlinked task dir refused", async () => {
    const { base, store } = await seeded();
    for (const bad of [
      "../x",
      "a/b",
      "a\\b",
      "%2F",
      "%2E%2E",
      "",
    ])
      await expect(store.deleteTask(bad)).rejects.toThrow("invalid id");
    expect(existsSync(join(base, "store", "tasks", "tdel"))).toBe(true);
    const target = join(base, "sentinel");
    mkdirSync(target, {
      recursive: true,
    });
    await Bun.write(join(target, "keep.txt"), "k");
    const store2 = new FactoryStore(join(base, "store2"));
    mkdirSync(join(base, "store2", "tasks"), {
      recursive: true,
    });
    symlinkSync(target, join(base, "store2", "tasks", "tsym"), "dir");
    await Bun.write(
      join(target, "task.json"),
      JSON.stringify(
        newTask(
          {
            id: "tsym",
            projectId: "p1",
            title: "t",
            prompt: "x",
          },
          T0,
        ),
      ),
    );
    // readTask reads through symlink; delete must refuse and keep target
    const r = await store2.deleteTask("tsym").catch((e: Error) => e);
    expect(r instanceof Error || (r && !r.centralRemoved)).toBe(true);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  }, 90_000);
  test("containment: worktree outside expected location survives, task retained", async () => {
    const { base, store } = await seeded();
    const sentinel = join(base, "sentinel-wt");
    mkdirSync(sentinel, {
      recursive: true,
    });
    await Bun.write(join(sentinel, "keep.txt"), "k");
    const t = await store.readTask("tdel");
    await store.writeTask({
      ...t!,
      worktree: sentinel,
    });
    const res = await store.deleteTask("tdel");
    expect(res?.centralRemoved).toBe(false);
    expect(res?.skipped.join(" ")).toContain("outside registered/expected");
    expect(existsSync(join(sentinel, "keep.txt"))).toBe(true);
    expect(await store.readTask("tdel")).not.toBeNull();
  }, 90_000);
  test("shared jobId retained; history db without table ok; no history db not created; corrupt db retryable", async () => {
    const { base, repo, store } = await seeded();
    // shared/custom job
    const custom = {
      ...(await store.readTask("tdel"))!,
      jobId: "shared-job",
    };
    await store.writeTask(custom);
    mkdirSync(join(base, "store", "jobs", "shared-job"), {
      recursive: true,
    });
    const r1 = await store.deleteTask("tdel");
    expect(r1?.centralRemoved).toBe(true);
    expect(r1?.skipped.join(" ")).toContain("jobs/shared-job");
    expect(existsSync(join(base, "store", "jobs", "shared-job"))).toBe(true);
    expect(existsSync(join(base, "store", "deletion-receipts.jsonl"))).toBe(true);
    // corrupt history -> retained, then retry succeeds
    const s2 = await seeded();
    writeFileSync(join(s2.repo, "data", "history.sqlite"), "garbage-not-sqlite");
    const bad = await s2.store.deleteTask("tdel");
    expect(bad?.centralRemoved).toBe(false);
    expect(await s2.store.readTask("tdel")).not.toBeNull();
    rmSync(join(s2.repo, "data", "history.sqlite"), {
      force: true,
    });
    const good = await s2.store.deleteTask("tdel");
    expect(good?.centralRemoved).toBe(true);
    expect(existsSync(join(s2.repo, "data", "history.sqlite"))).toBe(false); // delete must not recreate it on the history step before removal... file removed manually then not recreated
    void base;
    void repo;
  }, 90_000);
  test("history db without task_history table still deletes", async () => {
    const { repo, store } = await seeded();
    rmSync(join(repo, "data", "history.sqlite"), {
      force: true,
    });
    const db = new Database(join(repo, "data", "history.sqlite"), {
      create: true,
    });
    db.exec("CREATE TABLE other (x TEXT)");
    db.close();
    const res = await store.deleteTask("tdel");
    expect(res?.centralRemoved).toBe(true);
  }, 90_000);
  test("offline project: central deleted, skipped locators in result and receipt", async () => {
    const { base, repo, store } = await seeded();
    rmSync(repo, {
      recursive: true,
      force: true,
    });
    const res = await store.deleteTask("tdel");
    expect(res?.centralRemoved).toBe(true);
    expect(res?.skipped.join("\n")).toContain("branch: task/tdel");
    expect(res?.skipped.join("\n")).toContain("data/plans/tdel.md");
    const receipt = await Bun.file(join(base, "store", "deletion-receipts.jsonl")).text();
    expect(receipt).toContain("task/tdel");
  }, 90_000);
  test("concurrent delete: loser throws, winner completes", async () => {
    const { store } = await seeded();
    const first = store.deleteTask("tdel");
    await expect(store.deleteTask("tdel")).rejects.toThrow("deletion in progress");
    expect((await first)?.centralRemoved).toBe(true);
    expect(await store.deleteTask("tdel")).toBeNull();
  }, 90_000);
});

describe("duplicate task detection", () => {
  const mk = (id: string, prompt: string, state: Task["state"] = "running") => ({
    ...newTask(
      {
        id,
        projectId: "p1",
        title: prompt.slice(0, 40),
        prompt,
      },
      T0,
    ),
    state,
  });
  test("same statement, any punctuation or case, in an active task is a duplicate", () => {
    const tasks = [
      mk("t1", "Add hello service, please!"),
    ];
    expect(findDuplicateTask(tasks, "p1", "add hello service please")?.id).toBe("t1");
    expect(
      findDuplicateTask(tasks, "p1", "Add a completely different admin page for billing reports")
        ?.id,
    ).toBeUndefined();
    expect(findDuplicateTask(tasks, "other-project", "add hello service please")).toBeNull();
  });
  test("near-identical statements duplicate; done or failed tasks do not block restating", () => {
    const tasks = [
      mk(
        "t1",
        "add a one-line note to README saying the factory verifies its own user interface today",
      ),
    ];
    expect(
      findDuplicateTask(
        tasks,
        "p1",
        "add a one-line note to README saying the factory verifies its own user interface now",
      )?.id,
    ).toBe("t1");
    const done = [
      mk("t2", "add hello service please", "done"),
    ];
    expect(findDuplicateTask(done, "p1", "add hello service please")).toBeNull();
    const failed = [
      mk("t3", "add hello service please", "failed"),
    ];
    expect(findDuplicateTask(failed, "p1", "add hello service please")).toBeNull();
  });
});

describe("model tier by task type, escalating per retry", () => {
  test("security starts smart, visual starts cheap, retries climb and cap", () => {
    expect(tierFor("security", 0)).toEqual({
      name: "smart",
      effort: "high",
    });
    expect(tierFor("css", 0)).toEqual({
      name: "cheap",
      effort: "low",
    });
    expect(tierFor("ui", 0).name).toBe("cheap");
    expect(tierFor("backend", 0)).toEqual({
      name: "standard",
      effort: "medium",
    });
    expect(tierFor("css", 1)).toEqual({
      name: "standard",
      effort: "medium",
    });
    expect(tierFor("css", 9)).toEqual({
      name: "smart",
      effort: "high",
    });
    expect(tierFor("security", 3)).toEqual({
      name: "smart",
      effort: "high",
    });
  });
});

describe("SME soul from project context", () => {
  const base: Project = {
    id: "p1",
    name: "shop",
    description: "",
    businessPlan: "",
    rules: "",
    smeSoul: "",
    coderSoul: "",
    goals: [],
    moat: "",
    repoPath: "",
    devCommand: "",
    devPort: 0,
    testMode: "checks",
    features: [],
    lastCommit: "",
    lastSyncAt: "",
  };
  test("derives persona from description, plan, goals, moat, rules", () => {
    const p = smePersona({
      ...base,
      description: "sells candles",
      businessPlan: "subscription boxes",
      goals: [
        "grow retention",
      ],
      moat: "scent library",
      rules: "never discount over 20%",
    });
    expect(p).toContain("subject-matter expert for shop");
    expect(p).toContain("Business plan: subscription boxes");
    expect(p).toContain("never discount over 20%");
  });
  test("explicit soul wins over derivation", () => {
    expect(
      smePersona({
        ...base,
        description: "sells candles",
        smeSoul: "You are a ruthless margin hawk.",
      }),
    ).toBe("You are a ruthless margin hawk.");
  });
  test("coder reviewer soul derives from rules and test mode, explicit wins", () => {
    const p = coderPersona({
      ...base,
      rules: "never discount over 20%",
      testMode: "push-only",
    });
    expect(p).toContain("pragmatic senior coder reviewing work on shop");
    expect(p).toContain("never discount over 20%");
    expect(p).toContain("cannot be run locally");
    expect(
      coderPersona({
        ...base,
        coderSoul: "You are a terse performance obsessive.",
      }),
    ).toBe("You are a terse performance obsessive.");
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
describe("capacity dispatch (max parallel tasks + RAM floor, priority order)", () => {
  const cap = {
    running: 0,
    maxParallelTasks: 2,
    freeRamMb: 8192,
    ramFloorMb: 1024,
  };

  test("dispatches oldest approved plans first, up to free slots", () => {
    const tasks = [
      approved("t3", T2),
      approved("t1", T0),
      approved("t2", T1),
    ];
    expect(selectDispatch(tasks, cap).map((t) => t.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(
      selectDispatch(tasks, {
        ...cap,
        running: 1,
      }).map((t) => t.id),
    ).toEqual([
      "t1",
    ]);
    expect(
      selectDispatch(tasks, {
        ...cap,
        running: 2,
      }),
    ).toEqual([]);
  });

  test("RAM floor blocks all dispatch; unapproved and running tasks never dispatch", () => {
    const tasks = [
      approved("t1", T0),
      newTask(
        {
          id: "t0",
          projectId: "p1",
          title: "t0",
          prompt: "x",
        },
        T0,
      ),
    ];
    expect(
      selectDispatch(tasks, {
        ...cap,
        freeRamMb: 512,
      }),
    ).toEqual([]);
    expect(selectDispatch(tasks, cap).map((t) => t.id)).toEqual([
      "t1",
    ]);
    const running = transitionTask(approved("t9", T0), "running", T1);
    expect(
      selectDispatch(
        [
          running,
        ],
        cap,
      ),
    ).toEqual([]);
  });

  test("priority: requested planning offloads the human first, then work closest to main", () => {
    const planning = {
      ...newTask(
        {
          id: "tp",
          projectId: "p1",
          title: "tp",
          prompt: "x",
        },
        T2,
      ),
      planRequested: true,
    };
    const started = {
      ...approved("ts", T1),
      attempts: 2,
    }; // already attempted: finish and land it
    const fresh = approved("tf", T0);
    expect(priorityRank(planning)).toBeLessThan(priorityRank(started));
    expect(priorityRank(started)).toBeLessThan(priorityRank(fresh));
    // The queue is the persisted planned state, in pickup order.
    expect(
      queuedTasks([
        fresh,
        planning,
        started,
      ]).map((t) => t.id),
    ).toEqual([
      "tp",
      "ts",
      "tf",
    ]);
    // One slot: the already-started task wins over the older fresh one.
    expect(
      selectDispatch(
        [
          fresh,
          started,
        ],
        {
          ...cap,
          maxParallelTasks: 1,
        },
      ).map((t) => t.id),
    ).toEqual([
      "ts",
    ]);
    // Planning fills slots before implementation, and only when requested.
    const unrequested = newTask(
      {
        id: "tu",
        projectId: "p1",
        title: "tu",
        prompt: "x",
      },
      T0,
    );
    expect(
      selectPlanDispatch(
        [
          unrequested,
          planning,
        ],
        cap,
      ).map((t) => t.id),
    ).toEqual([
      "tp",
    ]);
    expect(
      selectPlanDispatch(
        [
          planning,
        ],
        {
          ...cap,
          running: 2,
        },
      ),
    ).toEqual([]);
  });
});

describe("deriveTitle", () => {
  test("small meaningful titles, never a raw 80-char cut", () => {
    expect(
      deriveTitle(
        "add a status page at /status showing service health as JSON and HTML, with tests",
      ),
    ).toBe("Add a status page at /status showing service");
    expect(deriveTitle("please fix the login redirect loop when the session expires")).toBe(
      "Fix the login redirect loop when the session",
    );
    expect(deriveTitle("")).toBe("Untitled task");
    expect(deriveTitle("add hello service")).toBe("Add hello service");
  });
});
