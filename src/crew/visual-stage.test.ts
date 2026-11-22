import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVisualStage } from "./dispatch";
import { FactoryStore } from "./store";
import { newTask } from "./task";
import { encodePng } from "./visual";

function solidPng(r: number): Buffer {
  const data = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    data[i * 4] = r;
    data[i * 4 + 3] = 255;
  }
  return encodePng({
    width: 4,
    height: 4,
    data,
  });
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "visual-stage-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (args: string) =>
    execSync(`git ${args}`, {
      cwd: repo,
      encoding: "utf8",
    });
  git("init -q");
  git("config user.email t@t.t");
  git("config user.name t");
  writeFileSync(join(repo, "page.html"), "<h1>old</h1>");
  git("add .");
  git("commit -qm init");
  const base = git("rev-parse HEAD").trim();
  writeFileSync(join(repo, "page.html"), "<h1>new</h1>"); // feature change, uncommitted in worktree
  const store = new FactoryStore(join(root, "factory-data"));
  await store.registerProject("demo", repo, {
    name: "demo",
  });
  const now = new Date().toISOString();
  const task = {
    ...newTask(
      {
        id: "task-visual",
        projectId: "demo",
        title: "new page",
        prompt: "add page",
      },
      now,
    ),
    taskType: "ui" as const,
    plan: "## Visual moments\n- home: /",
    worktree: repo,
    baseCommit: base,
  };
  await store.writeTask(task);
  return {
    root,
    repo,
    store,
    task,
  };
}

const capture = async ({ outDir }: { outDir: string }) => {
  mkdirSync(outDir, {
    recursive: true,
  });
  writeFileSync(
    join(outDir, "home.png"),
    outDir.includes("baseline") ? solidPng(10) : solidPng(200),
  );
};

describe("runVisualStage", () => {
  test("changed screenshot parks for owner, PNGs live outside git, approval of same hashes passes", async () => {
    const { repo, store, task } = await setup();
    const first = await runVisualStage(
      task,
      {
        store,
        visualCapture: capture,
      },
      () => new Date().toISOString(),
    );
    expect(first.action).toBe("park");
    expect(first.task.visualState).toBe("pending");
    const review = await store.readVisualReview(task.id);
    expect(review?.shots[0]?.status).toBe("changed");
    expect(existsSync(store.visualFilePath(task.id, "after", "home.png"))).toBe(true);
    expect(existsSync(store.visualFilePath(task.id, "diff", "home.png"))).toBe(true);
    // Nothing visual was written into the repo / git history.
    expect(readdirSync(repo).filter((f) => f.endsWith(".png"))).toEqual([]);
    expect(
      execSync("git status --porcelain", {
        cwd: repo,
        encoding: "utf8",
      }),
    ).not.toContain(".png");
    // Owner approves the exact after-hash -> re-capture passes the gate.
    const approvedTask = {
      ...first.task,
      visualApprovedHashes: [
        review?.shots[0]?.afterHash ?? "",
      ],
    };
    const second = await runVisualStage(
      approvedTask,
      {
        store,
        visualCapture: capture,
      },
      () => new Date().toISOString(),
    );
    expect(second.action).toBe("pass");
    expect(second.task.visualState).toBe("approved");
  });

  test("backend task with no page files is skipped", async () => {
    const { store, task } = await setup();
    const backend = {
      ...task,
      taskType: "backend" as const,
      plan: "no moments",
    };
    execSync("git checkout -- page.html", {
      cwd: task.worktree,
    });
    writeFileSync(join(task.worktree, "api.ts"), "export {}");
    const result = await runVisualStage(
      backend,
      {
        store,
        visualCapture: capture,
      },
      () => new Date().toISOString(),
    );
    // page.html is modified in the shared fixture, so remove that signal:
    if (result.action !== "pass")
      throw new Error(`expected skip/pass, got ${result.action}: ${result.reason}`);
    expect(result.action).toBe("pass");
  });

  test("visual task without moments bounces to the builder", async () => {
    const { store, task } = await setup();
    const noMoments = {
      ...task,
      plan: "## Approach\nbuild it",
    };
    const result = await runVisualStage(
      noMoments,
      {
        store,
        visualCapture: capture,
      },
      () => new Date().toISOString(),
    );
    expect(result.action).toBe("bounce");
    expect(result.reason).toContain("visual.moments.json");
  });
});
