import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DialogueDb } from "./dialogue-db";
import { FactoryStore } from "./store";
import { newTask } from "./task";

const T0 = "2026-10-22T10:00:00.000Z";

describe("DialogueDb (SQLite dialogue, decisions, drafts)", () => {
  test("prompts keep order, drafts save/load/clear, scout round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "dialogue-"));
    const db = new DialogueDb(join(dir, "factory.db"));
    db.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "are you stuck?",
    });
    db.appendPrompt("t1", {
      at: T0,
      kind: "agent",
      text: "builder: working",
    });
    expect(db.listPrompts("t1").map((p) => p.kind)).toEqual([
      "user",
      "agent",
    ]);
    db.saveDraft("t1", "answer", "1. yes, public");
    db.saveDraft("t1", "comment:plan:3", "make it POST");
    expect(db.drafts("t1")).toEqual({
      answer: "1. yes, public",
      "comment:plan:3": "make it POST",
    });
    db.saveDraft("t1", "answer", "");
    expect(db.drafts("t1")).toEqual({
      "comment:plan:3": "make it POST",
    });
    db.saveScout(
      "p1",
      JSON.stringify({
        description: "shop",
      }),
    );
    expect(db.scout("p1")).toContain("shop");
    db.close();
  }, 60_000);

  test("data survives a reopen (crash/restart loses nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dialogue-"));
    const path = join(dir, "factory.db");
    const first = new DialogueDb(path);
    first.appendPrompt("t1", {
      at: T0,
      kind: "user",
      text: "decision: ship it",
    });
    first.saveDraft("t1", "reply", "half-typed reply");
    first.close();
    const second = new DialogueDb(path);
    expect(second.listPrompts("t1")[0]?.text).toBe("decision: ship it");
    expect(second.drafts("t1").reply).toBe("half-typed reply");
    second.close();
  }, 60_000);
});

describe("FactoryStore dialogue in SQLite", () => {
  test("legacy JSONL is imported once; new store instances see the same dialogue", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-sqlite-"));
    const repo = join(base, "repo");
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
    const store = new FactoryStore(join(base, "data"));
    await store.registerProject("p1", repo, {
      name: "p1",
    });
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
    // Legacy dialogue on disk, as older versions wrote it.
    const commDir = join(repo, "data", "communication");
    mkdirSync(commDir, {
      recursive: true,
    });
    await Bun.write(
      join(commDir, "t1.jsonl"),
      `${JSON.stringify({
        at: T0,
        kind: "user",
        text: "legacy hello",
      })}\n`,
    );
    const prompts = await store.listPrompts("t1");
    expect(prompts.map((p) => p.text)).toEqual([
      "legacy hello",
    ]);
    await store.appendPrompt("t1", {
      at: T0,
      kind: "agent",
      text: "new reply",
    });
    await store.saveDraft("t1", "answer", "draft survives restart");
    // A brand-new store over the same data dir = an app restart.
    const restarted = new FactoryStore(join(base, "data"));
    const after = await restarted.listPrompts("t1");
    expect(after.map((p) => p.text)).toEqual([
      "legacy hello",
      "new reply",
    ]);
    expect((await restarted.listDrafts("t1")).answer).toBe("draft survives restart");
  }, 60_000);

  test("deleteTask erases the task record, its dialogue and its unsent drafts", async () => {
    const base = mkdtempSync(join(tmpdir(), "factory-delete-"));
    const repo = join(base, "repo");
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
    const store = new FactoryStore(join(base, "data"));
    await store.registerProject("p1", repo, {
      name: "p1",
    });
    const task = newTask(
      {
        id: "t-del",
        projectId: "p1",
        title: "t-del",
        prompt: "add hello service",
      },
      T0,
    );
    await store.writeTask(task);
    await store.appendPrompt("t-del", {
      at: T0,
      kind: "user",
      text: "hello",
    });
    await store.saveDraft("t-del", "answer", "unsent answer");
    expect((await store.deleteTask("t-del"))?.centralRemoved).toBe(true);
    expect(await store.readTask("t-del")).toBeNull();
    expect(await store.listPrompts("t-del")).toEqual([]);
    expect(await store.listDrafts("t-del")).toEqual({});
    expect(await store.deleteTask("t-del")).toBeNull();
  }, 60_000);
});
