import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextPack,
  contextPackKey,
  getContextPack,
  invalidateContextPack,
  readContextPack,
  writeContextPack,
} from "./context-pack";
import { FactoryStore } from "./store";
import type { Project } from "./task";
import { newTask } from "./task";

const T0 = "2026-11-02T10:00:00.000Z";

function makeProject(id = "p1"): Project {
  return {
    id,
    name: "Demo project",
    description: "a demo",
    businessPlan: "ship things",
    rules: "no slop",
    smeSoul: "be strict",
    coderSoul: "be tidy",
    goals: [
      "g1",
    ],
    moat: "speed",
    repoPath: "/tmp/repo",
    devCommand: "bun dev",
    devPort: 4319,
    testMode: "checks",
    features: [],
    lastCommit: "abc",
    lastSyncAt: T0,
  };
}

function makeTask() {
  return newTask(
    {
      id: "t1",
      projectId: "p1",
      title: "Add hello",
      prompt: "add hello service",
    },
    T0,
  );
}

describe("context-pack", () => {
  test("buildContextPack is a deterministic concatenation, role-sliced", () => {
    const task = makeTask();
    const project = makeProject();
    const builder = buildContextPack({
      role: "builder",
      taskId: task.id,
      task,
      project,
      plan: "# Intent\nShip it\n## Success criteria\nworks",
      decisions: "use bun",
      patterns: "no any",
      souls: "coder soul",
      fileList: "Files:\na.ts",
      settledDecisions: "- use port 8080",
    });
    expect(builder).toContain("Context pack — role: builder");
    expect(builder).toContain("Plan (execution brief)");
    expect(builder).toContain("Settled decisions");
    // redteam role must NOT receive the execution brief label; it gets full plan.
    const redteam = buildContextPack({
      role: "redteam",
      taskId: task.id,
      task,
      project,
      plan: "# Intent\nShip it",
      decisions: "use bun",
      patterns: "no any",
      souls: "sme soul",
      fileList: "Files:\na.ts",
    });
    expect(redteam).toContain("## Plan");
    expect(redteam).not.toContain("Plan (execution brief)");
    // planner role omits plan entirely
    const planner = buildContextPack({
      role: "planner",
      taskId: task.id,
      task,
      project,
      plan: "SHOULD NOT APPEAR",
      decisions: "use bun",
      patterns: "no any",
      souls: "sme soul",
      fileList: "Files:\na.ts",
    });
    expect(planner).not.toContain("SHOULD NOT APPEAR");
  });

  test("contextPackKey is stable and changes when inputs change", () => {
    const task = makeTask();
    const project = makeProject();
    const base = {
      role: "builder" as const,
      taskId: task.id,
      task,
      project,
      plan: "plan v1",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    };
    const k1 = contextPackKey(base);
    const k2 = contextPackKey({
      ...base,
    });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    const k3 = contextPackKey({
      ...base,
      plan: "plan v2",
    });
    expect(k3).not.toBe(k1);
    const k4 = contextPackKey({
      ...base,
      role: "qc",
    });
    expect(k4).not.toBe(k1);
  });

  test("volatile task fields (state, attempts, timestamps) do not bust the key or content", () => {
    const task = makeTask();
    const project = makeProject();
    const base = {
      role: "builder" as const,
      taskId: task.id,
      task,
      project,
      plan: "plan v1",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    };
    const moved = {
      ...task,
      state: "running" as const,
      attempts: task.attempts + 2,
      updatedAt: "2026-11-03T10:00:00.000Z",
    };
    expect(
      contextPackKey({
        ...base,
        task: moved,
      }),
    ).toBe(contextPackKey(base));
    expect(
      buildContextPack({
        ...base,
        task: moved,
      }),
    ).toBe(buildContextPack(base));
    // Semantic changes still bust it: a new lane or tag is real context.
    expect(
      contextPackKey({
        ...base,
        task: {
          ...task,
          lane: "careful" as const,
        },
      }),
    ).not.toBe(contextPackKey(base));
  });
});

describe("context-pack cache", () => {
  test("getContextPack caches and reports hit/miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const store = new FactoryStore(dir);
    const task = makeTask();
    // ensure task dir exists
    await store.writeTask(task);
    const project = makeProject();
    const inputs = {
      role: "builder" as const,
      taskId: task.id,
      task,
      project,
      plan: "plan",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    };
    const first = await getContextPack(store, inputs);
    expect(first.hit).toBe(false);
    const second = await getContextPack(store, inputs);
    expect(second.hit).toBe(true);
    expect(second.content).toBe(first.content);
    expect(second.key).toBe(first.key);
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  test("getContextPack hits across attempt/state changes (the retry case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const store = new FactoryStore(dir);
    const task = makeTask();
    await store.writeTask(task);
    const project = makeProject();
    const inputs = {
      role: "builder" as const,
      taskId: task.id,
      task,
      project,
      plan: "plan",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    };
    const first = await getContextPack(store, inputs);
    const retried = await getContextPack(store, {
      ...inputs,
      task: {
        ...task,
        state: "running" as const,
        attempts: 3,
        updatedAt: "2026-11-03T10:00:00.000Z",
      },
    });
    expect(retried.hit).toBe(true);
    expect(retried.content).toBe(first.content);
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  test("getContextPack rebuilds when key changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const store = new FactoryStore(dir);
    const task = makeTask();
    await store.writeTask(task);
    const project = makeProject();
    const first = await getContextPack(store, {
      role: "builder",
      taskId: task.id,
      task,
      project,
      plan: "plan v1",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    });
    const second = await getContextPack(store, {
      role: "builder",
      taskId: task.id,
      task,
      project,
      plan: "plan v2",
      decisions: "d",
      patterns: "p",
      souls: "s",
      fileList: "f",
    });
    expect(second.hit).toBe(false);
    expect(second.content).not.toBe(first.content);
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  test("readContextPack returns null on miss and invalidate clears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const store = new FactoryStore(dir);
    const task = makeTask();
    await store.writeTask(task);
    const miss = await readContextPack(store, task.id, "builder");
    expect(miss).toBeNull();
    await writeContextPack(store, task.id, "builder", "hello", "key1");
    const hit = await readContextPack(store, task.id, "builder");
    expect(hit).not.toBeNull();
    expect(hit?.content).toBe("hello");
    await invalidateContextPack(store, task.id, "builder");
    const after = await readContextPack(store, task.id, "builder");
    expect(after).toBeNull();
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });

  test("invalidateContextPack with no role clears all roles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-"));
    const store = new FactoryStore(dir);
    const task = makeTask();
    await store.writeTask(task);
    await writeContextPack(store, task.id, "builder", "b", "kb");
    await writeContextPack(store, task.id, "qc", "q", "kq");
    await invalidateContextPack(store, task.id);
    expect(await readContextPack(store, task.id, "builder")).toBeNull();
    expect(await readContextPack(store, task.id, "qc")).toBeNull();
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  });
});
