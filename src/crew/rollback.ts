import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { FactoryStore } from "./store";
import type { Task } from "./task";

export interface RollbackEligibility {
  eligible: boolean;
  reason: string;
  /** The factory merge commit to revert; "" when not revertible. */
  mergeCommit: string;
}

export interface RollbackResult {
  status: "rolled-back" | "held";
  task: Task;
  mergeCommit: string;
  revertCommit: string;
}

function sh(cwd: string, args: string, timeout = 30_000): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    timeout,
  }).trim();
}

function shOk(cwd: string, args: string): boolean {
  try {
    execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}

function hasOrigin(repo: string): boolean {
  try {
    return execSync("git remote", {
      cwd: repo,
      encoding: "utf8",
      timeout: 15_000,
    })
      .split("\n")
      .map((s) => s.trim())
      .includes("origin");
  } catch {
    return false;
  }
}

const pushEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
});

/**
 * The factory merge commits for a task on main: merges whose subject is
 * exactly the landing message `merge task/<id>:` (see mergeTaskIntoMain).
 * Hand merges and branch-only work never carry that subject, so they are
 * excluded by construction.
 */
export function findFactoryMerges(repo: string, taskId: string): string[] {
  let out = "";
  try {
    out = sh(repo, "log main --merges --format=%H%x00%s");
  } catch {
    return [];
  }
  const prefix = `merge task/${taskId}:`;
  const commits: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\x00");
    if (tab < 0) continue;
    const commit = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (subject.startsWith(prefix)) commits.push(commit);
  }
  return commits;
}

function onMain(repo: string): boolean {
  // Read-only form: with a second argument symbolic-ref would SET HEAD
  // (silently yanking the checkout onto main), so read HEAD and compare.
  try {
    return sh(repo, "symbolic-ref -q HEAD") === "refs/heads/main";
  } catch {
    return false;
  }
}

function cleanCheckout(repo: string): boolean {
  try {
    return !execSync("git status --porcelain --untracked-files=no", {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    return false;
  }
}

/**
 * Whether a done task's landed merge can be reverted right now. Pure
 * except for local git reads; never touches the store or the checkout.
 */
export function rollbackEligibility(repo: string, task: Task): RollbackEligibility {
  if (task.state !== "done")
    return {
      eligible: false,
      reason: `task is ${task.state}, not done — only a finished feature can be rolled back`,
      mergeCommit: "",
    };
  if (task.rolledBackAt)
    return {
      eligible: false,
      reason: "already rolled back — re-stating the task is the redo path",
      mergeCommit: "",
    };
  const merges = findFactoryMerges(repo, task.id);
  if (merges.length === 0)
    return {
      eligible: false,
      reason: `no factory merge for task/${task.id} on main — branch-only or hand-merged work cannot be rolled back automatically`,
      mergeCommit: "",
    };
  if (merges.length > 1)
    return {
      eligible: false,
      reason: `ambiguous: ${merges.length} factory merges for task/${task.id} on main — revert by hand`,
      mergeCommit: "",
    };
  const mergeCommit = merges[0] ?? "";
  if (!shOk(repo, `merge-base --is-ancestor ${mergeCommit} main`))
    return {
      eligible: false,
      reason: "the factory merge is no longer on main — the history was rewritten, revert by hand",
      mergeCommit: "",
    };
  if (!onMain(repo))
    return {
      eligible: false,
      reason: "the project checkout is not on main — roll back when the checkout is on main",
      mergeCommit: "",
    };
  if (!cleanCheckout(repo))
    return {
      eligible: false,
      reason: "the project checkout has uncommitted work — roll back when the checkout is clean",
      mergeCommit: "",
    };
  return {
    eligible: true,
    reason: "",
    mergeCommit,
  };
}

function errLine(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err);
}

/**
 * Roll back a done task: revert its factory merge on main with a new
 * revert commit, then a regular `git push origin main` when an origin
 * exists. History is never rewritten: no reset, no force-push. The task
 * stays `done`, marked with `rolledBackAt`/`revertCommit`.
 *
 * A failed or refused rollback mutates nothing: no checkout change, no
 * task write. When the revert lands locally but the main push fails, the
 * task is still marked rolled back with the push owed — the push-retry
 * sweep (which admits done tasks with a main push pending) delivers it.
 */
export async function rollbackTask(
  store: FactoryStore,
  taskId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<RollbackResult> {
  const task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath)
    throw new Error(`task ${taskId}: project has no local repo path — revert the merge manually`);
  const repo = realpathSync(project.repoPath);
  const check = rollbackEligibility(repo, task);
  if (!check.eligible) throw new Error(`task ${taskId}: ${check.reason}`);
  const mergeCommit = check.mergeCommit;

  try {
    execSync(`git revert --no-edit -m 1 ${mergeCommit}`, {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
    });
  } catch (err) {
    let conflicted = "";
    try {
      conflicted = execSync("git diff --name-only --diff-filter=U", {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
    } catch {
      /* ignore */
    }
    try {
      execSync("git revert --abort", {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      });
    } catch {
      /* ignore */
    }
    const files = conflicted
      ? conflicted.split("\n").filter(Boolean)
      : [
          "unknown files",
        ];
    throw new Error(
      `task ${taskId}: revert conflict in ${files.join(", ")} — main left untouched (${errLine(err)})`,
    );
  }
  const revertCommit = sh(repo, "rev-parse HEAD");
  const at = now();
  const short = (h: string) => h.slice(0, 7);

  if (!hasOrigin(repo)) {
    const next: Task = {
      ...task,
      rolledBackAt: at,
      revertCommit,
      updatedAt: at,
    };
    await store.writeTask(next);
    await store
      .appendPrompt(taskId, {
        at,
        kind: "system",
        text: `rollback: reverted merge ${short(mergeCommit)} with ${short(revertCommit)} locally — no origin remote configured`,
      })
      .catch(() => {});
    return {
      status: "rolled-back",
      task: next,
      mergeCommit,
      revertCommit,
    };
  }
  try {
    execSync("git push origin main", {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env: pushEnv(),
    });
  } catch (err) {
    const msg = errLine(err);
    const next: Task = {
      ...task,
      rolledBackAt: at,
      revertCommit,
      mainPushPending: {
        targetRef: "main",
        commit: revertCommit,
        attempts: 1,
        lastError: msg,
        nextRetryAt: new Date(Date.parse(at) + 60_000).toISOString(),
      },
      updatedAt: at,
    };
    await store.writeTask(next);
    await store
      .appendPrompt(taskId, {
        at,
        kind: "system",
        text: `rollback: reverted merge ${short(mergeCommit)} with ${short(revertCommit)} locally, but pushing main failed (${msg}) — push retry queued`,
      })
      .catch(() => {});
    return {
      status: "held",
      task: next,
      mergeCommit,
      revertCommit,
    };
  }
  const next: Task = {
    ...task,
    rolledBackAt: at,
    revertCommit,
    branchPushPending: null,
    mainPushPending: null,
    updatedAt: at,
  };
  await store.writeTask(next);
  await store
    .appendPrompt(taskId, {
      at,
      kind: "system",
      text: `rollback: reverted merge ${short(mergeCommit)} with ${short(revertCommit)} and pushed — redo by re-stating the task`,
    })
    .catch(() => {});
  return {
    status: "rolled-back",
    task: next,
    mergeCommit,
    revertCommit,
  };
}
