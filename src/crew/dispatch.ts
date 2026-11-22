import { execFileSync, execSync } from "node:child_process";
import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  sign as cryptoSign,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { freemem, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  actionMentionsFor,
  EXPENSIVE_PATHS,
  findPlanContradictions,
  planConsistencyGate,
  planHasTradeoff,
  tradeoffGate,
  vetoReasonsFor,
} from "../governance/gates";
import { addedCommentHits, formatCommentReport } from "./comment-scan";
import { addedContentHits, formatContentReport } from "./content-scan";
import {
  blockedNote,
  checkPrereqs,
  consecutiveDeferrals,
  deferralNote,
  malformedNote,
  ownerOverrideAfter,
  PREREQ_DEFER_PREFIX,
  PREREQ_DEFERRAL_LIMIT,
  PREREQ_OVERRIDE_PREFIX,
  parsePlanPrereqs,
  prereqSetKey,
} from "./prereq";
import { addedSuppressionHits, formatSuppressionReport } from "./review-scan";

/**
 * The boundary gate vetoes a card whose own text trips a veto pattern —
 * before any agent runs. An approved plan can contain such a line (the
 * real red-teams already judged it), and rebuilding the same card then
 * loops the veto forever. Strip the offending lines at card creation
 * and put the factory ruling in their place: quality checks are never
 * bypassed, so the builder simply never receives that instruction.
 */
export function sanitizeGateVeto(text: string): {
  text: string;
  removed: string[];
} {
  const removed: string[] = [];
  const kept = text.split("\n").filter((line) => {
    const reasons = vetoReasonsFor(line);
    if (reasons.length) removed.push(...reasons);
    return !reasons.length;
  });
  if (!removed.length)
    return {
      text,
      removed,
    };
  return {
    // The reasons themselves are deliberately not quoted here: their
    // wording would trip the same patterns in the sanitized card.
    text: `${kept.join("\n")}\n[factory ruling: ${removed.length} plan line(s) were removed before this card was issued by the boundary gate. Quality checks are constitutional and are never bypassed; implement the compliant path, and record any disagreement as a tradeoff in your reply instead.]`,
    removed,
  };
}

import { analyzeCi } from "./ci";
import { getContextPack } from "./context-pack";
import {
  deferredQuestion,
  includedDeferredIds,
  newDeferredPoint,
  parseRedteamPoints,
  relatedDeferred,
} from "./deferred";
import type { JobCard } from "./jobcard";
import { runStation } from "./orchestrator";
import type { ProviderId } from "./providers";
import type { FactoryStore } from "./store";
import {
  approvePlan,
  type Capacity,
  coderPersona,
  deriveTitle,
  draftPlan,
  findDuplicateTask,
  findRetroDuplicate,
  newTask,
  selectDispatch,
  selectPlanDispatch,
  smePersona,
  type Task,
  tierFor,
} from "./task";
import {
  assertOutsideWorktree,
  type CaptureFn,
  captureAtCommit,
  captureMoments,
  changedShots,
  classifyShot,
  isVisualRelevant,
  resolveVisualMoments,
  sanitizeShotName,
  type VisualReview,
  visualGateAction,
} from "./visual";

// Dispatcher: turns approved, planned tasks into running subagents under
// a strict spawn contract — one direct job card per station, cwd locked
// to the task's own worktree of its own project, resume only from that
// station's own session (handled by runStation via the store).

/**
 * RAM an agent can still get, in MB. Prefers the kernel's MemAvailable
 * (free memory plus reclaimable cache); os.freemem() counts only unused
 * pages, so a well-cached host looks nearly full. Falls back to freemem()
 * where /proc/meminfo is missing (non-Linux).
 */
export function freeRamMb(): number {
  try {
    const available = availableMbFromMeminfo(readFileSync("/proc/meminfo", "utf8"));
    if (available !== null) return available;
  } catch {
    // no /proc/meminfo: fall back below
  }
  return Math.floor(freemem() / (1024 * 1024));
}

/** MemAvailable from /proc/meminfo text, in MB; null when the line is absent. */
export function availableMbFromMeminfo(meminfo: string): number | null {
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  return match ? Math.floor(Number(match[1]) / 1024) : null;
}

/**
 * Agents in use: tasks whose state is running plus pipelines this process
 * launched that haven't recorded it yet, each task counted once. A task
 * is usually both (its pipeline is in `active` and its state is running),
 * so adding the two would count it twice and halve the agent limit.
 */
export function runningCount(tasks: Task[], active: ReadonlySet<string>): number {
  const busy = new Set(active);
  for (const t of tasks) if (t.state === "running") busy.add(t.id);
  return busy.size;
}

export interface RamAdvice {
  action: "raise" | "lower";
  suggested: number; // suggested maxParallelTasks
  reason: string;
}

/**
 * Dynamic capacity advice from tracked RAM: the server samples free RAM
 * every dispatch tick and this turns the recent average into a question
 * for the owner — never an automatic change. Raise only when all slots
 * are busy AND work is waiting AND the headroom funds more agents
 * (~768 MB each beyond a 2 GB reserve). Lower when free RAM stays
 * scarce. Anything else is "no advice" (null).
 */
export function ramAdvice(
  samplesMb: number[],
  cap: number,
  load: {
    running: number;
    queued: number;
    planning: number;
  },
): RamAdvice | null {
  if (samplesMb.length < 20 || cap < 1) return null; // need ~a minute of samples
  const recent = samplesMb.slice(-100);
  const avg = Math.floor(recent.reduce((a, b) => a + b, 0) / recent.length);
  const saturated = load.running >= cap && load.queued + load.planning > 0;
  if (avg > 6144 && saturated) {
    const funded = cap + Math.floor((avg - 2048) / 768);
    const suggested = Math.min(24, cap + 3, funded);
    if (suggested > cap) {
      return {
        action: "raise",
        suggested,
        reason: `Free RAM averaged ${avg} MB over the last minutes with ${load.queued + load.planning} task(s) waiting — raise parallel tasks to ${suggested}?`,
      };
    }
  }
  if (avg < 2048 && cap > 4) {
    const suggested = Math.max(4, cap - 3);
    return {
      action: "lower",
      suggested,
      reason: `Free RAM averaged only ${avg} MB recently — lower parallel tasks to ${suggested} to protect the machine?`,
    };
  }
  return null;
}

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function gitOk(cwd: string, args: string): boolean {
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

// Does anything in this repo attach behaviour at runtime — listeners, refs,
// delegated selectors, framework attributes? When it does, a control with no
// handler in the diff proves nothing: a script can wire it by id or selector.
// Our own `public/app.js` wires markup exactly that way. Failure to search
// counts as "wired", because the candidate band is the safe band.
const RUNTIME_WIRING =
  "grep -l -E 'addEventListener|cloneElement|Children\\.map|querySelector|\\.onclick|data-action|hx-|x-on:' -- .";

function runtimeWiringIn(worktree: string): boolean {
  if (!gitOk(worktree, "rev-parse --is-inside-work-tree")) return true;
  try {
    return git(worktree, RUNTIME_WIRING).length > 0;
  } catch {
    // The repo was valid a line ago, so a throw here is git grep's exit 1:
    // nothing matched.
    return false;
  }
}

const pushEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
});

/**
 * A push is only owed when an `origin` remote is configured. Local-only
 * repos (no origin at all) land locally on both the branch and main paths:
 * no pending push is recorded, no retry is queued, and status lines say
 * "locally — no origin remote configured", never "pushed".
 */
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

function errLine(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? String(err)) : String(err);
}

/** True only when this task may trust the worktree's HEAD/content. */
export function worktreeLeasedByTask(task: Task): boolean {
  if (!task.worktree || !existsSync(task.worktree)) return false;
  const base = task.worktree.split("/").pop() ?? "";
  const m = /^slot-(\d+)$/.exec(base);
  if (!m) return true; // legacy per-task worktree (named by task id, e.g. task-<timestamp>): no lease file
  const holder = leasedBy(dirname(task.worktree), Number(m[1]));
  return holder === task.id;
}

function refCommit(repo: string, task: Task): string {
  try {
    return git(repo, `rev-parse refs/heads/task/${task.id}`);
  } catch {
    return "";
  }
}

function persistedBranchCommit(repo: string, task: Task): string {
  const candidates = [
    task.branchPushPending?.commit ?? "",
    refCommit(repo, task),
  ];
  for (const c of candidates) {
    if (c && gitOk(repo, `cat-file -e ${c}^{commit}`)) return c;
  }
  return "";
}

async function updatePending(
  store: FactoryStore,
  task: Task,
  patch: Partial<Pick<Task, "branchPushPending" | "mainPushPending">>,
): Promise<Task> {
  const fresh = (await store.readTask(task.id).catch(() => null)) ?? task;
  const next: Task = {
    ...fresh,
    ...patch,
  };
  await store.writeTask(next).catch(() => {});
  return next;
}

// --- Warm worktree pool ---------------------------------------------------
// One pool per project, exactly `maxParallelTasks` slots: the cap is on
// tasks running in parallel, so that is also how many worktrees can ever
// be busy at once. Slots are created once and reused; leasing one resets
// tracked files and drops untracked ones but keeps ignored files
// (node_modules, build caches), which is what makes the next task cheap
// to spin up. Without a pool size, callers keep the legacy behaviour of
// one dedicated worktree per task.

export class WorktreePoolFullError extends Error {
  constructor(maxParallelTasks: number) {
    super(
      `all ${maxParallelTasks} warm worktree(s) are in use (maxParallelTasks=${maxParallelTasks}); task stays queued until a slot frees`,
    );
    this.name = "WorktreePoolFullError";
  }
}

export function worktreePoolDir(repo: string, projectId: string): string {
  return join(dirname(repo), ".enjoy-worktrees", projectId);
}

function slotPath(poolDir: string, slot: number): string {
  return join(poolDir, `slot-${slot}`);
}

function leasePath(poolDir: string, slot: number): string {
  return join(poolDir, `slot-${slot}.lease`);
}

function leasedBy(poolDir: string, slot: number): string | null {
  try {
    return readFileSync(leasePath(poolDir, slot), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create the warm pool for a project: `maxParallelTasks` detached
 * worktrees at the base commit, reused across tasks. Existing slots are
 * left exactly as they are. Returns the slot paths.
 */
export function ensureWarmWorktrees(
  repo: string,
  projectId: string,
  maxParallelTasks: number,
  baseCommit: string,
): string[] {
  const poolDir = worktreePoolDir(repo, projectId);
  mkdirSync(poolDir, {
    recursive: true,
  });
  const slots: string[] = [];
  for (let slot = 0; slot < Math.max(0, Math.floor(maxParallelTasks)); slot++) {
    const path = slotPath(poolDir, slot);
    if (!existsSync(path)) git(repo, `worktree add --detach "${path}" ${baseCommit}`);
    slots.push(path);
  }
  return slots;
}

function diffSnapshotPath(task: Task): string {
  return join(dirname(task.worktree), "diffs", `${task.id}.diff`);
}

/**
 * Return a task's pooled worktree to the pool: snapshot its diff first
 * (so the finished task stays reviewable after the slot is reused), then
 * reset the slot clean — ignored warm files survive. No-op for the
 * legacy per-task worktrees, which have no lease.
 */
export function releaseWorktree(task: Task): void {
  // Parked or held work keeps its slot, lease and contents: resetting
  // here would destroy exactly what the park preserved (conflict state,
  // uncommitted secret-like files, work owed a merge/push retry).
  // Everything else — done, failed, planned, queued — releases normally.
  if (task.state === "needs-input") return;
  if (task.branchPushPending || task.mainPushPending) return;
  if (!task.worktree || !existsSync(task.worktree)) return;
  // A finalized task is `done` here, yet its slot may hold uncommitted
  // secret-like leftovers finalize deliberately kept live, or a merge
  // still in progress: never reset those away in the pipeline finally.
  if (mergeInProgress(task.worktree)) return;
  if (preservationBlockers(task.worktree).length) return;
  const poolDir = dirname(task.worktree);
  const slot = Number(task.worktree.split("-").pop());
  if (!Number.isInteger(slot) || leasedBy(poolDir, slot) !== task.id) return;
  try {
    const snapshot = taskDiff(task);
    if (snapshot) {
      mkdirSync(join(poolDir, "diffs"), {
        recursive: true,
      });
      writeFileSync(diffSnapshotPath(task), snapshot);
    }
  } catch {
    // a missing snapshot must not strand the slot
  }
  try {
    git(task.worktree, "reset --hard -q HEAD");
    git(task.worktree, "clean -fdq");
  } catch {
    // next lease resets again before use
  }
  try {
    unlinkSync(leasePath(poolDir, slot));
  } catch {
    // already released
  }
}

/** Lease a free warm slot for this task and reset it onto the base commit. */
function acquireWorktree(
  repo: string,
  task: Task,
  baseCommit: string,
  maxParallelTasks: number,
): string {
  const slots = ensureWarmWorktrees(repo, task.projectId, maxParallelTasks, baseCommit);
  const poolDir = worktreePoolDir(repo, task.projectId);
  // Prefer the slot this task used before: its stored agent sessions were
  // created in that workspace, and the agent refuses to resume elsewhere.
  const prevSlot = Number(task.worktree?.split("-").pop());
  const order = [
    ...slots.keys(),
  ].sort((a, b) => (a === prevSlot ? -1 : b === prevSlot ? 1 : a - b));
  for (const slot of order) {
    const holder = leasedBy(poolDir, slot);
    if (holder !== null && holder !== task.id) continue;
    const path = slotPath(poolDir, slot);
    // Carry-over is allowlist-only: an unleased slot still holding a
    // secret-like or unrecognised ignored file is never handed to a
    // different task. The same task may resume its own slot.
    if (holder !== task.id && preservationBlockers(path).length) continue;
    writeFileSync(leasePath(poolDir, slot), task.id);
    git(path, `reset --hard -q ${baseCommit}`);
    git(path, "clean -fdq");
    try {
      unlinkSync(
        diffSnapshotPath({
          ...task,
          worktree: path,
        }),
      );
    } catch {
      // no stale snapshot from a previous task on this slot
    }
    return path;
  }
  throw new WorktreePoolFullError(maxParallelTasks);
}

/**
 * Resolve the project, prove it is writable, and give the task a worktree.
 * With `maxParallelTasks`, the worktree is leased from the project's warm
 * pool (exactly that many slots; see ensureWarmWorktrees) and a full pool
 * throws WorktreePoolFullError so the caller can leave the task queued.
 * Without it, the legacy one-worktree-per-task path is used. Throws with
 * a plain reason otherwise; callers turn that into a blocked task.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export async function prepareWorktree(
  store: FactoryStore,
  task: Task,
  opts?: {
    maxParallelTasks?: number;
  },
): Promise<Task> {
  const project = await store.readProject(task.projectId);
  if (!project || !store.isProjectOnline(task.projectId)) {
    throw new Error(`project ${task.projectId} is not registered or offline`);
  }
  const repo = realpathSync(project.repoPath);
  try {
    accessSync(repo, constants.W_OK);
    accessSync(join(repo, ".git"), constants.W_OK);
  } catch {
    throw new Error(`project folder is not writable by the factory user: ${repo}`);
  }
  const baseCommit = task.baseCommit || git(repo, "rev-parse HEAD");
  // Pin the decisions baseline once: the hash of all decisions files at
  // the base this task was planned against. While main's hash matches,
  // pickup skips the decisions check entirely.
  const pin = (t: Task): Task =>
    t.decisionsBaselineHash
      ? t
      : {
          ...t,
          decisionsBaselineHash: decisionsHashAt(repo, baseCommit),
        };
  const maxParallelTasks = opts?.maxParallelTasks;
  if (maxParallelTasks !== undefined && maxParallelTasks > 0) {
    // Resume/retry of a task that already holds its slot keeps that slot.
    if (task.worktree && existsSync(task.worktree)) {
      const slot = Number(task.worktree.split("-").pop());
      if (
        Number.isInteger(slot) &&
        leasedBy(worktreePoolDir(repo, task.projectId), slot) === task.id
      ) {
        const next = pin({
          ...task,
          baseCommit,
        });
        await store.writeTask(next);
        return next;
      }
    }
    // Reclaim leaked leases: a slot whose holder task no longer exists
    // (or already finished) can never release it, so it would shrink
    // the pool forever. Live holders (planned/running/in-review/
    // needs-input/blocked) keep their slots untouched.
    const poolDir = worktreePoolDir(repo, task.projectId);
    for (const name of (existsSync(poolDir) ? readdirSync(poolDir) : []).filter((n) =>
      n.endsWith(".lease"),
    )) {
      const holder = readFileSync(join(poolDir, name), "utf8").trim();
      if (!holder || holder === task.id) continue;
      const holderTask = await store.readTask(holder).catch(() => null);
      if (!holderTask || holderTask.state === "done" || holderTask.state === "failed") {
        try {
          unlinkSync(join(poolDir, name));
        } catch {
          /* already gone */
        }
      }
    }
    const worktree = acquireWorktree(repo, task, baseCommit, maxParallelTasks);
    const next = pin({
      ...task,
      worktree,
      baseCommit,
    });
    await store.writeTask(next);
    return next;
  }
  // Worktrees live NEXT TO the project, not inside it: a checkout inside
  // the project pollutes every scan the project runs (tests, linters).
  const worktree =
    task.worktree || join(dirname(repo), ".enjoy-worktrees", task.projectId, task.id);
  if (!existsSync(worktree)) {
    mkdirSync(dirname(worktree), {
      recursive: true,
    });
    try {
      git(repo, `worktree add "${worktree}" -b "task/${task.id}" ${baseCommit}`);
    } catch {
      git(repo, `worktree add "${worktree}" "task/${task.id}"`); // branch already exists (retry)
    }
  }
  const next = pin({
    ...task,
    worktree,
    baseCommit,
  });
  await store.writeTask(next);
  return next;
}

export interface PipelineOptions {
  store: FactoryStore;
  command?: readonly string[];
  timeoutMs?: number;
  now?: () => string;
  maxIterations?: number; // Ralph-loop cap per implementation attempt
  maxReviewRounds?: number; // implement <-> review bounce cap
  maxAttempts?: number; // terminal failure once this many implementation attempts are spent, instead of re-dispatching forever
  maxRedteamRounds?: number; // plan red-team <-> reviser bounce cap
  maxParallelTasks?: number; // warm-pool size / parallel-task cap; unset = legacy per-task worktree
  autoApprove?: boolean; // Settings: plans with no open questions move forward without the owner's click
  visualCapture?: CaptureFn; // Visual Review capture override (tests); default screenshots via Playwright
  providerCommands?: Partial<Record<ProviderId, readonly string[]>>; // per-provider stub runners (tests/demos); forwarded to stations
  visualThreshold?: number; // Visual Review: fraction of differing pixels allowed before a shot counts as changed
}

const isBlockedReply = (summary: string) => /^blocked\b/i.test(summary.trim());
const verdictOf = (summary: string): "pass" | "reject" =>
  /^reject\b/i.test(summary.trim()) ? "reject" : "pass";

function extractContext(worktree: string): string {
  try {
    const files = execSync("git ls-files | head -30", {
      cwd: worktree,
      encoding: "utf8",
      timeout: 10_000,
    });
    return `Files:\n${files}`;
  } catch {
    return "Files: (unavailable)";
  }
}

const BRIEF_KEEP =
  /intent|why|approach|success|steps?|implementation|scope|visual|screenshot|deferred/i;
const BRIEF_DROP = /red-team|redteam|questions for the owner|decisions/i;

/**
 * Execution brief: the small part of a plan an execution or review
 * station actually needs — intent, approach, steps, success criteria.
 * The full plan (with red-team rounds and decision logs appended) stays
 * in the plan artifact for the owner; pasting it into every station
 * card re-bills the same large text at every station, round, and retry.
 * Falls back to a capped head of the plan when no sections match.
 */
export function executionBrief(plan: string, cap = 6000): string {
  const sections: string[] = [];
  let current: string[] = [];
  let keep = false;
  const flush = () => {
    if (keep && current.join("").trim()) sections.push(current.join("\n").trim());
    current = [];
  };
  for (const line of plan.split("\n")) {
    const heading = /^#{1,3}\s+(.*)/.exec(line);
    if (heading) {
      flush();
      const title = heading[1] ?? "";
      keep = BRIEF_KEEP.test(title) && !BRIEF_DROP.test(title);
    }
    if (keep) current.push(line);
  }
  flush();
  const body = sections.join("\n\n").trim();
  const brief = body || plan.trim();
  return brief.length > cap
    ? `${brief.slice(0, cap)}\n[brief truncated at ${cap} chars — full plan is in the plan artifact]`
    : brief;
}

/** Sections of `current` whose text differs from `previous`, by heading. */
export function changedPlanSections(previous: string, current: string): string {
  const split = (text: string): Map<string, string> => {
    const map = new Map<string, string>();
    let title = "(intro)";
    let buf: string[] = [];
    const flush = () => map.set(title, buf.join("\n").trim());
    for (const line of text.split("\n")) {
      const heading = /^#{1,3}\s+(.*)/.exec(line);
      if (heading) {
        flush();
        title = heading[1] ?? title;
        buf = [
          line,
        ];
      } else buf.push(line);
    }
    flush();
    return map;
  };
  const prev = split(previous);
  const changed: string[] = [];
  for (const [title, text] of split(current)) {
    if (text && prev.get(title) !== text) changed.push(text);
  }
  return changed.join("\n\n");
}

/**
 * Plan stage: a planner with codebase context drafts the plan (intent,
 * why, approach, success criteria); an SME red-team and an outsider with
 * no codebase access attack it. The result is stored as an artifact in
 * the project data folder for the owner to approve or shelve.
 */
/**
 * Triage verdict parsing. The triage station is instructed to answer
 * machine-readably; anything unclear, missing, or self-contradictory
 * (a "fast" verdict for a large task) defaults UP to standard — the
 * lane may only ever be earned clearly, never by ambiguity.
 */
function triageTitle(text: string): string {
  const raw = text.match(/title\s*=\s*"([^"]{3,90})"/i)?.[1]?.trim() ?? "";
  return raw.replace(/\s+/g, " ").slice(0, 80);
}

export function parseTriage(text: string): {
  lane: "fast" | "standard" | "careful";
  size: string;
  redteams: number;
  summary: string;
  title: string;
} {
  const title = triageTitle(text);
  const lane = text.match(/lane\s*=\s*(fast|standard|careful)/i)?.[1]?.toLowerCase() as
    | "fast"
    | "standard"
    | "careful"
    | undefined;
  const size = (text.match(/size\s*=\s*(XS|S|M|L|XL)/i)?.[1] ?? "").toUpperCase();
  const asked = Number(text.match(/redteams\s*=\s*([0-2])/i)?.[1] ?? NaN);
  const firstLines = text
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 2)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  if (!lane)
    return {
      lane: "standard",
      size: size || "?",
      redteams: 2,
      summary: `triage unclear — standard lane (${firstLines})`,
      title,
    };
  if (lane === "fast" && (size === "L" || size === "XL" || !size))
    return {
      lane: "standard",
      size,
      redteams: 2,
      summary: `triage said fast but size ${size || "unknown"} — standard lane (${firstLines})`,
      title,
    };
  // The agent decides the review depth for this task; the lane bounds
  // it: fast never gets red-teams, careful always gets both, and in
  // the standard lane the agent may drop to one when the work is small
  // and behaviour-preserving.
  const redteams = lane === "fast" ? 0 : lane === "careful" ? 2 : asked === 1 ? 1 : 2;
  return {
    lane,
    size: size || "?",
    redteams,
    summary: firstLines,
    title,
  };
}

/**
 * Pull an optional "## decisions.md change" section out of a planner's
 * draft, so the plan stays clean and the proposed decisions change is
 * recorded on the task early (at planning, not at merge). Returns the
 * plan without the section and the section body ("" when absent).
 */
function extractDecisionsChange(plan: string): {
  plan: string;
  decisionsChange: string;
} {
  const lines = plan.split("\n");
  const idx = lines.findIndex((l) => /^##\s*decisions?\.md\s*changes?\s*$/i.test(l.trim()));
  if (idx === -1)
    return {
      plan,
      decisionsChange: "",
    };
  // Collect the section body up to the next heading (or end).
  const bodyLines: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n").trim();
  if (!body)
    return {
      plan,
      decisionsChange: "",
    };
  const planLines = [
    ...lines.slice(0, idx),
    ...lines.slice(idx + 1 + bodyLines.length),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    plan: planLines,
    decisionsChange: body,
  };
}

/** Quote a 1-based plan line for a planning-failure message. */
function quotePlanLine(plan: string, n: number): string {
  const line = plan.split("\n")[n - 1] ?? "";
  return `line ${n}: "${line.trim()}"`;
}

const CORRECTION_FILES = [
  "PLAN-CORRECTED.md",
  "PLAN-REVISED.md",
  "PLAN-DRAFT.md",
];

/** Snapshot the correction candidate files before the station runs. */
async function snapshotCorrectionFiles(worktree: string): Promise<Map<string, string | null>> {
  const before = new Map<string, string | null>();
  for (const name of CORRECTION_FILES) {
    try {
      before.set(name, await Bun.file(join(worktree, name)).text());
    } catch {
      before.set(name, null);
    }
  }
  return before;
}

/**
 * The corrected plan: the first candidate file the station rewrote, else
 * the station reply. A file that still holds earlier-pass content is
 * stale, not the fix.
 */
async function readCorrectedPlan(
  worktree: string,
  before: Map<string, string | null>,
  fallback: string,
): Promise<string | null> {
  for (const name of CORRECTION_FILES) {
    try {
      const text = await Bun.file(join(worktree, name)).text();
      if (text.trim() && text !== before.get(name)) return text;
    } catch {
      // missing file: try the next candidate, then the station reply
    }
  }
  return fallback.trim() ? fallback : null;
}

/** Contradicted actions the corrected plan still proposes (must be none). */
function stillProposedActions(corrected: string, actions: Set<string>): Set<string> {
  const still = new Set<string>();
  for (const line of corrected.split("\n")) {
    for (const m of actionMentionsFor(line)) {
      if (m.polarity === "propose" && actions.has(m.action)) still.add(m.action);
    }
  }
  return still;
}

/**
 * Planning-stage consistency correction: when one clause of a draft plan
 * proposes an action another clause forbids for the same canonical danger,
 * the planner fixes the contradiction once, at authoring — before either
 * red-team sees the plan and before any downstream card is built from it.
 * Prohibition wins: the correction must drop the proposal and keep the
 * rule. A correction that keeps proposing the contradicted action, or one
 * that leaves the plan still contradictory, fails planning with the quoted
 * line pair — no drafted plan, no builder card. Sanitised throughout:
 * only the action id plus line numbers cross the card boundary, never
 * clause text, so the correction card passes sanitizeGateVeto unchanged.
 */
async function settlePlanContradictions(
  task: Task,
  opts: PipelineOptions,
  plan: string,
  now: () => string,
): Promise<{
  plan: string;
  corrected: boolean;
}> {
  const { store } = opts;
  const gate = planConsistencyGate(plan);
  if (gate.decision === "allow")
    return {
      plan,
      corrected: false,
    };
  const contradictions = findPlanContradictions(plan);
  const card: JobCard = {
    id: "plan-consistency-fix",
    jobId: task.jobId,
    role: "planner",
    task: [
      "Fix the plan contradiction below — plan only, do not implement.",
      "The current plan is in PLAN-DRAFT.md in your cwd; read it there.",
      "Prohibition wins: remove the PROPOSAL clause and keep the rule that prohibits it; never do the reverse.",
      "Keep every other line of the plan unchanged, including its sections (Intent, Why this is needed, Approach, Success criteria) and any ## Questions for the owner section.",
      "Write the complete corrected plan to PLAN-CORRECTED.md in your cwd (reply first line: PLAN_CORRECTED).",
      ...gate.reasons.map((r) => `- ${r}`),
    ].join("\n"),
    worktree: task.worktree,
    constraints: [
      "plan only; do not implement",
      "prohibition wins: drop the proposal, keep the rule",
    ],
    gates: [],
  };
  await store.writeCard(card);
  await store
    .appendPrompt(task.id, {
      at: now(),
      kind: "system",
      text: `planning: plan contradiction found — planner correcting at authoring (${gate.reasons.join("; ")})`,
    })
    .catch(() => {});
  const before = await snapshotCorrectionFiles(task.worktree);
  const done = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  const pair = contradictions
    .map((c) => `${quotePlanLine(plan, c.lines[0])} vs ${quotePlanLine(plan, c.lines[1])}`)
    .join("; ");
  if (done.status !== "done") {
    throw new Error(`planning failed: plan contradiction could not be corrected (${pair})`);
  }
  const corrected = await readCorrectedPlan(task.worktree, before, done.detail || done.summary);
  if (!corrected) {
    throw new Error(`planning failed: plan contradiction could not be corrected (${pair})`);
  }
  // A correction that rewrites the decisions section is honoured like the
  // first extraction; one with no such section leaves it standing — the
  // caller re-extracts from the returned plan to decide.
  const recheck = planConsistencyGate(corrected);
  const stillProposes = stillProposedActions(
    corrected,
    new Set(contradictions.map((c) => c.action)),
  );
  if (stillProposes.size || recheck.decision === "veto") {
    const why = stillProposes.size
      ? `correction kept the proposed ${[
          ...stillProposes,
        ].join(", ")} and dropped its prohibition (prohibition wins)`
      : "correction left the plan still contradictory";
    throw new Error(`planning failed: plan contradicts itself — ${why} (${pair})`);
  }
  await store
    .appendPrompt(task.id, {
      at: now(),
      kind: "system",
      text: "planning: plan contradiction corrected at authoring — clean plan proceeds to review",
    })
    .catch(() => {});
  return {
    plan: corrected,
    corrected: true,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
async function runPlanPipelineInner(taskId: string, opts: PipelineOptions): Promise<Task> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  let task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  task = await prepareWorktree(store, task, {
    maxParallelTasks: opts.maxParallelTasks,
  });
  const project = await store.readProject(task.projectId);
  // Triage before planning: one cheap station estimates size and risk
  // and picks the process lane. A lane only reduces ceremony (fast =
  // no red-teams, auto-approved plan, single review) — every gate
  // still fires in every lane, and the reviewer stage re-checks the
  // estimate against the actual diff. An owner-set lane is respected
  // and triage is skipped entirely.
  if (!task.lane) {
    const triageCard: JobCard = {
      id: "triage",
      jobId: task.jobId,
      role: "outsider",
      task: [
        `Triage this task before anyone plans it. Reply first line EXACTLY: TRIAGE lane=<fast|standard|careful> size=<XS|S|M|L> redteams=<0|1|2> risks=<none or comma-list> est=<expected stations> title="<a small meaningful title for this task, 3-7 words, like 'Status page at /status' — not a copy of the statement>"`,
        `Second line: the one-sentence reason.`,
        `lane=fast ONLY when all hold: size XS or S (one small surface, no new behaviour or one trivial behaviour), fully reversible in one commit, needs no product/business decision from the owner, and touches NO expensive path (${EXPENSIVE_PATHS.join(", ")}), no schema/migration, no recorded-decisions change, no secret or credential.`,
        `lane=careful when any of: expensive path, schema/migration, decisions change, security-sensitive, or size L.`,
        `Otherwise lane=standard. Any doubt at all means standard — never guess fast.`,
        `You also decide how many red-team reviewers this task's plan gets: redteams=0 only with lane=fast; redteams=1 when the work is small and behaviour-preserving (one subject-matter check is enough); redteams=2 whenever behaviour changes, assumptions are uncertain, or any risk flag is present. When in doubt, 2.`,
        `Task (${task.taskType}, tags ${task.tags.join(", ") || "none"}): ${task.prompt}`,
      ].join("\n"),
      worktree: task.worktree,
      constraints: [
        "triage only; do not plan or implement",
        "first line must be the TRIAGE line",
      ],
      gates: [],
    };
    await store.writeCard(triageCard);
    const triaged = await runStation(triageCard, {
      store,
      command: opts.command,
      providerCommands: opts.providerCommands,
      timeoutMs: opts.timeoutMs,
    }).catch(() => null);
    const verdict =
      triaged?.status === "done"
        ? parseTriage(triaged.detail || triaged.summary)
        : {
            lane: "standard" as const,
            size: "?",
            redteams: 2,
            summary: "triage station did not complete — standard lane",
            title: "",
          };
    task = {
      ...task,
      ...(verdict.title
        ? {
            title: verdict.title,
          }
        : {}),
      lane: verdict.lane,
      triage: verdict.summary,
      redteams: verdict.redteams,
      updatedAt: now(),
    };
    await store.writeTask(task);
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `triage: ${verdict.lane} lane (size ${verdict.size}) — ${verdict.summary}${verdict.lane === "fast" ? " — red-teams skipped, plan will auto-approve, single review" : ` — plan gets ${verdict.redteams} red-team reviewer(s), as triage decided for this task`}`,
      })
      .catch(() => {});
  } else {
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `triage: ${task.lane} lane (set by the owner) — ${task.triage || "no estimate recorded"}`,
      })
      .catch(() => {});
  }
  const similar = await store.similarTasks(task.projectId, task.tags);
  const similarText = similar.length
    ? similar.map((s) => `- ${s.title} [${s.tags.join(", ")}]: ${s.outcome}`).join("\n")
    : "(no similar finished work)";
  // Owner input already on record (answers to earlier plan questions,
  // line comments) rides into a fresh planning pass — e.g. when an
  // answer was queued because the worktree pool was full. Settled
  // decisions are final: apply them, never re-ask them.
  const recordPrompts = await store.listPrompts(taskId).catch(() => []);
  const lastComments = [
    ...recordPrompts,
  ]
    .reverse()
    .find((p) => p.kind === "user" && p.text.startsWith("plan line comments:"));
  const ownerInput = [
    task.settledQuestions?.length
      ? `SETTLED OWNER DECISIONS — final, apply them and never ask them again, in any wording:\n${task.settledQuestions.map((q) => `- ${q}`).join("\n")}\nOwner's answers on record:\n${await settledAnswersOf(store, taskId)}`
      : "",
    lastComments
      ? `Owner plan line comments on record (apply them):\n${lastComments.text.replace(/^plan line comments:\s*/, "")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const deferredRelated = relatedDeferred(
    await store.listDeferred(task.projectId).catch(() => []),
    task,
  );
  const deferredBlock = deferredRelated.length
    ? `\n\nDeferred minor points from earlier red-teams that may relate to this task (judge each: truly related, or ignore it):\n${deferredRelated.map((d) => `- [deferred:${d.id}] ${d.text} (from "${d.sourceTitle}")`).join("\n")}\nFor each truly related point, add a line to a "## Questions for the owner" section asking whether to include it, keeping its [deferred:<id>] marker in the question. The factory also asks these directly, so a duplicate question is harmless.`
    : "";
  const planner: JobCard = {
    id: "planner",
    jobId: task.jobId,
    role: "planner",
    task: `Write the implementation plan for this task and save it as PLAN-DRAFT.md in your cwd (reply first line: PLAN_WRITTEN).\nTask: ${task.prompt}\nType: ${task.taskType}. Tags: ${task.tags.join(", ") || "none"}.\nProject business: ${project?.description || "(none given)"}\nBusiness plan: ${project?.businessPlan || "(none given)"}\nGeneral rules (must respect): ${project?.rules || "(none given)"}\nHow this project is tested (owner-declared): ${project?.testMode ?? "checks"}${project?.testMode === "push-only" ? " — there is no local way to run it, so success criteria must rest on diff review and checks the owner runs after handoff" : ""}${project?.testMode === "dev" ? ` — it can be run interactively (dev command: ${project.devCommand || "not configured"})` : ""}.\nThe plan must state: Intent, Why this is needed, Approach, and Success criteria (how we will know it worked; unit tests where code changes, otherwise a concrete check such as a build, a diff review, or a one-time Playwright run with video).\nSimilar finished work from this project's history:\n${similarText}${ownerInput ? `\n${ownerInput}\n` : ""}${deferredBlock}\nProject context:\n${extractContext(task.worktree)}\n\nRecorded decisions: if this task changes the repo's decisions.md, append a final section to PLAN-DRAFT.md headed exactly "## decisions.md change" containing ONLY the exact bullet lines to add or change in that file — no surrounding prose. If it does not change them, do not add that section.\nPrerequisites: if this task builds on a predecessor commit or symbol that might not be in the base yet (named in the task or known to you), append a final section headed exactly "## prerequisites" with one bullet per item: "- commit: <sha>" for a predecessor commit, "- symbol: <name>" or "- symbol: <name> in <path>" for a symbol it adds, "- pending: <what is not yet knowable>" when the predecessor cannot be named yet. A builder is never dispatched until every listed item is in the base, so list only real prerequisites; when the task is independent, omit the section.\nVisual moments: if this task creates or changes any page or UI (new/changed routes, pages, components, templates or styles), append a section headed exactly "## Visual moments" with one bullet per key moment: "- name: /route", optionally " @1280x720" for a viewport and " | click:<selector>", " | fill:<selector>=<value>", " | press:<key>" or " | wait:<ms>" for steps before the screenshot. Cover every new page and every existing page the change affects — these become the e2e screenshots diffed against the base commit for the owner to approve before landing. If no page is affected, omit the section.`,
    worktree: task.worktree,
    constraints: [
      "plan only; do not implement",
      "state intent, why, approach, success criteria",
    ],
    gates: [],
  };
  await store.writeCard(planner);
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: "planning: planner started (extracting context, drafting)",
    })
    .catch(() => {});
  const planned = await runStation(planner, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  if (planned.status !== "done") throw new Error(`planner failed: ${planned.summary}`);
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: "planning: planner finished, red-teaming the plan",
    })
    .catch(() => {});
  const planText = await Bun.file(join(task.worktree, "PLAN-DRAFT.md"))
    .text()
    .catch(() => planned.summary);

  // A needed decisions.md change is identified here, at planning — not
  // first discovered when the task lands. The plan stays clean (the section
  // is lifted out) and the proposed lines are recorded on the task.
  let finalPlan = planText;
  const extractedDecisions = extractDecisionsChange(planText);
  finalPlan = extractedDecisions.plan;
  if (extractedDecisions.decisionsChange) {
    task = {
      ...task,
      decisionsChange: extractedDecisions.decisionsChange,
      updatedAt: now(),
    };
    await store.writeTask(task);
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `decisions.md change identified at planning (not at merge):\n${extractedDecisions.decisionsChange}`,
      })
      .catch(() => {});
  }

  // Planning-stage consistency: a plan that proposes an action another
  // line forbids is fixed once, at authoring — before either red-team
  // sees it and before any downstream card is built from it. Covers the
  // initial draft in every lane, including the fast lane below.
  const settled = await settlePlanContradictions(task, opts, finalPlan, now);
  if (settled.corrected) {
    const reExtracted = extractDecisionsChange(settled.plan);
    if (reExtracted.decisionsChange) {
      task = {
        ...task,
        decisionsChange: reExtracted.decisionsChange,
        updatedAt: now(),
      };
      await store.writeTask(task);
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `decisions.md change re-extracted from the corrected plan:\n${reExtracted.decisionsChange}`,
        })
        .catch(() => {});
    }
    finalPlan = reExtracted.decisionsChange ? reExtracted.plan : settled.plan;
  }

  // Pin the plan to the commit it was drafted against: the builder
  // gate refuses to implement a plan whose base has since moved.
  const planBase = await planBaseFor(store, task);

  // Fast lane: the triage already judged this small and safe, so the
  // plan goes straight through — no red-teams, no owner approval wait.
  // Every gate still applies downstream, and the review stage escalates
  // back to standard if the actual diff outgrows the estimate.
  if (task.lane === "fast") {
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: "triage fast lane: red-teams skipped; plan auto-approved and queued for implementation",
      })
      .catch(() => {});
    const drafted = {
      ...draftPlan(task, finalPlan, now(), [], planBase),
      planRequested: false,
    };
    const approved = approvePlan(drafted, now());
    await store.writeTask(approved);
    return approved;
  }
  const revised = await redteamReview(task, opts, finalPlan, now);
  let draftedPlan = revised.plan;
  let draftedQuestions = revised.questions;
  if (deferredRelated.length) {
    const appendix = `\n\n## Deferred minor points offered with this plan\n${deferredRelated.map((d) => `- [deferred:${d.id}] ${d.text} (from "${d.sourceTitle}")`).join("\n")}`;
    if (!draftedPlan.includes("## Deferred minor points offered")) draftedPlan += appendix;
    draftedQuestions = [
      ...draftedQuestions,
      ...deferredRelated.map((d) => deferredQuestion(d)),
    ];
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `planning: ${deferredRelated.length} deferred minor point(s) from earlier red-teams look related to this task — they are asked as plan questions; include folds them into this plan, skip leaves them deferred`,
      })
      .catch(() => {});
  }
  const drafted = {
    ...draftPlan(task, draftedPlan, now(), draftedQuestions, planBase),
    planRequested: false,
  };
  // Settings default: a plan with no open questions moves forward on
  // its own — the owner's click is only required when they opted into
  // it, or when questions remain (approvePlan refuses those anyway).
  if (opts.autoApprove && !draftedQuestions.length) {
    const approved = approvePlan(drafted, now());
    await store.writeTask(approved);
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: "plan auto-approved — Settings move plans forward without a click; implementation starts automatically",
      })
      .catch(() => {});
    return approved;
  }
  await store.writeTask(drafted);
  return drafted;
}

/**
 * Red-team review of a plan, iterated like a human design review: both
 * red-teams critique, the planner decides on every point, and the
 * REVISED plan goes back to the same red-teams. Rounds continue until
 * both pass, the planner leaves a point to the owner (further rounds
 * are pointless until the owner answers — answering re-runs this), or
 * the round cap is hit; on the final round the planner must settle
 * still-contested points or escalate them to the owner. Every round is
 * written into the plan artifact. Used for the first plan and again
 * after owner answers or line comments.
 */

/** Write MINOR red-team points to the project deferred list and log it. Returns how many were newly recorded. */
async function deferMinorPoints(
  store: FactoryStore,
  task: Task,
  minors: string[],
  now: () => string,
): Promise<number> {
  if (!minors.length) return 0;
  const points = minors.map((text, i) =>
    newDeferredPoint({
      id: `def-${task.id}-${i}`,
      projectId: task.projectId,
      sourceTaskId: task.id,
      sourceTitle: task.title,
      text,
      tags: task.tags ?? [],
      at: now(),
    }),
  );
  const added = await store.addDeferred(task.projectId, points).catch(() => []);
  if (added.length)
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text: `red-team: ${added.length} minor point(s) deferred to the project list instead of bouncing the plan — they will be offered as a plan question on the next related task: ${added.map((d) => `"${d.text}"`).join("; ")}`,
      })
      .catch(() => {});
  return added.length;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function redteamReview(
  task: Task,
  opts: PipelineOptions,
  planText: string,
  now: () => string,
): Promise<{
  plan: string;
  questions: string[];
}> {
  const { store } = opts;
  const taskId = task.id;
  const maxRounds = Math.max(1, opts.maxRedteamRounds ?? 3);
  const project = await store.readProject(task.projectId);
  const plansDir = join(project?.repoPath ?? task.worktree, "data", "plans");
  mkdirSync(plansDir, {
    recursive: true,
  });
  // Consistency at the review boundary: an updated plan entering through
  // owner answers or line comments is settled here, before drafting — the
  // initial pipeline already settled its draft above, so this is a no-op
  // there and a correction here.
  const entered = await settlePlanContradictions(task, opts, planText, now);
  if (entered.corrected) {
    const reExtracted = extractDecisionsChange(entered.plan);
    if (reExtracted.decisionsChange) {
      task = {
        ...task,
        decisionsChange: reExtracted.decisionsChange,
        updatedAt: now(),
      };
      await store.writeTask(task).catch(() => {});
    }
    planText = reExtracted.decisionsChange ? reExtracted.plan : entered.plan;
  }
  const sections: string[] = [
    `# Plan: ${task.title}`,
    "",
    `Task: ${task.prompt}`,
    `Type: ${task.taskType} · Tags: ${task.tags.join(", ") || "none"} · Base commit: ${task.baseCommit}`,
    "",
    "## Draft plan (planner, with codebase context)",
    planText,
    "",
  ];
  let current = planText;
  let previous = "";
  let questions: string[] = [];
  let smeVerdict = "pass";
  // With one red-team (as triage decided for this task) there is no
  // outsider: the label below says so instead of faking a verdict.
  let outsiderVerdict = task.redteams >= 2 ? "pass" : "skipped by triage";
  let agreed = false;
  let revised = false; // a reviser pass actually rewrote the plan (false on a round-1 accept)
  for (let round = 1; round <= maxRounds; round++) {
    const smeCard: JobCard = {
      id: "redteam-sme",
      jobId: task.jobId,
      role: "redteam",
      task: `Red-team this plan as a subject-matter expert${round > 1 ? ` (re-review round ${round}: the planner revised the plan after your previous critique — judge the CURRENT text, and pass it if your points were settled)` : ""}. Reply first line PASS or REJECT, then show your thoughts and arguments, one per line, each with its evidence: is the intent right, is the approach sound against this codebase, what breaks, what is missing? Tag every point you raise: start the line with '- MAJOR:' when the plan cannot ship without fixing it, or '- MINOR:' when it is worth fixing later but does not block this plan. Reply PASS when you have no MAJOR point; MINOR points alone never reject.\nStanding rule: the owner's stated requests and decisions are authoritative. Question them only where code or facts significantly contradict them, or where they conflict with decisions.md — in a conflict, flag it for the owner instead of silently overriding the recorded decision. Never reject merely because the owner provided no measured evidence for their own experience.\nYour persona for this project:\n${project ? smePersona(project) : "(no project context)"}\nPlan:\n${current}`,
      worktree: task.worktree,
      constraints: [
        "review only",
        "first line must be PASS or REJECT",
      ],
      gates: [],
    };
    const outsiderCard: JobCard = {
      id: "redteam-outsider",
      jobId: task.jobId,
      role: "outsider",
      task: `Red-team this plan as an outside reviewer with no knowledge of the codebase${round > 1 ? ` (re-review round ${round}: the planner revised the plan after your previous critique — judge the CURRENT text, and pass it if your points were settled)` : ""}. Reply first line PASS or REJECT, then show your thoughts and arguments, one per line: why this, why now, why is this solution correct — or why not? Challenge every unstated assumption. Tag every point you raise: start the line with '- MAJOR:' when the plan cannot ship without fixing it, or '- MINOR:' when it is worth fixing later but does not block this plan. Reply PASS when you have no MAJOR point; MINOR points alone never reject.\nStanding rule: the owner's stated requests and decisions are authoritative. Question them only where facts significantly contradict them, or where they conflict with decisions.md — in a conflict, flag it for the owner instead of silently overriding the recorded decision. Never reject merely because the owner provided no measured evidence for their own experience.\nPlan:\n${current}`,
      worktree: plansDir, // deliberately outside the codebase: judgment without code context
      constraints: [
        "review only",
        "first line must be PASS or REJECT",
        "no codebase access by design",
      ],
      gates: [],
    };
    // Re-review rounds resume the same reviewer sessions, which
    // already hold the previous plan: send only changed sections.
    const changed = round > 1 ? changedPlanSections(previous, current) : "";
    const deltaTask =
      round > 1
        ? `Re-review round ${round}: the planner revised the plan after your previous critique. The previous plan and your critique are already in this session; unchanged sections stand as you saw them. Reply first line PASS or REJECT, then your arguments with evidence. Judge whether your points were settled.\nChanged sections:\n${changed || "(no section-level changes detected — judge the plan as revised)"}`
        : undefined;
    await store.writeCard(smeCard);
    const sme = await runStation(smeCard, {
      store,
      command: opts.command,
      providerCommands: opts.providerCommands,
      timeoutMs: opts.timeoutMs,
      deltaTask,
    });
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "agent",
        text: `redteam-sme (round ${round}): ${(sme.detail || sme.summary).slice(0, 2000)}`,
      })
      .catch(() => {});
    let outsider: {
      summary: string;
      detail: string;
    } | null = null;
    if (task.redteams >= 2) {
      await store.writeCard(outsiderCard);
      outsider = await runStation(outsiderCard, {
        store,
        command: opts.command,
        providerCommands: opts.providerCommands,
        timeoutMs: opts.timeoutMs,
        deltaTask,
      });
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "agent",
          text: `redteam-outsider (round ${round}): ${(outsider.detail || outsider.summary).slice(0, 2000)}`,
        })
        .catch(() => {});
      outsiderVerdict = verdictOf(outsider.summary);
    } else if (round === 1) {
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: "planning: triage gave this task one red-team reviewer — the outside reviewer is skipped for this task",
        })
        .catch(() => {});
    }
    smeVerdict = verdictOf(sme.summary);
    sections.push(
      `## Red-team round ${round}: subject-matter expert — ${smeVerdict.toUpperCase()}`,
      sme.detail || sme.summary,
      "",
      ...(outsider
        ? [
            `## Red-team round ${round}: outside reviewer (no codebase access) — ${outsiderVerdict.toUpperCase()}`,
            outsider.detail || outsider.summary,
            "",
          ]
        : [
            `## Red-team round ${round}: outside reviewer — SKIPPED BY TRIAGE (one red-team task)`,
            "",
          ]),
    );
    const smePoints = parseRedteamPoints(
      sme.detail || sme.summary,
      smeVerdict === "reject" ? "reject" : "pass",
    );
    const outsiderPoints = outsider
      ? parseRedteamPoints(
          outsider.detail || outsider.summary,
          outsiderVerdict === "reject" ? "reject" : "pass",
        )
      : {
          majors: [] as string[],
          minors: [] as string[],
        };
    const minorPoints = [
      ...smePoints.minors,
      ...outsiderPoints.minors,
    ];
    const majorPoints = [
      ...smePoints.majors,
      ...outsiderPoints.majors,
    ];
    // Minor-only rejection: no reviser pass, no re-review round. The plan
    // is accepted as drafted and the minor points are deferred to the
    // project list, to resurface as a plan question on a related task.
    if (
      minorPoints.length &&
      !majorPoints.length &&
      (smeVerdict === "reject" || outsiderVerdict === "reject")
    ) {
      await deferMinorPoints(store, task, minorPoints, now);
      sections.push(
        "## Deferred minor points (accepted without revision; deferred to the project list)",
        ...minorPoints.map((m) => `- MINOR: ${m}`),
        "",
      );
      agreed = true;
      if (round === 1) questions = ownerQuestions(current, task.settledQuestions ?? []);
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `planning: red-teams raised only minor points (${minorPoints.length}) — plan accepted as drafted, no revision round; points deferred`,
        })
        .catch(() => {});
      break;
    }
    // A plan both red-teams pass is accepted without a reviser pass. On the
    // first round this takes the draft as-is — the common, cheap case — and
    // skips the re-review. Questions already in the plan (answer/comment
    // flows re-review a plan the reviser already shaped) are still surfaced.
    if (smeVerdict === "pass" && (task.redteams < 2 || outsiderVerdict === "pass")) {
      await deferMinorPoints(store, task, minorPoints, now);
      agreed = true;
      if (round === 1) questions = ownerQuestions(current, task.settledQuestions ?? []);
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text:
            round > 1
              ? `planning: red-teams agreed on round ${round} — ${task.redteams >= 2 ? "both pass" : "the red-team passes"} the revised plan`
              : `planning: red-teams passed the plan on the first round — ${task.redteams >= 2 ? "both pass" : "the red-team passes"}; the plan is accepted as drafted, no revision round`,
        })
        .catch(() => {});
      break;
    }
    const critiques = [
      `Subject-matter expert (${smeVerdict.toUpperCase()}):\n${sme.detail || sme.summary}`,
      ...(outsider
        ? [
            `Outside reviewer, no codebase access (${outsiderVerdict.toUpperCase()}):\n${outsider.detail || outsider.summary}`,
          ]
        : []),
    ].join("\n\n");
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `planning: red-teams done (round ${round}), planner deciding on each point`,
      })
      .catch(() => {});
    const finalRound = round === maxRounds;
    const settledAnswers = task.settledQuestions?.length
      ? await settledAnswersOf(store, task.id)
      : "";
    const revision = await revisePlan(task, opts, {
      plan: current,
      critiques,
      finalRound,
      settledQuestions: task.settledQuestions ?? [],
      settledAnswers,
    });
    previous = current;
    current = revision.plan;
    questions = revision.questions;
    // A contradiction the reviser introduced is corrected at authoring,
    // then verified by re-review: questions are recomputed from the
    // corrected plan so no stale question survives the fix.
    const fixed = await settlePlanContradictions(task, opts, current, now);
    if (fixed.corrected) {
      const reExtracted = extractDecisionsChange(fixed.plan);
      current = reExtracted.decisionsChange ? reExtracted.plan : fixed.plan;
      if (reExtracted.decisionsChange) {
        task = {
          ...task,
          decisionsChange: reExtracted.decisionsChange,
          updatedAt: now(),
        };
        await store.writeTask(task).catch(() => {});
      }
      questions = ownerQuestions(current, task.settledQuestions ?? []);
      revised = true;
      sections.push(
        `## Consistency correction after round ${round} (prohibition wins)`,
        current,
        "",
      );
      continue; // next round is the verification re-review of the fix
    }
    revised = true;
    sections.push(
      `## Revised plan after round ${round} (planner's decision on each red-team point)`,
      current,
      "",
    );
    if (questions.length) break; // owner decides next; answering re-runs the whole review
    if (finalRound) {
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `planning: red-teams still not agreed after ${maxRounds} round(s) — remaining points stand as the planner decided them; see the plan artifact`,
        })
        .catch(() => {});
    }
  }
  const finalSections = [
    ...sections,
  ];
  // A reviser pass produces a revised-plan section; a plan accepted on the
  // first round keeps its draft heading and needs no such section.
  const artifact = revised
    ? [
        ...finalSections,
        "## Revised plan (planner's decision on each red-team point)",
        current,
        "",
      ].join("\n")
    : finalSections.join("\n");
  await store.writePlanArtifact(task, artifact);
  const asks = questions.length ? `, ${questions.length} point(s) need your decision` : "";
  const roundsNote = agreed && revised ? " (red-teams agreed after re-review)" : "";
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "agent",
      text: `planner: ${revised ? "plan revised after red-team" : "plan accepted after red-team review"}; SME ${smeVerdict}, outsider ${outsiderVerdict}${asks}${roundsNote} (artifact in data/plans)`,
    })
    .catch(() => {});
  return {
    plan: current,
    questions,
  };
}

/** Repo HEAD a (re)drafted plan is pinned to; "" when unknown. */
async function planBaseFor(store: FactoryStore, task: Task): Promise<string> {
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath) return "";
  try {
    return git(project.repoPath, "rev-parse HEAD");
  } catch {
    return "";
  }
}

/**
 * Stale-plan gate: a plan is attached to the last commit hash it was
 * drafted against. If main has moved since, the builder must not
 * implement it — the task parks in needs-input for a re-plan (or an
 * owner decision to proceed anyway). Legacy plans with no pin are
 * pinned to current HEAD on first sight and proceed. Returns the
 * refusal summary when the plan is stale, else null.
 */
export async function stalePlanRefusal(store: FactoryStore, task: Task): Promise<string | null> {
  if (!task.planBaseCommit) {
    const head = await planBaseFor(store, task);
    if (head)
      await store
        .writeTask({
          ...task,
          planBaseCommit: head,
        })
        .catch(() => {});
    return null;
  }
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath) return null;
  let head = "";
  try {
    head = git(project.repoPath, "rev-parse HEAD");
  } catch {
    return null;
  }
  if (!head || head === task.planBaseCommit) return null;
  let moved = 0;
  try {
    moved = Number(git(project.repoPath, `rev-list --count ${task.planBaseCommit}..${head}`)) || 0;
  } catch {
    moved = 0;
  }
  if (moved === 0) return null;
  // Owner sovereignty: an explicit "proceed anyway" reply re-pins the
  // plan to current HEAD and the builder goes ahead on it.
  const prompts = await store.listPrompts(task.id).catch(() => []);
  const lastUser = [
    ...prompts,
  ]
    .reverse()
    .find((p) => p.kind === "user");
  if (lastUser && /proceed anyway/i.test(lastUser.text)) {
    await store
      .writeTask({
        ...task,
        planBaseCommit: head,
      })
      .catch(() => {});
    await store
      .appendPrompt(task.id, {
        at: new Date().toISOString(),
        kind: "system",
        text: `stale plan accepted by the owner — plan re-pinned to ${head.slice(0, 7)} and the builder proceeds on it`,
      })
      .catch(() => {});
    return null;
  }
  return `stale plan: this plan was drafted against ${task.planBaseCommit.slice(0, 7)} but main is now ${head.slice(0, 7)} (${moved} commit(s) later) — the builder was stopped before implementing it. Re-plan against the current code, or state a fresh task; replying "proceed anyway" resumes the builder on this plan.`;
}

/**
 * Agent-checked stale plan: instead of interrupting the owner, a
 * planner station reviews the plan against what actually changed
 * since its base commit. STILL_HOLDS re-pins the plan to HEAD and
 * the builder continues; NEEDS_REPLAN (or an unusable verdict) parks
 * the task with the agent's questions — that is the only case the
 * owner hears about. Fail closed: a failed check parks, never builds.
 */
export async function resolveStalePlan(
  store: FactoryStore,
  task: Task,
  opts: PipelineOptions,
): Promise<{
  proceed: boolean;
  note: string;
}> {
  const refusal = await stalePlanRefusal(store, task);
  if (!refusal)
    return {
      proceed: true,
      note: "",
    };
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath || !task.planBaseCommit)
    return {
      proceed: false,
      note: refusal,
    };
  let head = "";
  let diffStat = "";
  try {
    head = git(project.repoPath, "rev-parse HEAD");
    diffStat = git(project.repoPath, `diff --stat ${task.planBaseCommit}..${head}`).slice(0, 4000);
  } catch {
    return {
      proceed: false,
      note: refusal,
    };
  }
  const card: JobCard = {
    id: "plan-revalidator",
    jobId: task.jobId,
    role: "planner",
    task: [
      "STALE PLAN CHECK — do not implement anything, do not edit files.",
      `This task's plan was drafted against commit ${task.planBaseCommit.slice(0, 7)}; main is now ${head.slice(0, 7)}.`,
      "Decide whether the plan still holds against the current code, using the plan and the change summary below. Check the files and assumptions the plan names: if the commits since the base touched them in ways that break the plan's approach, say so; if the plan's steps still apply unchanged, say so.",
      "Reply first line exactly STILL_HOLDS or NEEDS_REPLAN. After that line: if STILL_HOLDS, one line saying what you checked. If NEEDS_REPLAN, list the specific questions the owner must answer (one per line, each starting with '- ') — only questions a human must decide, not things an agent could re-plan alone.",
      `\n## Plan (execution brief)\n${executionBrief(task.plan)}`,
      `\n## What changed since the plan (${task.planBaseCommit.slice(0, 7)}..${head.slice(0, 7)})\n${diffStat || "(no diff stat available)"}`,
    ].join("\n"),
    worktree: task.worktree,
    constraints: [
      "stay inside this worktree",
      "read-only check: do not edit any file",
    ],
    gates: [],
  };
  await store.writeCard(card);
  const verdict = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  const first = (verdict.summary.split("\n").find((l) => l.trim()) ?? "").trim().toUpperCase();
  if (verdict.status === "done" && first.startsWith("STILL_HOLDS")) {
    await store
      .writeTask({
        ...task,
        planBaseCommit: head,
      })
      .catch(() => {});
    const note = `stale-plan check: an agent reviewed this plan (drafted against ${task.planBaseCommit.slice(0, 7)}) against main at ${head.slice(0, 7)} and judged it still holds — plan re-pinned to ${head.slice(0, 7)} and the builder continues; no owner input needed`;
    await store
      .appendPrompt(task.id, {
        at: new Date().toISOString(),
        kind: "system",
        text: note,
      })
      .catch(() => {});
    return {
      proceed: true,
      note,
    };
  }
  const questions =
    verdict.status === "done" && first.startsWith("NEEDS_REPLAN")
      ? `stale plan: an agent checked this plan (drafted against ${task.planBaseCommit.slice(0, 7)}) against main at ${head.slice(0, 7)} and judged it no longer holds. The builder was stopped. Questions for you:\n${verdict.detail || verdict.summary}`
      : `stale plan: the automatic still-holds check could not complete (${verdict.summary || "no verdict"}), so the builder was stopped rather than implement a possibly stale plan. Re-plan, or reply "proceed anyway" to build this plan as-is.`;
  return {
    proceed: false,
    note: questions,
  };
}

/**
 * Prerequisite gate, tick side: verify every plan-stated prerequisite
 * against current HEAD (what pickup will build on) before a task takes a
 * dispatch slot. A missing item defers the task — it stays planned, no
 * builder starts, no attempt is consumed — and the slot goes to the next
 * ready task. After PREREQ_DEFERRAL_LIMIT consecutive deferrals for the
 * same missing set, the stored deferral output is read back, the base is
 * re-checked, and a still-missing set escalates the task to blocked. A
 * malformed section blocks immediately: it can never resolve by waiting.
 * Returns "proceed" only when the task may take a slot this tick.
 */
async function gatePrereqsForDispatch(
  store: FactoryStore,
  task: Task,
  now: string,
): Promise<"proceed" | "held"> {
  const parsed = parsePlanPrereqs(task.plan ?? "");
  if (!parsed.present) return "proceed";
  if (parsed.malformed.length) {
    await store
      .appendPrompt(task.id, {
        at: now,
        kind: "system",
        text: malformedNote(parsed.malformed, "tick check"),
      })
      .catch(() => {});
    await store.moveTask(task.id, "blocked", now).catch(() => {});
    return "held";
  }
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath) return "proceed";
  const prompts = await store.listPrompts(task.id).catch(() => []);
  if (ownerOverrideAfter(prompts)) {
    await store
      .appendPrompt(task.id, {
        at: now,
        kind: "system",
        text: `${PREREQ_OVERRIDE_PREFIX} the owner said "proceed anyway" — skipping the prerequisite check once; a later tick checks again.`,
      })
      .catch(() => {});
    return "proceed";
  }
  let head = "";
  try {
    head = git(project.repoPath, "rev-parse HEAD");
  } catch {
    return "proceed";
  }
  if (!head) return "proceed";
  const checked = checkPrereqs(project.repoPath, head, parsed.items);
  if (!checked.missing.length) {
    if (prompts.some((p) => p.text.startsWith(PREREQ_DEFER_PREFIX)))
      await store
        .appendPrompt(task.id, {
          at: now,
          kind: "system",
          text: "prereq arrived: every plan-stated prerequisite is now in the base — dispatching.",
        })
        .catch(() => {});
    return "proceed";
  }
  const setKey = prereqSetKey(checked.missing);
  const run = consecutiveDeferrals(prompts, setKey);
  if (run.length >= PREREQ_DEFERRAL_LIMIT - 1) {
    await store
      .appendPrompt(task.id, {
        at: now,
        kind: "system",
        text: blockedNote(parsed.items, checked.missing, checked.base, run),
      })
      .catch(() => {});
    await store.moveTask(task.id, "blocked", now).catch(() => {});
    return "held";
  }
  await store
    .appendPrompt(task.id, {
      at: now,
      kind: "system",
      text: deferralNote(parsed.items, checked.missing, checked.base, "tick check"),
    })
    .catch(() => {});
  return "held";
}

/**
 * Prerequisite gate, pipeline side: re-verify against the final
 * prepared/picked-up base (main may have been re-pinned since the tick).
 * A missing item sends the task back to planned before the builder loop
 * — no attempt is consumed — and frees its worktree slot; the tick owns
 * the deferral count and the escalation. A malformed section blocks.
 */
async function gatePrereqsForPipeline(
  store: FactoryStore,
  task: Task,
  repoPath: string | undefined,
  now: string,
): Promise<"proceed" | "deferred" | "malformed"> {
  const parsed = parsePlanPrereqs(task.plan ?? "");
  if (!parsed.present) return "proceed";
  if (parsed.malformed.length) {
    await store
      .appendPrompt(task.id, {
        at: now,
        kind: "system",
        text: malformedNote(parsed.malformed, "pipeline re-check"),
      })
      .catch(() => {});
    return "malformed";
  }
  if (!repoPath) return "proceed";
  const prompts = await store.listPrompts(task.id).catch(() => []);
  if (ownerOverrideAfter(prompts, true)) {
    await store
      .appendPrompt(task.id, {
        at: now,
        kind: "system",
        text: `${PREREQ_OVERRIDE_PREFIX} the owner said "proceed anyway" — skipping the prerequisite check once; a later tick checks again.`,
      })
      .catch(() => {});
    return "proceed";
  }
  const checked = checkPrereqs(repoPath, task.baseCommit, parsed.items);
  if (!checked.missing.length) return "proceed";
  await store
    .appendPrompt(task.id, {
      at: now,
      kind: "system",
      text: deferralNote(parsed.items, checked.missing, checked.base, "pipeline re-check"),
    })
    .catch(() => {});
  return "deferred";
}

/** Plan pipeline: runs the inner pipeline, then returns its warm slot. */
export async function runPlanPipeline(taskId: string, opts: PipelineOptions): Promise<Task> {
  try {
    return await runPlanPipelineInner(taskId, opts);
  } finally {
    const task = await opts.store.readTask(taskId).catch(() => null);
    if (task) releaseWorktree(task);
  }
}

/**
 * The planner's pass over red-team feedback: every point is either applied
 * to the plan, declined with a reason, or left to the owner as a question.
 * With `answers`, the same station re-decides the open questions using the
 * owner's replies.
 */
async function revisePlan(
  task: Task,
  opts: PipelineOptions,
  input: {
    plan: string;
    critiques?: string;
    questions?: string[];
    answers?: string;
    comments?: string;
    finalRound?: boolean;
    settledQuestions?: string[];
    settledAnswers?: string;
  },
): Promise<{
  plan: string;
  questions: string[];
}> {
  const { store } = opts;
  const settledBlock = input.settledQuestions?.length
    ? `\n\nSETTLED OWNER DECISIONS — the owner already answered these; they are final. Apply them in the plan and NEVER ask them again, in any wording:\n${input.settledQuestions.map((q) => `- ${q}`).join("\n")}${input.settledAnswers ? `\nOwner's answers on record:\n${input.settledAnswers}` : ""}`
    : "";
  const brief =
    (input.comments
      ? `The owner commented on individual lines of your plan. Apply every comment: change the plan where the comment asks for a change, or keep the line and record why. Phrase anything only the owner can settle as a question.\nOwner's line comments:\n${input.comments}`
      : input.answers
        ? `The owner answered your open questions. Apply their decisions to the plan.\nYour open questions were:\n${(input.questions ?? []).map((q) => `- ${q}`).join("\n")}\nOwner's answers:\n${input.answers}`
        : `Two red-teams reviewed your plan. Decide on EVERY point they raised, one by one:\n- CHANGED: the point is right; change the plan accordingly.\n- KEPT: the point is wrong or not worth it; keep the plan and give the reason.\n- OWNER: only when it is a product or business call you cannot settle from the task, the code or the project rules; phrase it as one question the owner can answer.\nRed-team feedback:\n${input.critiques}${input.finalRound ? `\nThis is the FINAL re-review round: the red-teams have already seen your previous decisions and still object. For every point you would otherwise KEPT against a still-rejecting red-team, either change the plan to settle it or escalate it as an OWNER question — planner-versus-red-team standoffs are the owner's to arbitrate, not yours to win by repetition.` : ""}`) +
    settledBlock;
  const card: JobCard = {
    id: "plan-reviser",
    jobId: task.jobId,
    role: "planner",
    task: `${brief}\n\nWrite the complete updated plan to PLAN-REVISED.md in your cwd (reply first line: PLAN_REVISED). Keep the plan's sections (Intent, Why this is needed, Approach, Success criteria), then add "## Red-team decisions" (one line per point: CHANGED / KEPT / OWNER, the point, and why) and end with "## Questions for the owner": one "- " line per OWNER point, or the single line "None".\nCurrent plan:\n${input.plan}`,
    worktree: task.worktree,
    constraints: [
      "plan only; do not implement",
      "decide every red-team point: CHANGED, KEPT with a reason, or OWNER",
    ],
    gates: [],
  };
  await store.writeCard(card);
  // A resumed reviser session already holds the current plan (it
  // wrote PLAN-REVISED.md): send only the new feedback to decide on.
  const deltaTask = `${brief}\n\nUpdate PLAN-REVISED.md in your cwd — the current plan is already in this session and in that file. Write the complete updated plan there (reply first line: PLAN_REVISED). Keep the plan's sections (Intent, Why this is needed, Approach, Success criteria), then add "## Red-team decisions" (one line per point: CHANGED / KEPT / OWNER, the point, and why) and end with "## Questions for the owner": one "- " line per OWNER point, or the single line "None".`;
  const done = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
    deltaTask,
  });
  if (done.status !== "done") throw new Error(`plan revision failed: ${done.summary}`);
  const plan = await Bun.file(join(task.worktree, "PLAN-REVISED.md"))
    .text()
    .catch(() => done.detail || done.summary);
  return {
    plan,
    questions: ownerQuestions(plan, input.settledQuestions ?? []),
  };
}

/**
 * The "- " lines under "## Questions for the owner"; none when the
 * section says None or is missing. Questions the owner already answered
 * (passed in `answered`) never come back: the reviser sometimes
 * re-emits a settled question verbatim in the new plan, and without
 * this filter the owner is asked the same thing every round — the
 * "keeps getting the same questions" loop. Matching is normalized
 * (whitespace, punctuation, case) so trivial rewording loses.
 */
const normQuestion = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/**
 * Is this question the same topic as one the owner already settled?
 * Exact normalized match, or heavy token overlap (>= 0.6 Jaccard on
 * normalized words) — a reworded re-ask of a settled decision is still
 * the settled decision, and the owner is never asked it again.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export function isSettledQuestion(question: string, settled: string[]): boolean {
  const q = normQuestion(question);
  if (!q) return false;
  const tokens = new Set(q.split(" ").filter((w) => w.length > 2));
  for (const s of settled) {
    const sn = normQuestion(s);
    if (!sn) continue;
    if (sn === q) return true;
    const st = new Set(sn.split(" ").filter((w) => w.length > 2));
    if (!tokens.size || !st.size) continue;
    let shared = 0;
    for (const t of tokens) if (st.has(t)) shared++;
    if (shared / (tokens.size + st.size - shared) >= 0.6) return true;
  }
  return false;
}

export function ownerQuestions(plan: string, answered: string[] = []): string[] {
  const section = plan.split(/^##\s+Questions for the owner\s*$/im)[1];
  if (!section) return [];
  const body = section.split(/^##\s/m)[0] ?? "";
  return body
    .split("\n")
    .map((l) => l.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter((q) => q && !/^none\.?$/i.test(q))
    .filter((q) => !isSettledQuestion(q, answered));
}

/** The owner's recorded answers to plan questions, newest flow of the dialogue. */
async function settledAnswersOf(store: FactoryStore, taskId: string): Promise<string> {
  const prompts = await store.listPrompts(taskId).catch(() => []);
  return prompts
    .filter((p) => p.kind === "user" && p.text.startsWith("answers to plan questions:"))
    .map((p) => p.text.replace(/^answers to plan questions:\s*/, ""))
    .join("\n---\n");
}

/**
 * The owner answered the planner's open questions: re-run the reviser on
 * the current plan with those answers and record the result as the new
 * draft (with any questions still left open).
 */
/**
 * No warm slot for the plan update right now: the owner's input is
 * already recorded and settled, so queue a fresh planning pass instead
 * of throwing the input away. The dispatcher launches queued planning
 * when a slot frees, the settled decisions ride into that pass, and
 * settled questions are never re-asked. Returns the queued task.
 */
async function queuePlanUpdate(
  store: FactoryStore,
  task: Task,
  now: () => string,
  what: string,
): Promise<Task> {
  const queued: Task = {
    ...task,
    planState: "none",
    planRequested: true,
    planQuestions: [],
    updatedAt: now(),
  };
  await store.writeTask(queued);
  await store
    .appendPrompt(task.id, {
      at: now(),
      kind: "system",
      text: `planning: your ${what} are recorded and settled — no need to send them again. The plan update is queued until a worktree slot frees, then planning re-runs automatically with your decisions applied.`,
    })
    .catch(() => {});
  return queued;
}

async function answerPlanQuestionsInner(
  taskId: string,
  answers: string,
  opts: PipelineOptions,
): Promise<Task> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  let task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  if (!task.planQuestions.length) throw new Error(`task ${taskId}: no open plan questions`);
  // Record FIRST, lease second: the owner's answers and the settled
  // questions are persisted before any worktree is acquired, so a full
  // pool (or any later failure) can never throw the answers away and
  // ask the same questions again.
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "user",
      text: `answers to plan questions:\n${answers}`,
    })
    .catch(() => {});
  // Every question ever answered on this task stays settled — not just
  // this batch — and the settled list (with the answers) rides into every
  // revision and red-team round from here on.
  const settled = [
    ...new Set([
      ...(task.settledQuestions ?? []),
      ...task.planQuestions,
    ]),
  ];
  task = {
    ...task,
    settledQuestions: settled,
  };
  await store.writeTask(task);
  try {
    task = await prepareWorktree(store, task, {
      maxParallelTasks: opts.maxParallelTasks,
    });
  } catch (err) {
    if (err instanceof WorktreePoolFullError) return queuePlanUpdate(store, task, now, "answers");
    throw err;
  }
  const applied = await revisePlan(task, opts, {
    plan: task.plan,
    questions: task.planQuestions,
    answers: `${answers}\n\n[factory note on deferred points: a question carrying a [deferred:<id>] marker is a deferred minor point. If the owner answered include (or yes), copy that point into the plan under a "## Deferred points included" section, keeping its exact [deferred:<id>] marker on the line; if they answered skip (or no), omit it entirely.]`,
    settledQuestions: settled,
    settledAnswers: answers,
  });
  for (const id of includedDeferredIds(applied.plan)) {
    await store.setDeferredStatus(task.projectId, id, "included", taskId).catch(() => {});
  }
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: "planning: answers applied, red-teaming the updated plan",
    })
    .catch(() => {});
  task = {
    ...task,
    settledQuestions: settled,
  };
  const revised = await redteamReview(task, opts, applied.plan, now);
  // Red-teams judge the CURRENT (post-answer) plan text — and a question
  // the owner already answered can never be re-asked, however phrased.
  const fresh = revised.questions.filter((q) => !isSettledQuestion(q, settled));
  if (fresh.length !== revised.questions.length) {
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `planning: ${revised.questions.length - fresh.length} already-answered question(s) re-raised by the reviser were settled, not re-asked`,
      })
      .catch(() => {});
  }
  const asks = fresh.length ? `; ${fresh.length} point(s) still need your decision` : "";
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "agent",
      text: `planner: plan updated with your answers and re-reviewed by both red-teams${asks}`,
    })
    .catch(() => {});
  const revisedFiltered = {
    ...revised,
    questions: fresh,
  };
  const next = draftPlan(
    task,
    revisedFiltered.plan,
    now(),
    revisedFiltered.questions,
    await planBaseFor(store, task),
  );
  await store.writeTask(next);
  return next;
}

/** Answering plan questions: runs the inner pass, then returns its warm slot. */
export async function answerPlanQuestions(
  taskId: string,
  answers: string,
  opts: PipelineOptions,
): Promise<Task> {
  try {
    return await answerPlanQuestionsInner(taskId, answers, opts);
  } finally {
    const task = await opts.store.readTask(taskId).catch(() => null);
    if (task) releaseWorktree(task);
  }
}

/**
 * The owner commented on individual plan lines: re-run the reviser on the
 * current plan with those comments and record the result as the new draft.
 * Unlike answering, this needs no open questions — comments are the input.
 */
async function commentOnPlanInner(
  taskId: string,
  comments: string,
  opts: PipelineOptions,
): Promise<Task> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  let task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  if (!task.plan.trim()) throw new Error(`task ${taskId}: no plan to comment on`);
  // Record FIRST, lease second (same rule as answers): a full pool
  // must never throw the owner's comments away.
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "user",
      text: `plan line comments:\n${comments}`,
    })
    .catch(() => {});
  try {
    task = await prepareWorktree(store, task, {
      maxParallelTasks: opts.maxParallelTasks,
    });
  } catch (err) {
    if (err instanceof WorktreePoolFullError) return queuePlanUpdate(store, task, now, "comments");
    throw err;
  }
  const applied = await revisePlan(task, opts, {
    plan: task.plan,
    comments,
    settledQuestions: task.settledQuestions ?? [],
    settledAnswers: task.settledQuestions?.length ? await settledAnswersOf(store, taskId) : "",
  });
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: "planning: comments applied, red-teaming the updated plan",
    })
    .catch(() => {});
  const revised = await redteamReview(task, opts, applied.plan, now);
  const asks = revised.questions.length
    ? `; ${revised.questions.length} point(s) still need your decision`
    : "";
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "agent",
      text: `planner: plan updated from your line comments and re-reviewed by both red-teams${asks}`,
    })
    .catch(() => {});
  const next = draftPlan(
    task,
    revised.plan,
    now(),
    revised.questions,
    await planBaseFor(store, task),
  );
  await store.writeTask(next);
  return next;
}

/** Commenting on plan lines: runs the inner pass, then returns its warm slot. */
export async function commentOnPlan(
  taskId: string,
  comments: string,
  opts: PipelineOptions,
): Promise<Task> {
  try {
    return await commentOnPlanInner(taskId, comments, opts);
  } finally {
    const task = await opts.store.readTask(taskId).catch(() => null);
    if (task) releaseWorktree(task);
  }
}

export interface ScoutResult {
  description: string;
  rules: string;
  smeSoul: string;
  coderSoul: string;
}

/**
 * Scout a freshly registered project: one read-only station inspects the
 * codebase and proposes description, general rules, an SME soul and a
 * developer (coder) soul. Results are stored as suggestions; the owner
 * accepts them field by field, nothing is applied automatically.
 */
export async function scoutProject(projectId: string, opts: PipelineOptions): Promise<ScoutResult> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const project = await store.readProject(projectId);
  if (!project) throw new Error(`project ${projectId}: not found or offline`);
  const dataDir = join(project.repoPath, "data");
  mkdirSync(dataDir, {
    recursive: true,
  });
  const card: JobCard = {
    id: "scout",
    jobId: `scout-${projectId}-${Date.now()}`,
    role: "planner",
    task: [
      "Scout this codebase and profile the project for the agent factory.",
      "The project root is the PARENT directory of your cwd. Inspect it: README and docs, package/build manifests, source layout, how it is tested and run, license, any existing contributor/agent rules (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING). Do not modify anything in the project.",
      "Write exactly one file, SCOUT.json, in your cwd, as JSON with these string keys:",
      '- "description": what this project is, who it is for, what it does, in 2-4 sentences.',
      '- "rules": general rules agents must respect on this codebase, one per line, from what you actually found (test commands, style, boundaries, things never to touch).',
      '- "smeSoul": a suggested subject-matter-expert soul for reviewing work here: who the expert is, what they care about, how they judge. Write it as instructions starting "You are".',
      '- "coderSoul": a suggested developer soul for implementing and code-reviewing here: stack idioms, how they test, what they refuse. Write it as instructions starting "You are".',
      "Base every claim on files you actually read; keep souls specific to this project, not generic. Reply first line: SCOUT_DONE",
    ].join("\n"),
    worktree: dataDir,
    constraints: [
      "read-only scouting: never modify the project",
      "write only SCOUT.json, in your cwd",
    ],
    gates: [],
  };
  await store.writeCard(card);
  const done = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  if (done.status !== "done") throw new Error(`scout failed: ${done.summary}`);
  const raw = (await Bun.file(join(dataDir, "SCOUT.json"))
    .json()
    .catch(() => null)) as Partial<ScoutResult> | null;
  if (!raw || typeof raw.description !== "string" || typeof raw.smeSoul !== "string") {
    throw new Error(
      "scout did not produce a usable SCOUT.json (description, rules, smeSoul, coderSoul)",
    );
  }
  const result: ScoutResult = {
    description: raw.description,
    rules: typeof raw.rules === "string" ? raw.rules : "",
    smeSoul: raw.smeSoul,
    coderSoul: typeof raw.coderSoul === "string" ? raw.coderSoul : "",
  };
  await store.writeScoutSuggestions(projectId, {
    ...result,
    at: now(),
  });
  return result;
}

/**
 * Retrospective for one task: a fresh station reads the whole run — the
 * stated task, the plan and its decisions, every agent call and system
 * note, what verification did, and the final state — and writes what
 * could have been done better: failing or wasteful commands, repeated
 * raw operations that should become a reusable helper, architectural
 * drawbacks spotted in hindsight. Findings are line-prefixed so the
 * owner can turn each into a task with one click.
 */
/**
 * Compose stored findings from the retro text. Each finding is a short
 * title plus its WHAT and WHY lines, composed into one self-contained
 * string ("Title — what. Why: why.") so the Inbox can explain a point
 * without opening the task. The title is hard-capped at 200 chars and
 * the composed finding at 500, even when the agent ignores the rules.
 */
export function composeFindings(text: string): string[] {
  const out: string[] = [];
  let title = "";
  let what = "";
  let why = "";
  const flush = () => {
    if (!title) return;
    const t = title.length > 200 ? `${title.slice(0, 197).trimEnd()}…` : title;
    const composed = [
      t,
      what,
      why ? `Why: ${why}` : "",
    ]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 500);
    out.push(composed);
    title = "";
    what = "";
    why = "";
  };
  for (const line of text.split("\n")) {
    const f = line.match(/^\s*(?:[-*]\s*)?FINDING:\s*(.+)$/)?.[1]?.trim();
    if (f) {
      flush();
      title = f;
      continue;
    }
    if (!title) continue;
    const w = line.match(/^\s*WHAT:\s*(.+)$/i)?.[1]?.trim();
    if (w) {
      what = w;
      continue;
    }
    const y = line.match(/^\s*WHY:\s*(.+)$/i)?.[1]?.trim();
    if (y) why = y;
  }
  flush();
  return out.slice(0, 6);
}

export async function runRetro(
  taskId: string,
  opts: PipelineOptions,
): Promise<{
  text: string;
  findings: string[];
}> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  const project = await store.readProject(task.projectId).catch(() => null);
  const prompts = await store.listPrompts(taskId).catch(() => []);
  const history = prompts
    .map((p) => `[${p.kind} ${p.at}] ${p.text.slice(0, 400)}`)
    .join("\n")
    .slice(-14000);
  const changed = worktreeActivity(task).map((a) => a.file);
  const existingTitles = (await store.listTasks(task.projectId).catch(() => [] as Task[]))
    .filter((t) => t.id !== task.id)
    .slice(-60)
    .map((t) => `- [${t.state}] ${t.title}`)
    .join("\n")
    .slice(0, 4000);
  const cwd = project ? join(project.repoPath, "data", "plans") : task.worktree;
  if (cwd)
    mkdirSync(cwd, {
      recursive: true,
    });
  const card: JobCard = {
    id: "retro",
    jobId: task.jobId,
    role: "planner",
    task: [
      `Write the retrospective for this finished task and reply first line: RETRO_DONE.`,
      `Task: ${task.prompt}`,
      `Final state: ${task.state} after ${task.attempts} attempt(s). Verify command: ${task.verifyCommand || "(none)"}.`,
      `Plan:\n${task.plan.slice(0, 3000)}`,
      `Files the worker touched: ${changed.join(", ") || "(none recorded)"}. Diff size: ${taskDiff(task).length} chars.`,
      `Full run history (every agent call, owner message, system note, in order):\n${history}`,
      `Review the run like a post-mortem, with evidence from the history above — never invent events. Cover:`,
      `- commands that failed or had to be retried (tests, verify, shell), and why;`,
      `- repeated raw operations done by hand that should become a reusable script, helper or factory feature;`,
      `- places where a reusable version of something was built inline instead;`,
      `- architectural drawbacks or wrong turns the plan or the code took, visible only now;`,
      `- decisions (owner, planner, red-team) that turned out right or wrong, and what they cost.`,
      `Existing tasks in this project (any finding already covered by one of these, in any wording and in any state including done, must NOT be filed again — mention it in the body instead):\n${existingTitles || "(none)"}`,
      `Then end with a findings list. Each finding is exactly three lines: "FINDING: " + a SHORT task title (at most 160 characters, deliverable and point, no evidence), then "WHAT: " + what concretely to do in one sentence, then "WHY: " + why it matters, with the run evidence, in one sentence. The owner reads findings in an inbox without opening this task, so every finding must make sense on its own from those three lines. At most 3 findings; if the run was clean, say so and give at most 1. File only a concrete code, test or docs deliverable: process observations, reporting/logging-only wishes, and self-referential "prove itself on its own run" points belong in the body above, never in the findings list.`,
    ].join("\n"),
    worktree: cwd || ".",
    constraints: [
      "read-only retrospective: do not edit code",
      "first line must be RETRO_DONE",
      "every claim needs evidence from the run history",
    ],
    gates: [],
  };
  await store.writeCard(card);
  const done = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  if (done.status !== "done") throw new Error(`retro failed: ${done.summary}`);
  const text = (done.detail || done.summary)
    .replace(/^RETRO_DONE\s*/i, "")
    .trim()
    .slice(0, 9000);
  const findings = composeFindings(text);
  await store.writeRetro(taskId, {
    text,
    findings,
    at: now(),
  });
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: `retro written: ${findings.length} finding(s) — see Retrospective on the task page`,
    })
    .catch(() => {});
  return {
    text,
    findings,
  };
}

/**
 * Owner follow-up on a retro: comments and questions on individual
 * findings (or the whole retro) go back to the retro agent, which
 * answers the questions and returns a revised retro. Same output
 * contract as runRetro, so findings stay one-click-taskable.
 */
/**
 * Retro points leave the finished feature as separate candidate tasks:
 * the feature itself closes (retroReviewedAt stamped), and each finding
 * becomes a planned task that is NOT auto-planned — it waits in the
 * owner's Inbox as its own notification, to be accepted (planning
 * starts) or removed, point by point. Duplicate points (any existing
 * task, done included, already states the same thing) are skipped, at
 * most MAX_RETRO_POINTS_PER_TASK points are filed, and filing is
 * claimed up front so concurrent passes cannot file the same retro
 * twice. Returns the child ids.
 */
export const MAX_RETRO_POINTS_PER_TASK = 3;
const retroFilingInFlight = new Set<string>();

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export async function fileRetroPoints(
  store: FactoryStore,
  task: Task,
  opts?: {
    now?: () => string;
  },
): Promise<string[]> {
  const now = opts?.now ?? (() => new Date().toISOString());
  if (task.retroReviewedAt || retroFilingInFlight.has(task.id)) return [];
  retroFilingInFlight.add(task.id);
  try {
    const fresh = await store.readTask(task.id).catch(() => null);
    if (!fresh || fresh.retroReviewedAt) return [];
    const retro = await store.readRetro(task.id).catch(() => null);
    if (!retro || retro.error) return [];
    // Claim first: stamp the closure before filing any point, so a
    // concurrent or repeated pass can never file the same retro twice.
    await store.writeTask({
      ...fresh,
      retroReviewedAt: now(),
      updatedAt: now(),
    });
    const existing: Task[] = await store.listTasks(task.projectId).catch(() => []);
    const created: string[] = [];
    let duplicates = 0;
    for (const [i, finding] of retro.findings.entries()) {
      if (created.length >= MAX_RETRO_POINTS_PER_TASK) break;
      if (
        findDuplicateTask(existing, task.projectId, finding) ||
        findRetroDuplicate(existing, task.projectId, finding, task.id)
      ) {
        duplicates++;
        continue;
      }
      const title = deriveTitle(finding.split(" — ")[0] ?? finding);
      const childId = `task-${Date.now()}${i}`;
      const child = newTask(
        {
          id: childId,
          projectId: task.projectId,
          title,
          prompt: `${finding}\n\n(From the retrospective of "${task.title}" — task ${task.id}. Review this point on its own: accept it to start planning, or remove it if it should not become work.)`,
          jobId: childId,
        },
        now(),
      );
      await store.writeTask({
        ...child,
        tags: [
          "retro-point",
        ],
        planRequested: false,
      });
      const tagged = await store.readTask(childId).catch(() => null);
      if (tagged) existing.push(tagged);
      created.push(childId);
    }
    const notFiled = retro.findings.length - created.length - duplicates;
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text: created.length
          ? `retro reviewed automatically: this feature is closed, and its ${created.length} point(s) were filed as separate candidate tasks (${created.join(", ")}) for the owner to accept or remove one by one${duplicates ? `; ${duplicates} duplicate point(s) skipped (already covered by an existing task)` : ""}${notFiled > 0 ? `; ${notFiled} point(s) not filed (per-task cap of ${MAX_RETRO_POINTS_PER_TASK}) — they stay in the retrospective text above` : ""}`
          : "retro reviewed automatically: this feature is closed; no retro points needed filing (none, or all already covered by existing tasks)",
      })
      .catch(() => {});
    return created;
  } finally {
    retroFilingInFlight.delete(task.id);
  }
}

export async function runRetroFollowup(
  taskId: string,
  comments: {
    finding: string;
    comment: string;
  }[],
  opts: PipelineOptions,
): Promise<{
  text: string;
  findings: string[];
}> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  const existing = await store.readRetro(taskId);
  if (!existing) throw new Error(`task ${taskId}: no retrospective yet — run one first`);
  const project = await store.readProject(task.projectId).catch(() => null);
  for (const c of comments) {
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "user",
        text: `retro comment${c.finding ? ` on "${c.finding}"` : " on the whole retro"}: ${c.comment}`,
      })
      .catch(() => {});
  }
  const cwd = project ? join(project.repoPath, "data", "plans") : task.worktree;
  if (cwd)
    mkdirSync(cwd, {
      recursive: true,
    });
  const card: JobCard = {
    id: "retro-followup",
    jobId: task.jobId,
    role: "planner",
    task: [
      `The owner commented on the retrospective of this task. Reply first line: RETRO_DONE, then the FULL revised retrospective.`,
      `Task: ${task.prompt} (final state: ${task.state}).`,
      `Current retrospective:\n${existing.text}`,
      `Owner comments and questions:\n${comments.map((c) => `- On ${c.finding ? `"${c.finding}"` : "the whole retro"}: ${c.comment}`).join("\n")}`,
      `Answer every question directly in the text (under a "## Answers" heading), fold the comments in, and keep the findings list at the end. Each finding is three lines: "FINDING: " + a short title (at most 160 characters), "WHAT: " + what to do in one sentence, "WHY: " + why it matters in one sentence — the owner reads them in an inbox without opening the task. Drop or rewrite findings the owner rejected.`,
    ].join("\n"),
    worktree: cwd || ".",
    constraints: [
      "read-only: do not edit code",
      "first line must be RETRO_DONE",
      "return the full revised retro, not a diff",
    ],
    gates: [],
  };
  await store.writeCard(card);
  const done = await runStation(card, {
    store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  if (done.status !== "done") throw new Error(`retro follow-up failed: ${done.summary}`);
  const text = (done.detail || done.summary)
    .replace(/^RETRO_DONE\s*/i, "")
    .trim()
    .slice(0, 9000);
  const findings = composeFindings(text);
  await store.writeRetro(taskId, {
    text,
    findings,
    at: now(),
  });
  await store
    .appendPrompt(taskId, {
      at: now(),
      kind: "system",
      text: `retro revised after owner comments: ${findings.length} finding(s)`,
    })
    .catch(() => {});
  return {
    text,
    findings,
  };
}

/** A verify output showing the command could not even start as intended:
 *  unknown program, or a real-but-wrong program printing its usage help
 *  (e.g. a sentence whose first word happens to be `write` or `open`). */
export const verifyNotRunnable = (out: string): boolean =>
  /command not found|Try '[^']*--help'|\busage:/i.test(out);

// Natural-language sentence markers: a stored "verify command" whose first
// word is a stopword is prose, and so is a long wordy phrase with no
// command markers (flags, paths, dots, `=`). Real checks — `bun test`,
// `npm run build`, `pytest tests/x.py`, `docker compose up -d` — never
// look like this.
const PROSE_STOPWORDS =
  /^(a|an|the|is|are|was|were|should|please|need|needs|allow|allows|for|with|this|that|it|its|and|to|of|in|on|by|add|remove|fix|check|run|verify|ensure|make|sure|there|be)$/i;
/**
 * A green exit code from a sentence is not verification: `file selector
 * allows navigation` runs the real `file` binary and exits 0, and the
 * factory must not call the task done on that. Prose-shaped commands are
 * routed to the builder to name a real check, never trusted as-is.
 */
export function looksLikeProse(cmd: string): boolean {
  const words = cmd.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false; // `bun test`, `npm run build` are commands
  if (/[;&|]/.test(cmd)) return false; // compound shell line, not prose
  if (PROSE_STOPWORDS.test(words[0] ?? "")) return true; // `add a test for this`
  // Four or more plain words with no flags, paths, dots or `=` reads like
  // a sentence: `file selector allows navigation`.
  if (words.length >= 4 && !words.some((w) => w.startsWith("-")) && !/[=/.]/.test(cmd)) return true;
  return false;
}

/**
 * The checks that must pass before a task may be called done: the
 * task's own verify command when it has one, otherwise the check
 * scripts the project's CI analysis derives from its package scripts
 * (test / typecheck / lint — the same commands CI gates on). Heavy CI
 * workflows (self-hosted, containers) are not run locally per task;
 * they still run on push/PR. Empty only when the project has no
 * runnable check at all.
 */
export function effectiveVerifyCommand(task: Task, repoPath: string): string {
  const own = task.verifyCommand.trim();
  if (own) return own;
  // The project's stated gate (per-stack contract, defaultVerifyCommand)
  // outranks the CI-derived suggestion: it is exactly what the builder loop
  // already ran, so the final gate can never fail a task with a command the
  // loop never used. The worktree must still exist for that check; once it
  // is released, the CI-derived suggestion is what is left.
  if (task.worktree) {
    const stated = defaultVerifyCommand(task.worktree);
    if (stated) return stated;
  }
  if (!repoPath) return "";
  try {
    return analyzeCi(repoPath).suggestedVerify;
  } catch {
    return "";
  }
}

// Lines that carry the real signal of a failed check — test failures, type
// errors, lint diagnostics, and file:line locations. Everything else in a
// red run is progress noise the builder would have to page through to find
// what actually broke, so it is dropped. The command itself is never
// skipped (lint and unit tests are constitutional): only its output is
// reduced so a passing suite costs no tokens and a failing one costs only
// the failure lines.
const VERIFY_FAILURE_SIGNAL =
  /(\berror\b|\bfail(ed|ure|s)?\b|[✗✘×✖❌]|assert|\bexpected\b|\breceived\b|\bnot ok\b|timed? ?out|\bexception\b|unhandled|SyntaxError|TypeError|ReferenceError|RangeError|exit(ed)? with code)/i;
const VERIFY_LOCATION = /[./\\][\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|vue|svelte):\d+/;
const VERIFY_NOT_RUNNABLE = /command not found|Try '[^']*--help'|\busage:/i;

/**
 * Reduce a failed verify run to its failure lines (plus the runner's own
 * verdict tail) instead of the full output. Failure lines come first so a
 * bounded front-slice at the call site keeps the useful part; the tail
 * (e.g. "154 pass 1 fail 1 error") is appended as the summary of record.
 */
export function digestVerifyFailure(out: string): string {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hits: string[] = [];
  for (const line of lines) {
    if (
      VERIFY_FAILURE_SIGNAL.test(line) ||
      VERIFY_LOCATION.test(line) ||
      VERIFY_NOT_RUNNABLE.test(line)
    )
      hits.push(line);
  }
  const merged = [
    ...new Set([
      ...hits,
      ...lines.slice(-4),
    ]),
  ];
  return merged.join("\n").slice(0, 1200);
}

/**
 * The project stack a worktree states, detected from its manifest files —
 * nothing else. "npm" covers a bare package.json without a lockfile.
 */
export type ProjectStack = "bun" | "npm" | "pnpm" | "yarn" | "cargo" | "go" | "python";

export function detectProjectStack(worktree: string): ProjectStack | null {
  if (existsSync(join(worktree, "bun.lock")) || existsSync(join(worktree, "bun.lockb")))
    return "bun";
  if (existsSync(join(worktree, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(worktree, "yarn.lock"))) return "yarn";
  if (existsSync(join(worktree, "package-lock.json"))) return "npm";
  if (existsSync(join(worktree, "package.json"))) return "npm";
  if (existsSync(join(worktree, "Cargo.toml"))) return "cargo";
  if (existsSync(join(worktree, "go.mod"))) return "go";
  if (
    existsSync(join(worktree, "pyproject.toml")) ||
    existsSync(join(worktree, "requirements.txt"))
  )
    return "python";
  return null;
}

/**
 * The project's own gate when the task names none, chosen per stack:
 *  - JS stacks: the repo must STATE the gate — a `verify` script in
 *    package.json — and it runs under the detected package manager. This
 *    factory's own convention; no script means the builder is asked, not a
 *    guessed command.
 *  - cargo/go/python: the canonical check command IS the project's tests
 *    (`cargo test`, `go test ./...`, `pytest` or `unittest discover`), so
 *    "no stored command" no longer means "nothing to prove". The builder
 *    can still propose a stricter VERIFY and the owner can override.
 */
export function defaultVerifyCommand(worktree: string): string {
  const stack = detectProjectStack(worktree);
  const jsRunner: Record<string, string> = {
    bun: "bun run verify",
    npm: "npm run verify",
    pnpm: "pnpm run verify",
    yarn: "yarn verify",
  };
  if (stack && jsRunner[stack]) {
    try {
      const pkg = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      return pkg.scripts?.verify ? jsRunner[stack] : "";
    } catch {
      /* no package.json / not JSON: the project states no gate */
    }
    return "";
  }
  if (stack === "cargo") return "cargo test";
  if (stack === "go") return "go test ./...";
  if (stack === "python") return pythonVerifyCommand(worktree);
  return "";
}

function pythonVerifyCommand(worktree: string): string {
  const markers = [
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
  ];
  const usesPytest = markers.some((f) => {
    const p = join(worktree, f);
    return existsSync(p) && readFileSync(p, "utf8").includes("pytest");
  });
  return usesPytest ? "pytest" : "python -m unittest discover";
}

/**
 * Canonical gates legitimately run for minutes — a cold `cargo test`, a full
 * suite under `bun run verify` — and this factory works unattended: a
 * slow check stalls one loop iteration, while a too-short timeout false-fails
 * the task and burns a builder round on a check that would have passed. The
 * station timeout (default 60 min) still bounds the whole line.
 */
const VERIFY_TIMEOUT_MS = 600_000;

function runVerify(
  task: Task,
  timeoutMs = VERIFY_TIMEOUT_MS,
  cacheDir?: string,
): {
  ok: boolean;
  out: string;
  cacheHit: boolean;
} {
  if (!task.verifyCommand)
    return {
      ok: true,
      out: "",
      cacheHit: false,
    };
  // Verify result cache: a green (or red) run on an unchanged worktree is
  // identical, so re-running it (on every retry / review bounce / pickup)
  // only re-bills the same output. Keyed by worktree HEAD + verify command;
  // TTL 10 min so a long-running edit session eventually re-checks.
  const VERIFY_CACHE_TTL_MS = 10 * 60 * 1000;
  if (cacheDir && task.worktree) {
    let head = "";
    try {
      head = execSync("git rev-parse HEAD", {
        cwd: task.worktree,
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
    } catch {
      head = "";
    }
    const key = createHash("sha256").update(`${head}|${task.verifyCommand}`).digest("hex");
    const cachePath = join(cacheDir, `${key}.json`);
    try {
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
          ok: boolean;
          out: string;
          createdAt: number;
        };
        if (Date.now() - cached.createdAt < VERIFY_CACHE_TTL_MS) {
          return {
            ok: cached.ok,
            out: cached.out,
            cacheHit: true,
          };
        }
      }
    } catch {
      // corrupt cache: fall through and re-run
    }
    // run below, then write cache
    const result = runVerifyInner(task, timeoutMs);
    try {
      mkdirSync(cacheDir, {
        recursive: true,
      });
      writeFileSync(
        cachePath,
        JSON.stringify({
          ok: result.ok,
          out: result.out,
          createdAt: Date.now(),
        }),
      );
    } catch {
      // cache write is best-effort
    }
    return {
      ...result,
      cacheHit: false,
    };
  }
  const inner = runVerifyInner(task, timeoutMs);
  return {
    ...inner,
    cacheHit: false,
  };
}

function runVerifyInner(
  task: Task,
  timeoutMs = VERIFY_TIMEOUT_MS,
): {
  ok: boolean;
  out: string;
  cacheHit: boolean;
} {
  if (!task.verifyCommand)
    return {
      ok: true,
      out: "",
      cacheHit: false,
    };
  try {
    // Green run: the checks passed. Their output is per-test noise, so it
    // is discarded rather than re-billed into a prompt. The command itself
    // is never skipped — lint and unit tests always run.
    execSync(task.verifyCommand, {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: timeoutMs,
      shell: "/bin/bash",
    });
    return {
      ok: true,
      out: "",
      cacheHit: false,
    };
  } catch (err) {
    const e = err as {
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      ok: false,
      out: digestVerifyFailure(`${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`),
      cacheHit: false,
    };
  }
}

// A builder-named verify command is only auto-run when it looks like a
// single simple command: word characters, dots, slashes and dashes, with
// plain `=`/`-` flags — no shell chaining, substitution, redirection or
// quoting. The builder already owns the code, so the verify command it
// names is a trust boundary: it must not become an arbitrary shell
// one-liner the factory executes for it.
const SAFE_VERIFY_CMD = /^[\w./-]+(?:[\s]+[\w./=-]+)*$/;
export function isSafeVerifyCommand(cmd: string): boolean {
  const c = cmd.trim();
  return c.length > 0 && c.length <= 200 && SAFE_VERIFY_CMD.test(c);
}

/**
 * Optional escalation: fire a small JSON payload to DASHBOARD_WEBHOOK_URL
 * when a task parks for owner input, so the unattended run does not stall
 * silently. Best-effort by design — never throws, never blocks the
 * pipeline; the dashboard queue is the always-on path, this is the "wake
 * the human" path.
 */
export async function notifyNeedsInput(taskId: string, reason: string): Promise<void> {
  const url = process.env.DASHBOARD_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event: "needs-input",
          taskId,
          reason: reason.slice(0, 500),
          at: new Date().toISOString(),
        }),
      });
    } catch {
      // the task is already parked in the store; escalation is best-effort
    }
  }
  await pushToOwner(taskId, reason);
}

/** Minimal Web Push sender (RFC 8291 aes128gcm + RFC 8292 VAPID), no deps. */
export function vapidJwt(
  audience: string,
  subject: string,
  keyPair: {
    publicKey: string;
    privateKey: string;
  },
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const header = b64(
    JSON.stringify({
      typ: "JWT",
      alg: "ES256",
    }),
  );
  const payload = b64(
    JSON.stringify({
      aud: audience,
      exp: nowSec + 12 * 3600,
      sub: subject,
    }),
  );
  // The stored VAPID private key is a JWK (see server's key generation):
  // Bun signs happily from a KeyObject, not from raw DER bytes.
  const key = createPrivateKey({
    key: JSON.parse(Buffer.from(keyPair.privateKey, "base64url").toString("utf8")),
    format: "jwk",
  });
  const sig = cryptoSign("SHA256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64(sig)}`;
}

export function encryptPushPayload(
  plaintext: string,
  uaPublicB64: string,
  authB64: string,
): Buffer {
  const uaPublic = Buffer.from(uaPublicB64, "base64url");
  const auth = Buffer.from(authB64, "base64url");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const salt = randomBytes(16);
  const secret = ecdh.computeSecret(uaPublic);
  // RFC 8291 §3.3, two-stage HKDF: first with the auth secret, then salt.
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
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    Buffer.from(plaintext, "utf8"),
    Buffer.from([
      2,
    ]),
  ]);
  const ciphertext = Buffer.concat([
    cipher.update(body),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([
    header,
    ciphertext,
  ]);
}

/**
 * Owner's browser push path: subscriptions live in
 * <FACTORY_DATA>/push-subscriptions.json, VAPID keys in
 * <FACTORY_DATA>/vapid.json (generated on first subscribe). Best-effort:
 * a dead endpoint is dropped, never blocks the pipeline.
 */
export async function pushToOwner(taskId: string, reason: string): Promise<void> {
  const dataDir = process.env.FACTORY_DATA ?? "factory-data";
  const subsPath = join(dataDir, "push-subscriptions.json");
  const vapidPath = join(dataDir, "vapid.json");
  if (!existsSync(subsPath) || !existsSync(vapidPath)) return;
  try {
    const subs = JSON.parse(readFileSync(subsPath, "utf8")) as {
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
    }[];
    const vapid = JSON.parse(readFileSync(vapidPath, "utf8")) as {
      publicKey: string;
      privateKey: string;
      subject: string;
    };
    if (!subs.length) return;
    const payload = JSON.stringify({
      title: "Agent Factory — input needed",
      body: reason.slice(0, 180),
      taskId,
    });
    const alive: typeof subs = [];
    for (const sub of subs) {
      try {
        const audience = new URL(sub.endpoint).origin;
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-encoding": "aes128gcm",
            ttl: "3600",
            authorization: `vapid t=${vapidJwt(audience, vapid.subject, vapid)}, k=${vapid.publicKey}`,
          },
          body: new Uint8Array(encryptPushPayload(payload, sub.keys.p256dh, sub.keys.auth)),
        });
        if (res.status !== 404 && res.status !== 410) alive.push(sub);
      } catch {
        alive.push(sub); // transient network error: keep the subscription
      }
    }
    if (alive.length !== subs.length) writeFileSync(subsPath, JSON.stringify(alive, null, 2));
  } catch {
    // best-effort escalation only
  }
}

/** Ralph loop: repeat the station until done and verified, capped. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function builderLoop(
  task: Task,
  instruction: string,
  opts: PipelineOptions,
): Promise<{
  ok: boolean;
  summary: string;
}> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const maxIterations = opts.maxIterations ?? 3;
  const tier = tierFor(task.taskType, Math.max(0, task.attempts - 1));
  // Settled decisions: everything the owner has already answered on this
  // task rides in the card, marked settled, so no station asks it again.
  const history = await store.listPrompts(task.id).catch(() => []);
  const settled = history.filter((p) => p.kind === "user" && p.text !== task.prompt).slice(-5);
  const settledText = settled.length
    ? `\n\nOwner's settled decisions — already answered on this task; do NOT ask any of this again, build on them:\n${settled.map((p) => `- ${p.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`
    : "";
  // Inter-station context pack: assemble the builder's stable context (plan
  // brief + settled decisions + patterns + souls + file list) once and cache
  // it by content hash, so retries and re-runs do not re-bill the same text.
  // Falls back to the inline assembly on any error.
  let stableContext = `Plan (approved, execution brief):\n${executionBrief(task.plan)}${settledText}`;
  let contextPackHit = false;
  try {
    const project = await store.readProject(task.projectId).catch(() => null);
    let patterns = "";
    try {
      patterns = readFileSync(join(task.worktree, "PATTERNS.md"), "utf8");
    } catch {
      patterns = "";
    }
    let decisions = "";
    try {
      decisions = readFileSync(join(task.worktree, "decisions.md"), "utf8");
    } catch {
      decisions = "";
    }
    const fileList = extractContext(task.worktree);
    const souls = project?.coderSoul ?? "";
    const pack = await getContextPack(store, {
      role: "builder",
      taskId: task.id,
      task,
      project,
      plan: task.plan,
      decisions,
      patterns,
      souls,
      fileList,
      settledDecisions: settledText,
    });
    stableContext = pack.content;
    contextPackHit = pack.hit;
  } catch {
    // keep inline fallback
  }
  const sanitized = sanitizeGateVeto(
    `${task.prompt}\n\n${stableContext}${instruction ? `\n\nLatest instruction:\n${instruction}` : ""}`,
  );
  if (sanitized.removed.length) {
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text: `boundary gate: removed ${sanitized.removed.length} plan line(s) from the builder card (${[
          ...new Set(sanitized.removed),
        ].join(
          "; ",
        )}) — the factory ruling in the card replaces them; the agent is not asked about this`,
      })
      .catch(() => {});
  }
  let card: JobCard = {
    id: "builder",
    jobId: task.jobId,
    role: "builder",
    task: sanitized.text,
    worktree: task.worktree,
    constraints: [
      "stay inside this worktree",
      "visual review: if the plan declares Visual moments or this work touches pages/UI, write visual.moments.json at the worktree root mirroring the planned moments (JSON array of {name, route, viewport, actions}) as the e2e screenshot spec; screenshots are captured by the factory outside git — never create or commit screenshot PNGs",
      `model tier: ${tier.name}, effort: ${tier.effort} (attempt ${task.attempts})`,
      "read only files you need to change; prefer targeted reads (specific paths) over whole-repo scans",
      "do not re-read files already provided in the context pack; reuse the plan brief and file list already given",
      "avoid commands that dump large outputs; keep tool output minimal",
    ],
    gates: [
      "redteam",
      "clarification",
    ],
  };
  await store.writeCard(card);
  let summary = "";
  // Intermediate-state evaluation for long stations: a builder run that
  // hits the timeout is not automatically a failure, and it is never a
  // question for the owner. Compare the worktree before and after:
  // files changed means real progress — the worker is told to save its
  // intermediate state and finish; no change at all means it may be
  // looped or stale, so the factory automatically reiterates with a
  // fresh, smaller step. Only when every iteration has timed out does
  // the task park, with that evidence, for the owner.
  const worktreeSignature = () =>
    worktreeActivity(task)
      .map((a) => `${a.file}:${a.modifiedAt}`)
      .sort()
      .join("|");
  let timeoutContinued = false;
  let gateRuled = false;
  // A verify command that cannot even start (a sentence stored as the
  // command) is rerouted to the builder once: it can read how this
  // project is actually verified and name a working command. Only if
  // the builder cannot settle it does the owner get asked.
  let rerouted = false;
  // The project's own gate (per stack) fills in when the task named no
  // command; remember it so the audit log attributes a green run honestly —
  // to the project, not to a builder that never ran. One chooser everywhere:
  // effectiveVerifyCommand is the same function the final gate uses.
  const projectGate = task.verifyCommand ? "" : effectiveVerifyCommand(task, "");
  let verifyCmd = task.verifyCommand || projectGate;
  // The attempt tier is now real: early attempts build on the fast
  // coding model; only escalated retries earn the strong model.
  const builderRoute =
    tier.name === "smart"
      ? {
          model: "muse-wonder-1.0",
          effort: "high",
        }
      : tier.name === "standard"
        ? {
            model: "muse-spark-1.3",
            effort: "medium",
          }
        : {
            model: "muse-spark-1.3",
            effort: "low",
          };
  for (let i = 1; i <= maxIterations; i++) {
    const beforeRun = worktreeSignature();
    // Resumed builder sessions already hold the task and brief: send
    // only what is new (latest instruction plus any appended ruling or
    // continuation) instead of re-billing the whole card. A fresh
    // session receives the full card (handled in runStation).
    const appended =
      card.task.length > sanitized.text.length ? card.task.slice(sanitized.text.length) : "";
    const deltaTask = `Continue building this task in this session. The task, approved plan brief, and prior work are already in this session; the worktree holds the current state.${instruction ? `\n\nLatest instruction:\n${instruction}` : ""}${appended}`;
    const built = await runStation(card, {
      store,
      command: opts.command,
      providerCommands: opts.providerCommands,
      timeoutMs: opts.timeoutMs,
      deltaTask,
      ...builderRoute,
    });
    summary = built.summary;
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "agent",
        text: `builder (attempt ${task.attempts}, iteration ${i}, tier ${tier.name}/${tier.effort}): ${summary}`,
      })
      .catch(() => {});
    if (built.status === "blocked" && !gateRuled && i < maxIterations) {
      // The boundary gate vetoed this card before the agent ran (its own
      // text tripped a pattern — e.g. via the latest instruction). Strip,
      // rule, and resend once; a second veto parks for the owner.
      gateRuled = true;
      const cleaned = sanitizeGateVeto(card.task);
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `boundary gate vetoed the builder card before the agent ran (${summary}) — removed the offending line(s), applied the factory ruling, resending`,
        })
        .catch(() => {});
      card = {
        ...card,
        task: cleaned.text,
      };
      await store.writeCard(card);
      continue;
    }
    if (built.status !== "done" && /timed out/i.test(summary) && i < maxIterations) {
      const changed = worktreeActivity(task).filter(
        (a) => !beforeRun.split("|").includes(`${a.file}:${a.modifiedAt}`),
      );
      if (changed.length) {
        timeoutContinued = true;
        await store
          .appendPrompt(task.id, {
            at: now(),
            kind: "system",
            text: `intermediate state check: the timed-out builder run changed ${changed.length} file(s) (${changed
              .slice(0, 5)
              .map((a) => a.file)
              .join(
                ", ",
              )}) — real progress, not a loop; resuming the worker to save its state and finish`,
          })
          .catch(() => {});
        card = {
          ...card,
          task: `${card.task}\n\nYour previous run hit the time limit AFTER making progress (files changed are still in the worktree). First save your intermediate state: leave the work in a coherent, compilable shape and note in your reply what is done and what remains. Then finish the remaining work. If you find yourself repeating the same step, stop and reply BLOCKED with the step you are stuck on.`,
        };
        await store.writeCard(card);
        continue;
      }
      // No progress is a system event, not an owner question: reiterate
      // automatically with a fresh, smaller step instead of parking.
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `intermediate state check: the builder timed out with no file changes at all — automatically reiterating without owner input (iteration ${i + 1} of ${maxIterations}) with a fresh, smaller step`,
        })
        .catch(() => {});
      card = {
        ...card,
        task: `${card.task}\n\nYour previous run hit the time limit with NO file changes at all — it was likely looped or stale, and the factory is reiterating automatically; no owner input is involved. Do NOT repeat the same approach. Re-read the task and plan, inspect the current worktree, then pick the smallest concrete next step, make that one file change, and save your intermediate state in a coherent, compilable shape before continuing. If you find yourself repeating a step, stop and reply BLOCKED with the exact step you are stuck on.`,
      };
      await store.writeCard(card);
      continue;
    }
    if (built.status !== "done" && /timed out/i.test(summary)) {
      const changed = worktreeActivity(task).filter(
        (a) => !beforeRun.split("|").includes(`${a.file}:${a.modifiedAt}`),
      );
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `intermediate state check: the builder timed out on every iteration (${timeoutContinued ? "progress was made but never finished" : "no file changes at all"}) — parking after automatic reiteration. Worktree state is preserved for inspection.`,
        })
        .catch(() => {});
      return {
        ok: false,
        summary: `builder timed out with no progress (intermediate state evaluated: ${changed.length} file change(s) in the last run) — likely looped or stale; reply to resume`,
      };
    }
    if (built.status !== "done" && summary.startsWith("quota:"))
      return {
        ok: false,
        summary,
      };
    if (built.status === "failed" && i < maxIterations) {
      // The station itself died (agent exit, crash, no reply): a system
      // event, not an owner question. Clear the possibly-poisoned
      // session and automatically retry; only a failure on the final
      // iteration parks for the owner.
      await store.setSession(task.jobId, card.id, null).catch(() => {});
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `builder station did not complete (${summary || "no reply from the agent"}) — automatically retrying with a fresh session (iteration ${i + 1} of ${maxIterations}); no owner input`,
        })
        .catch(() => {});
      continue;
    }
    if (built.status !== "done")
      return {
        ok: false,
        summary,
      };
    if (isBlockedReply(summary)) {
      // A block about skipping a quality gate is not the owner's call:
      // gates are constitutional (thresholds are tunable, existence is
      // not — not by the builder, not on a reviewer's suggestion). Rule
      // on it in the factory and send the builder back once; only a
      // second block after the ruling reaches the owner.
      if (/quality gate|skip.*\bgate\b/i.test(summary) && !gateRuled) {
        gateRuled = true;
        await store
          .appendPrompt(task.id, {
            at: now(),
            kind: "system",
            text: "factory ruling: quality gates are never skipped — the builder was sent back to implement the gate-compliant path; no owner input needed",
          })
          .catch(() => {});
        card = {
          ...card,
          task: `${card.task}\n\nFactory ruling on your block: quality checks are constitutional and are NEVER bypassed — not by you, and not on a reviewer's suggestion. Implement the compliant path. If you believe a check's threshold is wrong for this work, say so in your reply as a recorded tradeoff instead of bypassing it, and continue with the compliant path.`,
        };
        await store.writeCard(card);
        continue;
      }
      // A real block must state its case where the owner will read it:
      // the full reply, not only the one-line summary.
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "agent",
          text: `builder blocked — full case:\n${(built.detail || summary).slice(0, 2000)}`,
        })
        .catch(() => {});
      return {
        ok: false,
        summary,
      };
    }
    if (rerouted) {
      const named = (built.detail || built.summary).match(/(?:^|\n)VERIFY:\s*(.+)/)?.[1]?.trim();
      if (named) {
        const candidate = /^none$/i.test(named) ? "" : named;
        // The builder's named command is a trust boundary: only a simple
        // single command is auto-run; anything shell-shaped is parked for
        // the owner to set explicitly in Task details.
        if (candidate && !isSafeVerifyCommand(candidate)) {
          await store
            .appendPrompt(task.id, {
              at: now(),
              kind: "system",
              text: `builder proposed a verify command that is not a safe single command (${candidate}) — it will not be auto-run; set the verify command in Task details, then reply to resume`,
            })
            .catch(() => {});
          return {
            ok: false,
            summary: `verification failed: builder proposed an unsafe verify command (${candidate}) — the owner must set it explicitly`,
          };
        }
        verifyCmd = candidate;
      }
    }
    const verify = verifyCmd
      ? runVerify(
          {
            ...task,
            verifyCommand: verifyCmd,
          },
          opts.timeoutMs,
          join(store.dir, "cache", "verify"),
        )
      : {
          ok: true,
          out: "",
          cacheHit: false,
        };
    const verifyCacheHit = verify.cacheHit;
    await store
      .saveDelivery(task.jobId, {
        ...built,
        contextPackHit,
        verifyCacheHit,
      })
      .catch(() => {});
    // A green exit code from a sentence is not verification (`file selector
    // allows navigation` runs the real `file` binary and exits 0). Route it
    // to the builder exactly like a not-runnable command: once; if the
    // builder cannot name a real check either, the owner is asked.
    if (verify.ok && verifyCmd && looksLikeProse(verifyCmd)) {
      if (!rerouted && i < maxIterations) {
        rerouted = true;
        await store
          .appendPrompt(task.id, {
            at: now(),
            kind: "system",
            text: `the verify command ran green but reads like a sentence, not a check (${verifyCmd}) — not trusted as verification; rerouting to the builder to name how this project is actually verified`,
          })
          .catch(() => {});
        card = {
          ...card,
          task: `${card.task}\n\nThe stored verify command "${verifyCmd}" ran green but reads like a sentence, not a real check — the factory does not trust it as verification. Find how this project is actually verified (package.json scripts, README, existing tests), run that check yourself against your work, and end your reply with exactly one line: VERIFY: <the command> — or VERIFY: none if this work needs no command check.`,
        };
        await store.writeCard(card);
        continue;
      }
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `verification failed: the verify command is a sentence, not a check (${verifyCmd}) — the builder could not name a real one; fix or clear it in Task details, then reply to resume`,
        })
        .catch(() => {});
      return {
        ok: false,
        summary: `verification failed: verify command is a sentence, not a check: ${verifyCmd}`,
      };
    }
    if (verify.ok) {
      if (verifyCmd !== task.verifyCommand) {
        await store
          .writeTask({
            ...task,
            verifyCommand: verifyCmd,
          })
          .catch(() => {});
        await store
          .appendPrompt(task.id, {
            at: now(),
            kind: "system",
            text: verifyCmd
              ? verifyCmd === projectGate
                ? `the project states its own verify gate; it passes: ${verifyCmd} (saved for this task)`
                : `verify command was not runnable; the builder named a working one and it passes: ${verifyCmd} (saved for this task)`
              : "verify command was not runnable; the builder confirmed this work needs no command check (cleared; reviewers judge it)",
          })
          .catch(() => {});
      }
      return {
        ok: true,
        summary,
      };
    }
    if (verifyNotRunnable(verify.out) && !rerouted && i < maxIterations) {
      rerouted = true;
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `verify command is not runnable (${verifyCmd || task.verifyCommand}) — rerouting to the builder to name how this project is verified; the owner is asked only if the builder cannot settle it`,
        })
        .catch(() => {});
      card = {
        ...card,
        task: `${card.task}\n\nThe stored verify command "${verifyCmd || task.verifyCommand}" is not runnable (command not found) — it is probably a sentence, not a program. Find how this project is actually verified (package.json scripts, README, existing tests), run that check yourself against your work, and end your reply with exactly one line: VERIFY: <the command> — or VERIFY: none if this work needs no command check.`,
      };
      await store.writeCard(card);
      continue;
    }
    if (verifyNotRunnable(verify.out)) {
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: `verification failed: the verify command is not runnable (${verifyCmd || task.verifyCommand}): ${verify.out.slice(0, 300)} — the builder could not name a working one; fix or clear it in Task details, then reply to resume`,
        })
        .catch(() => {});
      return {
        ok: false,
        summary: `verification failed: verify command not runnable: ${verifyCmd || task.verifyCommand}`,
      };
    }
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text: `verification failed (${verifyCmd}): ${verify.out.slice(0, 600)}`,
      })
      .catch(() => {});
    if (i === maxIterations)
      return {
        ok: false,
        summary: `verification failed after ${maxIterations} iterations: ${verifyCmd}`,
      };
  }
  return {
    ok: false,
    summary,
  };
}

export type PickupAssessment =
  | {
      action: "pickup";
      currentHead: string;
    }
  | {
      action: "rebase";
      currentHead: string;
      changedFiles: string[];
    }
  | {
      action: "save-and-rebase";
      currentHead: string;
      changedFiles: string[];
      dirtyFiles: string[];
    }
  | {
      action: "ask-user";
      currentHead: string;
      reason: string;
      decisionsDiff?: string;
      overlap?: string[];
    };

const SECRET_NAME =
  /(^|\/)(\.env($|\.)|id_(rsa|ed25519|ecdsa|dsa)(\.|$)|credentials?(\.|$)|secrets?(\.|$)|\.netrc$|\.npmrc$|\.pypirc$)/i;
const SECRET_EXT = /\.(pem|key|p12|pfx|keystore|jks|gpg)$/i;
const SECRET_DIR = /(^|\/)(\.aws|\.ssh|\.gnupg)(\/|$)/;
/**
 * Files that must never be auto-committed by the factory: env files, keys,
 * credential stores. `.env.example`-style templates are documentation, not
 * secrets, and stay committable.
 */
export function isSecretLikeFile(path: string): boolean {
  if (/\.env\.(example|sample|template|dist)$/i.test(path)) return false;
  return SECRET_NAME.test(path) || SECRET_EXT.test(path) || SECRET_DIR.test(path);
}

/**
 * True when the worktree HEAD carries task commits the planned base does
 * not have. Committed work is invisible to a dirty check, and a plain
 * `reset --hard` to the new base would drop it from the worktree — it
 * must go through the same save-and-rebase path as uncommitted work.
 */
export function worktreeAheadOfBase(task: Task): boolean {
  if (
    !task.worktree ||
    !existsSync(task.worktree) ||
    !task.baseCommit ||
    !worktreeLeasedByTask(task)
  )
    return false;
  try {
    return git(task.worktree, `rev-list --count ${task.baseCommit}..HEAD`) !== "0";
  } catch {
    return false;
  }
}

/** Paths with uncommitted changes (modified, staged, or untracked). */
export function listDirtyFiles(worktree: string): string[] {
  const out = execSync("git status --porcelain", {
    cwd: worktree,
    encoding: "utf8",
    timeout: 15_000,
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let p = line.slice(3);
      if (p.includes(" -> ")) p = p.split(" -> ")[1] ?? p;
      return p.replace(/^"|"$/g, "");
    });
}

/**
 * Owner's standing rule: when main moved under a task that has uncommitted
 * work, do not ask — commit and save the work, rebase it onto the new base,
 * and proceed. The one exception is secret-like files (.env, keys,
 * credentials): those are never auto-committed, and their presence (or a
 * rebase conflict) still parks the task for the owner, with any saved
 * commit left intact on the worktree.
 */
export type SaveRebaseResult =
  | {
      ok: true;
      savedCommit: string;
    }
  | {
      ok: false;
      kind: "secret" | "rebase" | "commit" | "error";
      reason: string;
    };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export function saveAndRebaseWorktree(task: Task, currentHead: string): SaveRebaseResult {
  if (!task.worktree || !existsSync(task.worktree))
    return {
      ok: false,
      kind: "error",
      reason: "task has no worktree to save",
    };
  let files: string[];
  try {
    files = listDirtyFiles(task.worktree);
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      reason: `could not read worktree status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const secrets = files.filter(isSecretLikeFile);
  if (secrets.length) {
    return {
      ok: false,
      kind: "secret",
      reason: `main moved and this task has uncommitted secret-like file(s) that are never auto-committed: ${secrets.join(", ")} — commit or remove them, then reply to resume`,
    };
  }
  let savedCommit = "";
  let phase: "commit" | "rebase" = files.length ? "commit" : "rebase";
  try {
    if (files.length) {
      execFileSync(
        "git",
        [
          "add",
          "-A",
          "--",
          ...files,
        ],
        {
          cwd: task.worktree,
          timeout: 30_000,
        },
      );
      execSync(
        `git -c user.name="Agent Factory" -c user.email="factory@localhost" commit -q -m "factory: save uncommitted work before pickup on new base (task ${task.id})"`,
        {
          cwd: task.worktree,
          encoding: "utf8",
          timeout: 60_000,
        },
      );
    }
    savedCommit = git(task.worktree, "rev-parse HEAD");
    phase = "rebase";
    execSync(
      `git -c user.name="Agent Factory" -c user.email="factory@localhost" rebase -q ${currentHead}`,
      {
        cwd: task.worktree,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
  } catch (err) {
    try {
      execSync("git rebase --abort", {
        cwd: task.worktree,
        timeout: 15_000,
      });
    } catch {
      /* nothing to abort */
    }
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (phase === "commit") {
      // The save commit itself failed (index lock, hook, nothing staged
      // after all): the work is still uncommitted in the worktree. This
      // is agent-shaped too — see saveRebaseWithAgentFallback.
      return {
        ok: false,
        kind: "commit",
        reason: `main moved; the factory save commit failed (${detail}) — the work is still uncommitted in the worktree`,
      };
    }
    return {
      ok: false,
      kind: "rebase",
      reason: `main moved; uncommitted work was committed and saved (${savedCommit.slice(0, 7) || "see worktree"}) but rebasing it onto the new base failed (${detail})`,
    };
  }
  return {
    ok: true,
    savedCommit,
  };
}

/**
 * A failed save commit or a rebase conflict is agent-shaped work, so
 * the owner is not asked: a fixer station lands the task's work on the
 * new base. For a rebase it rebases the saved commit and resolves every
 * conflict, keeping both sides (main's edits applied to files the task
 * moved). For a failed save commit it stages and commits the work
 * itself (secret-like files excluded), then rebases. Success is
 * verified mechanically — clean status, no rebase in progress, new
 * base is an ancestor — never taken on the agent's word.
 */
export async function resolveRebaseWithAgent(
  task: Task,
  currentHead: string,
  opts: PipelineOptions,
  failureKind: "rebase" | "commit" = "rebase",
): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  if (!task.worktree || !existsSync(task.worktree))
    return {
      ok: false,
      reason: "task has no worktree",
    };
  const intro =
    failureKind === "commit"
      ? [
          `The factory tried to save this task's uncommitted work before pickup on the new main base ${currentHead}, but its git commit failed. Save the work and land it on the new base.`,
          `The task is: ${task.title}`,
          `The work is still uncommitted in this worktree. Stage it (git add -A) and commit it as the factory would: git -c user.name="Agent Factory" -c user.email="factory@localhost" commit -m "factory: save uncommitted work before pickup on new base (task ${task.id})". If the commit fails again, fix the cause (stale index lock, hook output) without weakening any check. Then run: git rebase ${currentHead} — resolve every conflicted file, keeping BOTH the task's changes and the new changes from main. When the task moved or renamed a file that main also edited, apply main's edits to the moved file. Stage each resolved file and continue (GIT_EDITOR=true git rebase --continue) until the rebase finishes.`,
          `Finish with the worktree clean: git status shows no unmerged paths and no rebase in progress. Reply first line RESOLVED, or UNRESOLVED with the reason.`,
        ]
      : [
          `Resolve the git rebase conflict in this worktree so the task's saved work lands on the new main base ${currentHead}.`,
          `The task is: ${task.title}`,
          `The task's uncommitted work was already committed and saved by the factory; that commit is the current HEAD. Run: git rebase ${currentHead} — then resolve every conflicted file, keeping BOTH the task's changes and the new changes from main. When the task moved or renamed a file that main also edited, apply main's edits to the moved file. Stage each resolved file and continue (GIT_EDITOR=true git rebase --continue) until the rebase finishes.`,
          `Finish with the worktree clean: git status shows no unmerged paths and no rebase in progress. Reply first line RESOLVED, or UNRESOLVED with the reason.`,
        ];
  const card: JobCard = {
    id: "rebase-resolver",
    jobId: task.jobId,
    role: "fixer",
    task: intro.join("\n"),
    worktree: task.worktree,
    constraints: [
      "stay inside this worktree",
      "resolve the rebase only; do not implement the task's feature work",
      "never touch .env, key or credential files — if a conflict involves one, stop and reply UNRESOLVED",
    ],
    gates: [],
  };
  await opts.store.writeCard(card);
  const note = await runStation(card, {
    store: opts.store,
    command: opts.command,
    providerCommands: opts.providerCommands,
    timeoutMs: opts.timeoutMs,
  });
  if (note.status !== "done")
    return {
      ok: false,
      reason: `resolver station did not complete: ${note.summary}`,
    };
  try {
    if (
      execSync("git status --porcelain", {
        cwd: task.worktree,
        encoding: "utf8",
        timeout: 15_000,
      }).trim()
    ) {
      return {
        ok: false,
        reason: "worktree is not clean after the resolver finished",
      };
    }
    for (const state of [
      "rebase-merge",
      "rebase-apply",
    ]) {
      const p = execSync(`git rev-parse --git-path ${state}`, {
        cwd: task.worktree,
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
      if (existsSync(p.startsWith("/") ? p : join(task.worktree, p)))
        return {
          ok: false,
          reason: "a rebase is still in progress after the resolver finished",
        };
    }
    if (!gitOk(task.worktree, `merge-base --is-ancestor ${currentHead} HEAD`)) {
      return {
        ok: false,
        reason: "the new base is not an ancestor of HEAD after the resolver finished",
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `could not verify the resolved rebase: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }
  return {
    ok: true,
  };
}

/**
 * Save-and-rebase with the automatic fallback: a failed save commit or
 * a rebase conflict goes to a fixer agent; only secret-like files or a
 * failed agent resolution park the task for the owner.
 */
export async function saveRebaseWithAgentFallback(
  task: Task,
  currentHead: string,
  opts: PipelineOptions,
  now: () => string,
): Promise<
  | {
      ok: true;
      savedCommit: string;
      byAgent: boolean;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  const saved = saveAndRebaseWorktree(task, currentHead);
  if (saved.ok)
    return {
      ...saved,
      byAgent: false,
    };
  if ((saved.kind !== "rebase" && saved.kind !== "commit") || !task.worktree)
    return {
      ok: false,
      reason: saved.reason,
    };
  await opts.store
    .appendPrompt(task.id, {
      at: now(),
      kind: "system",
      text:
        saved.kind === "commit"
          ? `the factory save commit onto the new base (${currentHead.slice(0, 7)}) failed — a fixer agent is saving and rebasing the work automatically; nothing is lost, the work is in the worktree either way`
          : `rebase onto the new base (${currentHead.slice(0, 7)}) conflicted — a fixer agent is resolving it automatically; the saved commit stays intact either way`,
    })
    .catch(() => {});
  const resolved = await resolveRebaseWithAgent(task, currentHead, opts, saved.kind);
  if (!resolved.ok)
    return {
      ok: false,
      reason: `${saved.reason} — automatic agent resolution also failed: ${resolved.reason}; the saved work is preserved in the worktree, resolve it there and reply to resume`,
    };
  return {
    ok: true,
    savedCommit: git(task.worktree, "rev-parse HEAD"),
    byAgent: true,
  };
}

/**
 * A finish-time merge conflict is agent-shaped work, so the owner is not
 * asked first: a fixer station resolves the in-progress merge of the
 * task's branch in the given worktree (the project checkout for an
 * in-place merge, the detached scratch worktree for an isolated one).
 * The merge is already started when this runs — the agent resolves every
 * conflicted file, keeping BOTH the task's changes and the new changes
 * from main, stages them, and commits the merge. Secret-like files (.env,
 * keys, credentials) are never decided by the agent: when a conflicted
 * file is secret-like, no agent is spawned and the task parks for the
 * owner. Success is verified mechanically — clean tracked tree, no
 * merge in progress, the task branch is an ancestor of HEAD — never
 * taken on the agent's word.
 */
export async function resolveMergeWithAgent(
  task: Task,
  branch: string,
  worktree: string,
  conflictedFiles: string[],
  agentOpts: PipelineOptions,
): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  if (!existsSync(worktree))
    return {
      ok: false,
      reason: "task has no merge worktree",
    };
  const secrets = conflictedFiles.filter(isSecretLikeFile);
  if (secrets.length)
    return {
      ok: false,
      reason: `merge conflict involves secret-like file(s) that are never auto-resolved: ${secrets.join(", ")} — commit or remove them, then reply to resume`,
    };
  const card: JobCard = {
    id: "merge-resolver",
    jobId: task.jobId,
    role: "fixer",
    task: [
      `Resolve the git merge conflict in this worktree so the finished task branch ${branch} lands on main.`,
      `The task is: ${task.title}`,
      `A merge of ${branch} into the checked-out main is already in progress with conflicts in: ${conflictedFiles.join(", ") || "unknown files"}. Resolve every conflicted file, keeping BOTH the task's changes and the new changes from main. When the task moved or renamed a file that main also edited, apply main's edits to the moved file. Stage each resolved file and finish the merge with git commit (keep the default merge message).`,
      `Finish with the worktree clean: git status shows no unmerged paths and no merge in progress. Reply first line RESOLVED, or UNRESOLVED with the reason.`,
    ].join("\n"),
    worktree,
    constraints: [
      "stay inside this worktree",
      "resolve the merge only; do not implement the task's feature work",
      "never touch .env, key or credential files — if a conflict involves one, stop and reply UNRESOLVED",
    ],
    gates: [],
  };
  await agentOpts.store.writeCard(card);
  const note = await runStation(card, {
    store: agentOpts.store,
    command: agentOpts.command,
    timeoutMs: agentOpts.timeoutMs,
  });
  if (note.status !== "done")
    return {
      ok: false,
      reason: `resolver station did not complete: ${note.summary}`,
    };
  const check = verifyResolvedMerge(worktree, branch, conflictedFiles);
  if (check)
    return {
      ok: false,
      reason: check,
    };
  return {
    ok: true,
  };
}

/** Mechanical proof of an agent-resolved merge; returns a problem or "". */
function verifyResolvedMerge(worktree: string, branch: string, conflictedFiles: string[]): string {
  try {
    // Tracked-only: untracked factory infrastructure (slot ignore
    // files) does not count, matching the merge gate's clean check.
    if (
      execSync("git status --porcelain --untracked-files=no", {
        cwd: worktree,
        encoding: "utf8",
        timeout: 15_000,
      }).trim()
    )
      return "worktree is not clean after the resolver finished";
    if (mergeInProgress(worktree))
      return "a merge is still in progress after the resolver finished";
    if (!gitOk(worktree, `merge-base --is-ancestor ${branch} HEAD`))
      return "the task branch is not an ancestor of HEAD after the resolver finished";
    // HEAD must be a real merge commit (two parents): a plain one-sided
    // commit on top of main is not a resolution of this merge.
    const parents = git(worktree, "rev-list --parents -n 1 HEAD").split(" ").filter(Boolean);
    if (parents.length < 3) return "HEAD is not a merge commit after the resolver finished";
    for (const file of conflictedFiles) {
      const full = join(worktree, file);
      if (existsSync(full) && /^(<{7}|={7}|>{7})/m.test(readFileSync(full, "utf8")))
        return `conflict markers remain in ${file} after the resolver finished`;
      // Keep-BOTH, mechanically: when the two parents differ on this
      // file, a result identical to either parent alone discarded the
      // other side (e.g. `checkout --theirs` + commit) — not a resolution.
      const at = (ref: string): string | null => {
        try {
          return git(worktree, `show "${ref}:${file}"`);
        } catch {
          return null;
        }
      };
      const first = at("HEAD^1");
      const second = at("HEAD^2");
      const merged = at("HEAD");
      if (first !== second && (merged === first || merged === second))
        return `resolution of ${file} kept only one side of the conflict; both sides must be kept`;
    }
    return "";
  } catch (err) {
    return `could not verify the resolved merge: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

// A decisions file by name, anywhere in the tree, with vendored/generated
// directories excluded. `decision(s)` plus any suffix counts (so
// `decisions.md`, `decision.md`, `DECISION_LOG.md`, `decisions-ops.md` all
// match); the factory's own `data/` output and dependency directories never
// count as decisions.
const DECISIONS_FILE_NAME = /(^|\/)decisions?[^/]*\.md$/i;
const NON_DECISIONS_DIR =
  /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.enjoy-worktrees|data)\//;
export const isDecisionsFile = (path: string): boolean =>
  !NON_DECISIONS_DIR.test(path) && DECISIONS_FILE_NAME.test(path);

/**
 * Content hash of every decisions file at a commit. Pinned to a task as
 * its baseline: while main's decisions hash matches, no decisions check
 * (and no agent) is needed at all. "" when unreadable.
 */
export function decisionsHashAt(repo: string, commit: string): string {
  try {
    const files = git(repo, `ls-tree -r --name-only ${commit}`)
      .split("\n")
      .filter(isDecisionsFile)
      .sort();
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file}\n${git(repo, `show "${commit}:${file}"`)}\n`);
    return hash.digest("hex");
  } catch {
    return "";
  }
}

/** A decisions diff that only adds lines (no removals). */
export function isAdditionsOnlyDiff(diff: string): boolean {
  return !diff.split("\n").some((l) => l.startsWith("-") && !l.startsWith("---"));
}

// An added decisions line that loosens an existing decision rather than
// tightening it: exceptions, carve-outs, reversals. These must still go to
// the impact judge even though the diff is additions-only.
const DECISION_WEAKENING =
  /\b(exception|exceptions|unless|however|no longer applies?|does not apply|is not required|not required|waiv(er|ed)|instead of|carve-?out|exempt(ion)?|only when)\b/i;

/** Added lines of a unified diff, with the leading `+` stripped. */
function addedLinesOf(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/**
 * A decisions diff that only adds lines AND none of those lines loosens an
 * existing decision. The pickup fast path auto-proceeds on this; anything
 * that could weaken a recorded decision still goes to the impact judge.
 */
export function isTighteningOnlyDiff(diff: string): boolean {
  if (!isAdditionsOnlyDiff(diff)) return false;
  return !addedLinesOf(diff).some((line) => DECISION_WEAKENING.test(line));
}

/**
 * Normalize a decision line for duplicate detection: case, punctuation,
 * whitespace and bullet prefixes are ignored, so a decision restated with
 * slightly different wording still matches the recorded one.
 */
export function normalizeDecisionLine(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[-*+]\s*/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Before a planned task is implemented, check whether the project moved
 * since the plan was cut: has main (the repo HEAD) advanced, and did a
 * decisions file (DECISIONS.md and kin, anywhere in the tree) change?
 * - main unchanged: pick the task up as planned.
 * - main moved, no decisions change, clean worktree, base is an ancestor:
 *   pick it up on the new base ("rebase": the slot is reset to HEAD).
 * - main moved with uncommitted worktree work: the owner's standing rule
 *   is commit-and-save, never ask ("save-and-rebase"); only secret-like
 *   files or a failed rebase park the task (applied by the caller).
 * - decisions changed, history diverged, or the base cannot be compared:
 *   do not guess — ask the owner first ("ask-user").
 * Read-only: callers apply the outcome.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export function assessPickup(repo: string, task: Task): PickupAssessment {
  let currentHead = "";
  try {
    currentHead = git(repo, "rev-parse HEAD");
  } catch {
    return {
      action: "pickup",
      currentHead,
    }; // prepareWorktree surfaces repo errors properly
  }
  const base = task.baseCommit;
  if (!base || base === currentHead)
    return {
      action: "pickup",
      currentHead,
    };
  let changedFiles: string[];
  try {
    const out = git(repo, `diff --name-only ${base}..${currentHead}`);
    changedFiles = out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return {
      action: "ask-user",
      currentHead,
      reason: `main moved (${base.slice(0, 7)} -> ${currentHead.slice(0, 7)}) and the planned base can no longer be compared with it; confirm the plan is still valid or re-plan before implementing`,
    };
  }
  const decisions = changedFiles.filter(isDecisionsFile);
  if (decisions.length) {
    // Show the owner what actually changed and where it touches this
    // task, instead of only naming the file: the decisions diff itself,
    // plus the overlap — main-changed files this task's plan names or
    // its worktree has already touched.
    let decisionsDiff = "";
    try {
      decisionsDiff = git(
        repo,
        `diff ${base}..${currentHead} -- ${decisions.map((f) => `"${f}"`).join(" ")}`,
      ).slice(0, 2500);
    } catch {
      /* the reason still stands without the diff */
    }
    const planText = `${task.prompt}\n${task.plan}`;
    const overlap = changedFiles.filter((f) => planText.includes(f));
    if (task.worktree && existsSync(task.worktree)) {
      for (const a of worktreeActivity(task))
        if (changedFiles.includes(a.file) && !overlap.includes(a.file)) overlap.push(a.file);
    }
    return {
      action: "ask-user",
      currentHead,
      reason: `${decisions.join(", ")} changed on main since this plan was approved (${base.slice(0, 7)} -> ${currentHead.slice(0, 7)}); check the plan against the new decision(s) and reply to resume, or re-plan if it no longer holds`,
      decisionsDiff,
      overlap,
    };
  }
  if (task.worktree && existsSync(task.worktree)) {
    let dirtyFiles: string[] = [];
    try {
      dirtyFiles = listDirtyFiles(task.worktree);
    } catch {
      // a status failure is not a reason to block pickup on its own
    }
    if (
      (dirtyFiles.length || worktreeAheadOfBase(task)) &&
      gitOk(repo, `merge-base --is-ancestor ${base} ${currentHead}`)
    ) {
      // Standing rule: save the work and proceed; the caller commits it,
      // rebases onto the new base, and only parks for secret-like files
      // or a rebase conflict.
      return {
        action: "save-and-rebase",
        currentHead,
        changedFiles,
        dirtyFiles,
      };
    }
  }
  if (!gitOk(repo, `merge-base --is-ancestor ${base} ${currentHead}`)) {
    return {
      action: "ask-user",
      currentHead,
      reason: `main history diverged from the planned base (${base.slice(0, 7)} is not an ancestor of ${currentHead.slice(0, 7)}); confirm the plan is still valid or re-plan before implementing`,
    };
  }
  return {
    action: "rebase",
    currentHead,
    changedFiles,
  };
}

export interface MergeDecisions {
  mainChanged: string[]; // decisions files main changed since the task's base
  taskChanged: string[]; // decisions files the merged result would change vs main
  duplicates: string[]; // lines the task adds that main's decisions already state
  diff: string; // what merging would do to the decisions files vs main
}

const noDecisions: MergeDecisions = {
  mainChanged: [],
  taskChanged: [],
  duplicates: [],
  diff: "",
};

export type MergeAssessment =
  | {
      status: "clean";
      currentHead: string;
      decisions: MergeDecisions;
    }
  | {
      status: "conflict";
      currentHead: string;
      files: string[];
      decisions: MergeDecisions;
    }
  | {
      status: "unknown";
      currentHead: string;
      reason: string;
    };

/**
 * Review gate: can this task's work land on current main without a merge
 * conflict? Read-only — the worktree state is snapshotted through a
 * temporary index into a dangling commit (no ref moves, main untouched)
 * and merged virtually with `git merge-tree`. A task still based on
 * current main is clean by construction; when main has not moved there
 * is nothing to check. "unknown" never blocks: it means git could not
 * answer, not that a conflict exists.
 *
 * Decisions files get extra scrutiny even when git merges them cleanly:
 * decisions are only ever added to and extended, never silently
 * contradicted. The assessment reports which decisions files the merge
 * would change relative to main, the diff, and any added lines main
 * already states (candidates to compress); the caller shows that to the
 * owner and waits for a decision instead of landing it quietly.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function assessMergeability(
  repo: string,
  task: Task,
  opts?: {
    expectedCommit?: string;
    forceRef?: boolean;
    againstCommit?: string;
  },
): MergeAssessment {
  let currentHead = opts?.againstCommit ?? "";
  if (!currentHead) {
    try {
      currentHead = git(repo, "rev-parse HEAD");
    } catch {
      return {
        status: "unknown",
        currentHead,
        reason: "cannot read the current main commit",
      };
    }
  }
  const base = task.baseCommit;
  if (!base || base === currentHead)
    return {
      status: "clean",
      currentHead,
      decisions: noDecisions,
    };
  const useRef =
    !!opts?.forceRef || !task.worktree || !existsSync(task.worktree) || !worktreeLeasedByTask(task);
  if (useRef) {
    try {
      const commit = opts?.expectedCommit || persistedBranchCommit(repo, task);
      if (!commit)
        return {
          status: "unknown",
          currentHead,
          reason: "task has no worktree to check",
        };
      const tree = git(repo, `rev-parse "${commit}^{tree}"`);
      const mainChanged = git(repo, `diff --name-only ${base}..${currentHead}`)
        .split("\n")
        .filter(isDecisionsFile);
      if (tree === git(repo, `rev-parse "${currentHead}^{tree}"`))
        return {
          status: "clean",
          currentHead,
          decisions: {
            ...noDecisions,
            mainChanged,
          },
        };
      const snapshot = commit;
      const taskChanged = git(repo, `diff --name-only ${currentHead} ${snapshot}`)
        .split("\n")
        .filter(isDecisionsFile);
      let diff = "";
      const duplicates: string[] = [];
      if (taskChanged.length) {
        diff = git(
          repo,
          `diff ${currentHead} ${snapshot} -- ${taskChanged.map((f) => `"${f}"`).join(" ")}`,
        ).slice(0, 2000);
        for (const file of taskChanged) {
          let mainText = "";
          try {
            mainText = git(repo, `show "${currentHead}:${file}"`);
          } catch {
            /* new file */
          }
          const mainLines = new Set(
            mainText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean),
          );
          for (const line of diff.split("\n")) {
            if (!line.startsWith("+") || line.startsWith("+++")) continue;
            const text = line.slice(1).trim();
            if (text.length > 3 && mainLines.has(text) && !duplicates.includes(text))
              duplicates.push(text);
          }
        }
      }
      const decisions: MergeDecisions = {
        mainChanged,
        taskChanged,
        duplicates: duplicates.slice(0, 5),
        diff,
      };
      try {
        execSync(`git merge-tree --write-tree --name-only ${currentHead} ${snapshot}`, {
          cwd: repo,
          encoding: "utf8",
          timeout: 30_000,
        });
        return {
          status: "clean",
          currentHead,
          decisions,
        };
      } catch (err) {
        const out = String(
          (
            err as {
              stdout?: unknown;
            }
          ).stdout ?? "",
        );
        const section = out.split("\n").slice(1);
        const blank = section.findIndex((l) => !l.trim());
        const files = section
          .slice(0, blank === -1 ? section.length : blank)
          .map((l) => l.trim().replace(/^"|"$/g, ""))
          .filter((l, i, a) => l && a.indexOf(l) === i);
        if (!files.length)
          return {
            status: "unknown",
            currentHead,
            reason: "git merge-tree could not compare the work with main",
          };
        return {
          status: "conflict",
          currentHead,
          files,
          decisions,
        };
      }
    } catch (err) {
      return {
        status: "unknown",
        currentHead,
        reason: err instanceof Error ? (err.message.split("\n")[0] ?? "git failed") : "git failed",
      };
    }
  }
  const indexFile = join(tmpdir(), `factory-merge-check-${task.id}.index`);
  const gitWt = (args: string) =>
    execSync(`git ${args}`, {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_INDEX_FILE: indexFile,
      },
    }).trim();
  try {
    const workHead = gitOk(task.worktree, "rev-parse HEAD")
      ? git(task.worktree, "rev-parse HEAD")
      : base;
    gitWt(`read-tree ${workHead}`);
    gitWt("add -A");
    const tree = gitWt("write-tree");
    const mainChanged = git(repo, `diff --name-only ${base}..${currentHead}`)
      .split("\n")
      .filter(isDecisionsFile);
    if (tree === git(repo, `rev-parse "${currentHead}^{tree}"`))
      return {
        status: "clean",
        currentHead,
        decisions: {
          ...noDecisions,
          mainChanged,
        },
      };
    const snapshot = git(repo, `commit-tree ${tree} -p ${workHead} -m "factory merge check"`);
    // What would the merge change in decisions files, relative to main?
    const taskChanged = git(repo, `diff --name-only ${currentHead} ${snapshot}`)
      .split("\n")
      .filter(isDecisionsFile);
    let diff = "";
    const duplicates: string[] = [];
    if (taskChanged.length) {
      diff = git(
        repo,
        `diff ${currentHead} ${snapshot} -- ${taskChanged.map((f) => `"${f}"`).join(" ")}`,
      ).slice(0, 2000);
      for (const file of taskChanged) {
        let mainText = "";
        try {
          mainText = git(repo, `show "${currentHead}:${file}"`);
        } catch {
          /* new decisions file: nothing to duplicate */
        }
        // Exact and normalized comparison: a decision restated with different
        // wording still counts as a duplicate to compress, not just identical
        // trimmed lines.
        const mainLines = new Map<string, string>(); // normalized -> original
        for (const l of mainText.split("\n")) {
          const t = l.trim();
          if (t) mainLines.set(normalizeDecisionLine(t), t);
        }
        for (const line of diff.split("\n")) {
          if (!line.startsWith("+") || line.startsWith("+++")) continue;
          const text = line.slice(1).trim();
          if (text.length <= 3) continue;
          const original = mainLines.get(normalizeDecisionLine(text));
          if (original && !duplicates.includes(original)) duplicates.push(original);
        }
      }
    }
    const decisions: MergeDecisions = {
      mainChanged,
      taskChanged,
      duplicates: duplicates.slice(0, 5),
      diff,
    };
    try {
      execSync(`git merge-tree --write-tree --name-only ${currentHead} ${snapshot}`, {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      });
      return {
        status: "clean",
        currentHead,
        decisions,
      };
    } catch (err) {
      const out = String(
        (
          err as {
            stdout?: unknown;
          }
        ).stdout ?? "",
      );
      // --name-only output: tree OID, conflicted files, blank line, messages.
      const section = out.split("\n").slice(1);
      const blank = section.findIndex((l) => !l.trim());
      const files = section
        .slice(0, blank === -1 ? section.length : blank)
        .map((l) => l.trim().replace(/^"|"$/g, ""))
        .filter((l, i, a) => l && a.indexOf(l) === i);
      // merge-tree exits 1 on conflict; other failures leave no file list.
      if (!files.length)
        return {
          status: "unknown",
          currentHead,
          reason: "git merge-tree could not compare the work with main",
        };
      return {
        status: "conflict",
        currentHead,
        files,
        decisions,
      };
    }
  } catch (err) {
    return {
      status: "unknown",
      currentHead,
      reason: err instanceof Error ? (err.message.split("\n")[0] ?? "git failed") : "git failed",
    };
  } finally {
    try {
      unlinkSync(indexFile);
    } catch {
      /* temp index may not exist */
    }
  }
}

/**
 * Impact judge for a decisions change on main: tightening or extending
 * recorded decisions (adding rules, narrowing freedom) does not need the
 * owner — the task proceeds on the new base. Anything that contradicts
 * the task's stated request or approved plan, removes or weakens a
 * decision the plan relies on, or changes scope goes to the owner.
 * Fails closed: an unclear verdict asks the owner.
 */
export async function judgeDecisionsImpact(
  task: Task,
  pickup: {
    currentHead: string;
    decisionsDiff?: string;
    overlap?: string[];
  },
  opts: PipelineOptions,
): Promise<{
  proceed: boolean;
  reason: string;
}> {
  const { store } = opts;
  const card: JobCard = {
    id: "decisions-judge",
    jobId: task.jobId,
    role: "planner",
    task: [
      `You are the impact judge for a decisions-file change on main. Reply first line exactly PROCEED or ASK-OWNER, then one or two lines of reasoning.`,
      `Task the owner stated: ${task.prompt}`,
      `Approved plan:\n${task.plan.slice(0, 2500)}`,
      `Main moved ${task.baseCommit.slice(0, 7)} -> ${pickup.currentHead.slice(0, 7)}. Decisions change:\n${pickup.decisionsDiff || "(no diff available)"}`,
      `Files main changed that this task names or touches: ${(pickup.overlap ?? []).join(", ") || "none"}.`,
      `PROCEED when the change only adds or tightens decisions (new rules, narrower freedom, clarifications) and nothing in it contradicts the task or its plan — the work simply continues under the stricter rules. ASK-OWNER when anything contradicts the stated task or plan, removes or weakens a decision the plan relies on, reverses a previous decision, or widens scope. When in doubt, ASK-OWNER.`,
    ].join("\n"),
    worktree: task.worktree || ".",
    constraints: [
      "judge only; do not edit anything",
      "first line must be PROCEED or ASK-OWNER",
    ],
    gates: [],
  };
  await store.writeCard(card);
  try {
    const done = await runStation(card, {
      store,
      command: opts.command,
      providerCommands: opts.providerCommands,
      timeoutMs: opts.timeoutMs,
    });
    if (done.status !== "done")
      return {
        proceed: false,
        reason: `impact judge station failed: ${done.summary}`,
      };
    const first = (done.summary.split("\n")[0] ?? "").trim().toUpperCase();
    const reason = (done.detail || done.summary).slice(0, 500);
    return {
      proceed: first.startsWith("PROCEED"),
      reason,
    };
  } catch (err) {
    return {
      proceed: false,
      reason: `impact judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Implementation <-> review loop: builder (Ralph loop with verification),
 * then SME and coder reviewers stating intent and verdict. Rejection
 * bounces back to implementation with tier escalation; convergence is
 * the only way to Done. Every hand-off is persisted.
 */

async function captureVisualPair(
  task: Task,
  opts: PipelineOptions,
  moments: ReturnType<typeof resolveVisualMoments>,
  dirs: {
    baselineDir: string;
    afterDir: string;
  },
): Promise<void> {
  const { store } = opts;
  const project = await store.readProject(task.projectId).catch(() => null);
  if (opts.visualCapture) {
    await opts.visualCapture({
      cwd: task.worktree,
      moments,
      outDir: dirs.afterDir,
    });
    await opts.visualCapture({
      cwd: project?.repoPath ?? task.worktree,
      moments,
      outDir: dirs.baselineDir,
    });
    return;
  }
  if (!project?.repoPath)
    throw new Error("project has no local repo path for the baseline capture");
  if (!project.devCommand || !project.devPort)
    throw new Error(
      "Visual Review needs the project's dev command and port configured (Settings → project) so pages can be screenshot on the base commit and the feature branch",
    );
  await captureMoments({
    cwd: task.worktree,
    moments,
    outDir: dirs.afterDir,
    serverCommand: project.devCommand,
    serverPort: project.devPort,
  });
  await captureAtCommit({
    repo: project.repoPath,
    commit: task.baseCommit || "HEAD",
    moments,
    outDir: dirs.baselineDir,
    serverCommand: project.devCommand,
    serverPort: project.devPort,
    nodeModulesFrom: task.worktree,
  });
}

function classifyVisualShots(
  moments: ReturnType<typeof resolveVisualMoments>,
  dirs: {
    baselineDir: string;
    afterDir: string;
    diffDir: string;
  },
  threshold: number,
): VisualReview["shots"] {
  mkdirSync(dirs.diffDir, {
    recursive: true,
  });
  const read = (dir: string, file: string) => {
    try {
      return readFileSync(join(dir, file));
    } catch {
      return null;
    }
  };
  return moments.map((moment) => {
    const file = `${sanitizeShotName(moment.name)}.png`;
    const { shot, diffPng } = classifyShot({
      name: moment.name,
      route: moment.route,
      viewport: moment.viewport,
      baselinePng: read(dirs.baselineDir, file),
      afterPng: read(dirs.afterDir, file),
      threshold,
    });
    if (diffPng) writeFileSync(join(dirs.diffDir, file), diffPng);
    return {
      ...shot,
      baseline: shot.status === "new" ? "" : `baseline/${file}`,
      after: shot.status === "missing-after" ? "" : `after/${file}`,
      diff: diffPng ? `diff/${file}` : "",
    };
  });
}

/**
 * Visual Review stage: after code review and final verify, before Land.
 * Captures the plan's key moments on the base commit (baseline, via git
 * archive into a temp dir) and on the feature worktree (after), pixel-
 * diffs them, and stores everything under the store (outside git).
 * No page affected -> skipped. Changed/new -> park for the owner.
 * Missing moments on a visual task -> bounce to the builder.
 */
export async function runVisualStage(
  task: Task,
  opts: PipelineOptions,
  now: () => string,
): Promise<{
  action: "pass" | "park" | "bounce";
  reason: string;
  task: Task;
}> {
  const { store } = opts;
  const touched = worktreeActivity(task).map((a) => a.file);
  const moments = resolveVisualMoments(task.plan, task.worktree);
  if (!isVisualRelevant(task.taskType, touched, moments.length)) {
    if (task.visualState !== "skipped") {
      task = {
        ...task,
        visualState: "skipped",
        updatedAt: now(),
      };
      await store.writeTask(task).catch(() => {});
    }
    return {
      action: "pass",
      reason: "no page affected",
      task,
    };
  }
  if (!moments.length) {
    return {
      action: "bounce",
      task,
      reason:
        'Visual Review: this work creates or changes pages/UI but no key moments are declared. Add a "## Visual moments" section to the plan (one "- name: /route" bullet per new or affected page, with click/fill steps where the moment needs interaction) and write visual.moments.json at the worktree root mirroring it, then finish. Screenshots are captured by the factory outside git; do not create PNGs yourself.',
    };
  }
  const threshold = opts.visualThreshold ?? 0.001;
  const visualDir = store.visualDir(task.id);
  const dirs = {
    baselineDir: join(visualDir, "baseline"),
    afterDir: join(visualDir, "after"),
    diffDir: join(visualDir, "diff"),
  };
  try {
    assertOutsideWorktree(task.worktree, visualDir);
    await captureVisualPair(task, opts, moments, dirs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const review: VisualReview = {
      taskId: task.id,
      status: "error",
      at: now(),
      baseCommit: task.baseCommit,
      threshold,
      reason,
      shots: [],
      comments: (await store.readVisualReview(task.id).catch(() => null))?.comments ?? [],
    };
    await store.writeVisualReview(task.id, review).catch(() => {});
    task = {
      ...task,
      visualState: "error",
      updatedAt: now(),
    };
    await store.writeTask(task).catch(() => {});
    return {
      action: "park",
      reason: `visual capture failed: ${reason}`,
      task,
    };
  }
  const shots = classifyVisualShots(moments, dirs, threshold);
  return finishVisualReview(task, opts, now, shots, threshold);
}

async function finishVisualReview(
  task: Task,
  opts: PipelineOptions,
  now: () => string,
  shots: VisualReview["shots"],
  threshold: number,
): Promise<{
  action: "pass" | "park" | "bounce";
  reason: string;
  task: Task;
}> {
  const { store } = opts;
  const probe: VisualReview = {
    taskId: task.id,
    status: "pending",
    at: now(),
    baseCommit: task.baseCommit,
    threshold,
    reason: "",
    shots,
    comments: [],
  };
  const changed = changedShots(probe);
  const review: VisualReview = {
    ...probe,
    status: changed.length ? "pending" : "passed",
    reason: changed.length ? "" : "all screenshots match the base commit",
    comments: (await store.readVisualReview(task.id).catch(() => null))?.comments ?? [],
  };
  await store.writeVisualReview(task.id, review).catch(() => {});
  const gate = visualGateAction(review, task.visualApprovedHashes ?? []);
  const visualState = gate.action !== "pass" ? "pending" : changed.length ? "approved" : "passed";
  const next = {
    ...task,
    visualState: visualState as Task["visualState"],
    updatedAt: now(),
  };
  await store.writeTask(next).catch(() => {});
  return {
    action: gate.action,
    reason: gate.reason,
    task: next,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function runTaskPipelineInner(taskId: string, opts: PipelineOptions): Promise<Task> {
  const { store } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  const maxReviewRounds = opts.maxReviewRounds ?? 2;
  let task = await store.readTask(taskId);
  if (!task) throw new Error(`task ${taskId}: not found`);
  if (task.state !== "planned" && task.state !== "running") return task;

  try {
    task = await prepareWorktree(store, task, {
      maxParallelTasks: opts.maxParallelTasks,
    });
  } catch (err) {
    if (err instanceof WorktreePoolFullError) return task; // no slot yet: stays queued for a later tick
    const reason = err instanceof Error ? err.message : String(err);
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: `dispatch blocked: ${reason}`,
      })
      .catch(() => {});
    return store.moveTask(taskId, "blocked", now());
  }
  if (task.state === "planned") task = await store.moveTask(taskId, "running", now());

  // Stale-plan gate: the plan is pinned to the commit it was drafted
  // against. If main moved since, an agent first checks whether the
  // plan still holds against the new HEAD: still-holds re-pins and
  // the builder continues with no owner input; only a plan that no
  // longer holds parks, with the agent's questions. (Owner can also
  // reply "proceed anyway" to skip the check.) Checked before the
  // pickup save-and-rebase below, about worktree work, not plans.
  const stale = await resolveStalePlan(store, task, opts);
  if (!stale.proceed) {
    await store
      .appendPrompt(taskId, {
        at: now(),
        kind: "system",
        text: stale.note,
      })
      .catch(() => {});
    const parked = await store.moveTask(taskId, "needs-input", now()).catch(() => null);
    return parked ?? (await store.readTask(taskId)) ?? task;
  }
  task = (await store.readTask(taskId)) ?? task;

  // Pickup gate: never implement a plan blindly after main moved.
  const pickupProject = await store.readProject(task.projectId).catch(() => null);
  if (pickupProject?.repoPath) {
    let pickup = assessPickup(pickupProject.repoPath, task);
    // Standing rule: uncommitted work is committed and saved, then rebased
    // onto the new base — the owner is not asked. A rebase conflict goes
    // to a fixer agent; only secret-like files or a failed resolution
    // still park the task.
    if (pickup.action === "save-and-rebase") {
      const saved = await saveRebaseWithAgentFallback(task, pickup.currentHead, opts, now);
      if (saved.ok) {
        task = {
          ...task,
          baseCommit: pickup.currentHead,
        };
        await store.writeTask(task);
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `main moved since planning (${pickup.changedFiles.length} file(s) changed); uncommitted work auto-saved in commit ${saved.savedCommit.slice(0, 7)} and rebased onto the new base ${pickup.currentHead.slice(0, 7)}${saved.byAgent ? " (conflict resolved by a fixer agent)" : ""} — proceeding without owner input`,
          })
          .catch(() => {});
        pickup = {
          action: "pickup",
          currentHead: pickup.currentHead,
        };
      } else {
        pickup = {
          action: "ask-user",
          currentHead: pickup.currentHead,
          reason: saved.reason,
        };
      }
    }
    // A decisions change does not automatically need the owner: an impact
    // judge reads the diff against this task first. Tightening or
    // extending decisions proceeds on the new base like a plain rebase;
    // only a contradiction (or an unclear verdict) asks the owner.
    if (pickup.action === "ask-user" && pickup.decisionsDiff !== undefined) {
      // Phase-1 fast paths, no agent: (a) decisions content is unchanged
      // since this task's pinned baseline; (b) the change is additions-only
      // and tightening (no exceptions/weakenings) by construction. Both
      // proceed like a rebase; a weakening still goes to the impact judge.
      const baselineHash =
        task.decisionsBaselineHash || decisionsHashAt(pickupProject.repoPath, task.baseCommit);
      const currentHash = decisionsHashAt(pickupProject.repoPath, pickup.currentHead);
      const tighteningOnly = isTighteningOnlyDiff(pickup.decisionsDiff ?? "");
      if ((baselineHash && currentHash && baselineHash === currentHash) || tighteningOnly) {
        let dirty = true;
        try {
          dirty =
            !task.worktree ||
            !existsSync(task.worktree) ||
            !!execSync("git status --porcelain", {
              cwd: task.worktree,
              encoding: "utf8",
              timeout: 15_000,
            }).trim();
        } catch {
          /* keep dirty */
        }
        if (!dirty && worktreeAheadOfBase(task)) dirty = true; // committed work must be rebased, never reset away
        let savedOntoNewBase = false;
        if (dirty && task.worktree && existsSync(task.worktree)) {
          // Standing rule: save uncommitted work instead of asking; a
          // rebase conflict is resolved by a fixer agent.
          const saved = await saveRebaseWithAgentFallback(task, pickup.currentHead, opts, now);
          if (saved.ok) {
            dirty = false;
            savedOntoNewBase = true;
          }
        }
        if (
          task.worktree &&
          existsSync(task.worktree) &&
          !dirty &&
          gitOk(
            pickupProject.repoPath,
            `merge-base --is-ancestor ${task.baseCommit} ${pickup.currentHead}`,
          )
        ) {
          if (!savedOntoNewBase) git(task.worktree, `reset --hard -q ${pickup.currentHead}`);
          task = {
            ...task,
            baseCommit: pickup.currentHead,
            decisionsBaselineHash: currentHash || baselineHash,
          };
          await store.writeTask(task);
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text:
                baselineHash === currentHash
                  ? `decisions unchanged since this task's baseline — proceeding on the new base (${pickup.currentHead.slice(0, 7)}), no decisions check needed`
                  : `decisions changed on main (${pickup.currentHead.slice(0, 7)}) but the change only adds/tightens decisions (no exceptions or weakenings) — proceeding on the new base, no impact judge needed`,
            })
            .catch(() => {});
          pickup = {
            action: "pickup",
            currentHead: pickup.currentHead,
          };
        }
      }
    }
    if (pickup.action === "ask-user" && pickup.decisionsDiff !== undefined) {
      const judge = await judgeDecisionsImpact(task, pickup, opts);
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "agent",
          text: `decisions-judge: ${judge.reason}`,
        })
        .catch(() => {});
      if (judge.proceed) {
        let dirty = true; // unknown cleanliness never auto-rebases
        try {
          dirty =
            !task.worktree ||
            !existsSync(task.worktree) ||
            !!execSync("git status --porcelain", {
              cwd: task.worktree,
              encoding: "utf8",
              timeout: 15_000,
            }).trim();
        } catch {
          /* keep dirty */
        }
        if (!dirty && worktreeAheadOfBase(task)) dirty = true; // committed work must be rebased, never reset away
        let savedOntoNewBase = false;
        if (dirty && task.worktree && existsSync(task.worktree)) {
          // Standing rule: save uncommitted work instead of asking; a
          // rebase conflict is resolved by a fixer agent.
          const saved = await saveRebaseWithAgentFallback(task, pickup.currentHead, opts, now);
          if (saved.ok) {
            dirty = false;
            savedOntoNewBase = true;
          }
        }
        if (
          !dirty &&
          gitOk(
            pickupProject.repoPath,
            `merge-base --is-ancestor ${task.baseCommit} ${pickup.currentHead}`,
          )
        ) {
          if (!savedOntoNewBase) git(task.worktree, `reset --hard -q ${pickup.currentHead}`);
          task = {
            ...task,
            baseCommit: pickup.currentHead,
            decisionsBaselineHash: decisionsHashAt(pickupProject.repoPath, pickup.currentHead),
          };
          await store.writeTask(task);
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `decisions changed on main (${pickup.currentHead.slice(0, 7)}); impact judge: tightening/extending only, no contradiction with this task — proceeding on the new base without owner input`,
            })
            .catch(() => {});
          pickup = {
            action: "pickup",
            currentHead: pickup.currentHead,
          };
        }
      }
    }
    if (pickup.action === "ask-user") {
      const detail = [
        pickup.decisionsDiff
          ? `\n\nWhat changed in the decisions file(s) since this plan was approved:\n${pickup.decisionsDiff}`
          : "",
        pickup.overlap !== undefined
          ? `\n\nOverlap with this task: ${pickup.overlap.length ? `main also changed ${pickup.overlap.join(", ")} — file(s) this task's plan names or its worktree already touches. Everything else main changed does not touch this task.` : "none — no file main changed is named by this task's plan or touched in its worktree; the new decision(s) only matter if they contradict the plan's approach."}`
          : "",
      ].join("");
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `pickup paused: ${pickup.reason}${detail}`,
        })
        .catch(() => {});
      return store.moveTask(taskId, "needs-input", now());
    }
    if (pickup.action === "rebase") {
      git(task.worktree, `reset --hard -q ${pickup.currentHead}`);
      task = {
        ...task,
        baseCommit: pickup.currentHead,
      };
      await store.writeTask(task);
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `main moved since planning (${pickup.changedFiles.length} file(s) changed, no decisions file touched); picked up on new base ${pickup.currentHead.slice(0, 7)}`,
        })
        .catch(() => {});
    }
  }

  // Prerequisite re-check: main may have been re-pinned since the tick
  // checked HEAD, so verify again against the final base before the
  // builder loop. A missing item sends the task back to planned — no
  // attempt is consumed — and frees its slot; the tick owns the count.
  const prereqHold = await gatePrereqsForPipeline(store, task, pickupProject?.repoPath, now());
  if (prereqHold === "malformed") return store.moveTask(taskId, "blocked", now());
  if (prereqHold === "deferred") {
    releaseWorktree(task);
    return store.moveTask(taskId, "planned", now());
  }
  task = (await store.readTask(taskId)) ?? task;

  const prompts = await store.listPrompts(taskId);
  let instruction =
    [
      ...prompts,
    ]
      .reverse()
      .find((p) => p.kind === "user")?.text ?? "";
  if (instruction === task.prompt) instruction = "";
  let judgeEscalated = false;

  const maxAttempts = opts.maxAttempts ?? 6;
  for (let round = 0; round <= maxReviewRounds; round++) {
    if (task.attempts >= maxAttempts) {
      // Attempt cap: this task has burned its implementation-attempt
      // budget without converging. Fail terminally instead of churning
      // another round — the auto-retro files points, and the owner
      // re-plans or re-scopes before it is retried. Quota pauses do not
      // consume the budget (they un-increment below), so a task parked
      // only on a quota reset is never failed here.
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `attempt cap reached: ${task.attempts} implementation attempt(s) without converging — failing terminally instead of retrying again. Re-plan or re-scope this task, then send it back to Planned to try again.`,
        })
        .catch(() => {});
      return store.moveTask(taskId, "failed", now());
    }
    task = {
      ...task,
      attempts: task.attempts + 1,
    };
    await store.writeTask(task);
    const built = await builderLoop(task, instruction, opts);
    if (!built.ok) {
      if (built.summary.startsWith("quota:")) {
        // Token limit, not a failure: park as quota-wait. The dispatch
        // resume sweep picks it up after the global quota pause (the
        // station already recorded it), with no owner input. A quota
        // pause is not an implementation attempt: put the counter back
        // so the resume after the reset does not consume the budget.
        task = {
          ...task,
          attempts: Math.max(0, task.attempts - 1),
        };
        await store.writeTask(task);
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `quota: builder paused — ${built.summary.slice(6).trim()} — this task resumes automatically after the limit-reset backoff; no owner input needed`,
          })
          .catch(() => {});
        return store.moveTask(taskId, "needs-input", now());
      }
      if (isBlockedReply(built.summary)) return store.moveTask(taskId, "needs-input", now());
      if (built.summary.startsWith("verification failed"))
        return store.moveTask(taskId, "needs-input", now());
      // The builder station itself did not complete (agent exit, timeout,
      // crash): pause resumably with the reason recorded, never terminally
      // Failed — the owner replies and the same station/session resumes.
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `builder station did not complete: ${built.summary || "no reply from the agent"} — reply to resume this task`,
        })
        .catch(() => {});
      return store.moveTask(taskId, "needs-input", now());
    }

    task = await store.moveTask(taskId, "in-review", now());
    const reviewProject = await store.readProject(task.projectId).catch(() => null);
    const critiques: string[] = [];
    // Fast lane earns a single review only while the actual diff still
    // matches the triage estimate. A diff that touches an expensive
    // path or grows past a small surface escalates the task back to
    // the standard lane (dual review) on the spot — the lane is earned
    // by the work, not just by the estimate.
    let reviewers: ReadonlyArray<
      readonly [
        string,
        "sme" | "coder",
        string,
      ]
    > = [
      [
        "sme",
        "sme",
        "a subject-matter expert",
      ],
      [
        "coder",
        "coder",
        "a code reviewer",
      ],
    ];
    if (task.lane === "fast") {
      const touchedFiles = worktreeActivity(task).map((a) => a.file);
      const expensive = touchedFiles.filter((f) =>
        EXPENSIVE_PATHS.some((e) => f.toLowerCase().includes(e)),
      );
      if (expensive.length || touchedFiles.length > 12) {
        task = {
          ...task,
          lane: "standard",
          triage: `${task.triage} | escalated at review: diff touches ${expensive.length ? `expensive path(s) ${expensive.join(", ")}` : `${touchedFiles.length} files`} — standard lane (dual review) applies`,
        };
        await store.writeTask(task);
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `triage escalation: the diff outgrew the fast-lane estimate (${expensive.length ? `expensive path(s): ${expensive.join(", ")}` : `${touchedFiles.length} files changed`}) — escalating to the standard lane with dual review; no owner input`,
          })
          .catch(() => {});
      } else {
        reviewers = [
          [
            "coder",
            "coder",
            "a code reviewer",
          ],
        ];
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: "triage fast lane: single (coder) review — the diff still matches the estimate",
          })
          .catch(() => {});
      }
    }
    // Reviewer payload diet: execution brief plus diff stat and the
    // touched-file list, instead of the full plan. Reviewers inspect
    // scoped hunks per file instead of re-reading an unbounded diff.
    const reviewTouched = worktreeActivity(task).map((a) => a.file);
    let reviewDiffStat = "";
    try {
      reviewDiffStat = git(task.worktree, `diff --stat ${task.baseCommit || "HEAD"}`).slice(
        0,
        2000,
      );
    } catch {
      /* stat is guidance only; reviewers can still inspect */
    }
    // Scripted, not opinionated: the diff's ADDED lines are scanned
    // statically for suppressions (disabled lints, type opt-outs, skipped or
    // focused tests), comment hygiene, and content findings (dead controls,
    // fabricated claims, marketing filler). A check no AI has to read files
    // for must not cost tokens; the reviewer confirms instead of hunting.
    // One diff read feeds all three, so the reports cannot disagree about
    // which line they are talking about.
    let suppressionReport = "(unavailable)";
    let commentReport = "(unavailable)";
    let contentReport = "(unavailable)";
    try {
      const reviewDiff = git(task.worktree, `diff ${task.baseCommit || "HEAD"}`);
      suppressionReport = formatSuppressionReport(addedSuppressionHits(reviewDiff));
      commentReport = formatCommentReport(addedCommentHits(reviewDiff));
      contentReport = formatContentReport(
        addedContentHits(reviewDiff, {
          runtimeWiring: runtimeWiringIn(task.worktree),
        }),
      );
    } catch {
      /* report is evidence, not a gate; the reviewer can still inspect */
    }
    for (const [id, role, label] of reviewers) {
      let reviewStable = `Task: ${task.prompt}\nPlan (execution brief):\n${executionBrief(task.plan)}\nFiles changed (${reviewTouched.length}): ${reviewTouched.slice(0, 30).join(", ") || "(none recorded)"}\nDiff stat:\n${reviewDiffStat || "(unavailable)"}${id === "sme" && reviewProject ? `\nYour persona for this project:\n${smePersona(reviewProject)}` : ""}${id === "coder" && reviewProject ? `\nYour persona for this project:\n${coderPersona(reviewProject)}` : ""}${reviewProject?.rules ? `\nProject rules: ${reviewProject.rules}` : ""}`;
      let reviewContextPackHit = false;
      try {
        let patterns = "";
        try {
          patterns = readFileSync(join(task.worktree, "PATTERNS.md"), "utf8");
        } catch {
          patterns = "";
        }
        const souls =
          id === "sme"
            ? reviewProject
              ? smePersona(reviewProject)
              : ""
            : reviewProject
              ? coderPersona(reviewProject)
              : "";
        const pack = await getContextPack(store, {
          role: "reviewer",
          taskId: task.id,
          task,
          project: reviewProject,
          plan: task.plan,
          decisions: "",
          patterns,
          souls,
          fileList: "",
          touchedFiles: reviewTouched,
          diffStat: reviewDiffStat,
        });
        reviewStable = pack.content;
        reviewContextPackHit = pack.hit;
      } catch {
        // keep inline fallback
      }
      const reviewerTask = `Review as ${label}. Reply first line PASS or REJECT. Then state your understanding of the intent and goal, and show your thoughts and arguments, one per line, each with its evidence from the diff.\n${reviewStable}\nSuppression report (added lines, auto-scanned):\n${suppressionReport}\nComment report (added lines, auto-scanned, advisory):\n${commentReport}\nContent report (added lines, auto-scanned; A = provable, B = confirm by reading):\n${contentReport}\nInspect the diff (git diff ${task.baseCommit || "HEAD"} -- <file> per changed file) and the success criteria.`;
      // The plan brief can describe the anti-patterns the work must defend
      // against ("skip the lint gate", "force-push", "--no-verify" ...).
      // Those lines are context, not a proposal, but the redteam regex gate
      // cannot tell the difference — so it vetoes a reviewer for reading its
      // own plan. Strip them here (like the builder card) so the reviewer is
      // never vetoed before it runs and never re-billed for the retry.
      const sanitized = sanitizeGateVeto(reviewerTask);
      if (sanitized.removed.length) {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `boundary gate: removed ${sanitized.removed.length} plan line(s) from the ${id} reviewer card (${[
              ...new Set(sanitized.removed),
            ].join("; ")}) before issuing it — the factory ruling replaces them`,
          })
          .catch(() => {});
      }
      let card: JobCard = {
        id,
        jobId: task.jobId,
        role,
        task: sanitized.text,
        worktree: task.worktree,
        constraints: [
          "different context from builder",
          "do not edit code; review only",
          "first line must be PASS or REJECT",
          "check the diff against PATTERNS.md at the worktree root when it exists (GoF alignment and type conventions); a violation is a REJECT reason",
          "every suppression in the suppression report must be confirmed intentional with a real reason; an unexplained one (?? marker) is a REJECT reason unless the diff itself shows why it must stay",
          "the comment report is evidence for PATTERNS.md, not a gate of its own: a comment that is false or that hides a suppression reason is a REJECT reason, decoration is a fix request",
          "in the content report a Band A finding (no target, no handler, and this repo attaches no behaviour at runtime) is provable; a Band B finding is a candidate, so confirm by searching the wiring (id, selector, delegation, ref, framework attribute) before calling a control dead",
        ],
        gates: [
          "redteam",
        ],
      };
      await store.writeCard(card);
      let reviewed = await runStation(card, {
        store,
        command: opts.command,
        providerCommands: opts.providerCommands,
        timeoutMs: opts.timeoutMs,
      });
      await store
        .saveDelivery(task.jobId, {
          ...reviewed,
          contextPackHit: reviewContextPackHit,
        })
        .catch(() => {});
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "agent",
          text: `${id}: ${(reviewed.detail || reviewed.summary).slice(0, 2000)}`,
        })
        .catch(() => {});
      // A reviewer station that dies (timeout, crash, locked session) is
      // retried once with a fresh session before it may block the task:
      // a transient station death is not a review verdict.
      if (reviewed.status !== "done") {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `reviewer station ${id} did not complete (${reviewed.summary || "no reply"}) — retrying once ${reviewed.status === "blocked" ? "with the boundary-gate lines removed" : "with a fresh session"}`,
          })
          .catch(() => {});
        if (reviewed.status === "blocked")
          card = {
            ...card,
            task: sanitizeGateVeto(card.task).text,
          };
        await store.setSession(task.jobId, id, null).catch(() => {});
        reviewed = await runStation(card, {
          store,
          command: opts.command,
          providerCommands: opts.providerCommands,
          timeoutMs: opts.timeoutMs,
        });
        await store
          .saveDelivery(task.jobId, {
            ...reviewed,
            contextPackHit: reviewContextPackHit,
          })
          .catch(() => {});
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "agent",
            text: `${id} (retry): ${(reviewed.detail || reviewed.summary).slice(0, 2000)}`,
          })
          .catch(() => {});
      }
      if (reviewed.status !== "done") {
        // A second station death is still infrastructure, not a verdict:
        // escalate to the strong model on a fresh session before the
        // task may block. Only a third failure blocks it.
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `reviewer station ${id} did not complete again (${reviewed.summary || "no reply"}) — escalating to the strong model with a fresh session; no owner input`,
          })
          .catch(() => {});
        await store.setSession(task.jobId, id, null).catch(() => {});
        reviewed = await runStation(card, {
          store,
          command: opts.command,
          providerCommands: opts.providerCommands,
          timeoutMs: opts.timeoutMs,
          model: "muse-wonder-1.0",
          effort: "high",
        });
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "agent",
            text: `${id} (escalated): ${(reviewed.detail || reviewed.summary).slice(0, 2000)}`,
          })
          .catch(() => {});
      }
      if (reviewed.status !== "done") return store.moveTask(taskId, "blocked", now());
      if (isBlockedReply(reviewed.summary)) return store.moveTask(taskId, "needs-input", now());
      if (verdictOf(reviewed.summary) === "reject")
        critiques.push(`${label}: ${reviewed.detail || reviewed.summary}`);
    }

    // Merge gate: the work must land on current main cleanly. A textual
    // conflict bounces to the builder like a reviewer critique. Decisions
    // files are special even when git merges them cleanly — decisions are
    // only added to and extended — so a merge that would change them waits
    // for the owner, with the diff and any already-stated lines to compress.
    if (reviewProject?.repoPath && task.worktree) {
      const merge = assessMergeability(reviewProject.repoPath, task);
      if (merge.status === "conflict") {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `merge check: CONFLICT with current main (${merge.currentHead.slice(0, 7)}) in ${merge.files.join(", ")} — sent back to the builder to resolve`,
          })
          .catch(() => {});
        critiques.push(
          `merge check: this work conflicts with current main (${merge.currentHead.slice(0, 7)}) in: ${merge.files.join(", ")}. Bring current main into your worktree, resolve every conflict keeping both intents, and re-verify before finishing.`,
        );
      } else if (merge.status === "clean" && merge.currentHead !== task.baseCommit) {
        const d = merge.decisions;
        if (
          !critiques.length &&
          d.taskChanged.length &&
          task.decisionsAckHead !== merge.currentHead
        ) {
          await store.writeTask({
            ...task,
            decisionsPendingHead: merge.currentHead,
          });
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `merge paused: merging this work into current main (${merge.currentHead.slice(0, 7)}) would change decisions file(s): ${d.taskChanged.join(", ")}.${d.mainChanged.length ? ` Main already changed: ${d.mainChanged.join(", ")} since this task was planned.` : ""} Decisions are only added to and extended — if anything here contradicts a recorded decision, say so; if it restates one, tell the builder to compress it.\n${d.duplicates.length ? `Already stated on main (compress, do not restate):\n${d.duplicates.map((l) => `- ${l}`).join("\n")}\n` : ""}What merging would change:\n${d.diff}\nReply to accept as-is, or instruct the builder (e.g. "compress the duplicates and proceed").`,
            })
            .catch(() => {});
          return store.moveTask(taskId, "needs-input", now());
        }
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `merge check: clean against current main (${merge.currentHead.slice(0, 7)})${d.taskChanged.length ? `; decisions change accepted for ${d.taskChanged.join(", ")}` : ""}`,
          })
          .catch(() => {});
      } else if (
        merge.status === "unknown" &&
        task.baseCommit &&
        task.baseCommit !== merge.currentHead
      ) {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `merge check: could not check against current main (${merge.reason}); the reviewers' verdict stands`,
          })
          .catch(() => {});
      }
    }

    // Tradeoff gate: work that touches an expensive path (schema, migration,
    // strategy, finance, server, endpoint, auth) needs a recorded tradeoff in
    // the plan. This is where the touched paths are concretely known, so the
    // gate runs here and parks the task for the owner when the plan did not
    // consider alternatives.
    if (!critiques.length && reviewProject?.repoPath && task.worktree) {
      const touched = worktreeActivity(task).map((a) => a.file);
      const tradeoff = tradeoffGate(touched, planHasTradeoff(task.plan));
      if (tradeoff.decision === "block") {
        // Recording a missing tradeoff is planner work, not an owner
        // question: the planner writes the options section against the
        // paths actually touched, it is appended to the plan, and the
        // pipeline proceeds. Only a planner that cannot produce a real
        // options section parks for the owner.
        const history = await store.listPrompts(taskId).catch(() => []);
        let recorded = false;
        if (!history.some((p) => p.text.includes("tradeoff auto-record"))) {
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `tradeoff gate: ${tradeoff.reasons.join("; ")} — sending it to the planner to record the tradeoff automatically; no owner input`,
            })
            .catch(() => {});
          const card: JobCard = {
            id: "tradeoff",
            jobId: task.jobId,
            role: "planner",
            task: `The finished work touches expensive path(s): ${touched.join(", ")}. The plan recorded no tradeoff. Write the missing plan section and reply with ONLY that section: start with a "## Tradeoffs" heading, then for the approach taken and at least one real alternative, give the option, its cost/benefit against these touched paths, and why the taken approach wins. Base it on the plan and diff (git diff ${task.baseCommit || "HEAD"}).\nPlan:\n${task.plan.slice(0, 3000)}`,
            worktree: task.worktree,
            constraints: [
              "plan only; do not implement",
              "reply with only the Tradeoffs section",
            ],
            gates: [],
          };
          await store.writeCard(card);
          const noted = await runStation(card, {
            store,
            command: opts.command,
            providerCommands: opts.providerCommands,
            timeoutMs: opts.timeoutMs,
          }).catch(() => null);
          const section = (noted?.detail || noted?.summary || "").trim();
          if (
            noted?.status === "done" &&
            /^##\s+(options|alternatives|trade-?offs?)\b/im.test(section) &&
            (section.match(/option|alternative/gi)?.length ?? 0) >= 2
          ) {
            task = {
              ...task,
              plan: `${task.plan}\n\n${section}`,
            };
            await store.writeTask(task);
            await store
              .appendPrompt(taskId, {
                at: now(),
                kind: "system",
                text: "tradeoff auto-record: the planner recorded the missing tradeoff in the plan; proceeding without owner input",
              })
              .catch(() => {});
            recorded = true;
          }
        }
        if (!recorded) {
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `tradeoff gate: ${tradeoff.reasons.join("; ")} — record a tradeoff (>=2 options) in the plan and reply to resume`,
            })
            .catch(() => {});
          return store.moveTask(taskId, "needs-input", now());
        }
      }
    }

    // Final verify gate: reviewers passing is not enough — the
    // project's checks must pass on the final worktree state (after
    // every review bounce and pickup) before this may be called done.
    // A task with no verify command inherits the CI-derived check
    // scripts; only a project with no runnable check at all may finish
    // on reviewer verdicts alone, and that is recorded, not silent.
    if (!critiques.length) {
      const finalVerify = effectiveVerifyCommand(task, reviewProject?.repoPath ?? "");
      if (finalVerify) {
        const checked = runVerify(
          {
            ...task,
            verifyCommand: finalVerify,
          },
          opts.timeoutMs,
          join(store.dir, "cache", "verify"),
        );
        if (!checked.ok) {
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `final verify failed (${finalVerify}): ${checked.out.slice(0, 600)} — sent back to the builder; this task is not done until the checks pass`,
            })
            .catch(() => {});
          critiques.push(
            `final verify failed (${finalVerify}): ${checked.out.slice(0, 800)}. Fix the failing checks and re-verify before finishing.`,
          );
        } else {
          if (!task.verifyCommand) {
            task = {
              ...task,
              verifyCommand: finalVerify,
            };
            await store.writeTask(task).catch(() => {});
          }
          const ci = reviewProject?.repoPath ? analyzeCi(reviewProject.repoPath) : null;
          const ciNote = ci?.workflows.length
            ? ` CI workflow(s) ${ci.workflows.map((w) => w.name).join(", ")} run on push/PR and were not run locally.`
            : "";
          await store
            .appendPrompt(taskId, {
              at: now(),
              kind: "system",
              text: `final verify passed (${finalVerify}) on the final worktree state.${ciNote}`,
            })
            .catch(() => {});
        }
      } else if (worktreeActivity(task).length) {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: "final verify: no verify command and no CI-derived check scripts exist for this project — finishing on reviewer verdicts only, with no test run. Set a verify command in Task details to gate future work.",
          })
          .catch(() => {});
      }
    }

    // Visual Review gate: screenshot diffs of new/affected pages must
    // be approved by the owner before this may land. Runs only when
    // reviewers and final verify passed; a bounce reuses the review loop.
    if (!critiques.length) {
      const visual = await runVisualStage(task, opts, now).catch(async (err) => {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          action: "park" as const,
          reason: `visual review failed: ${reason}`,
          task,
        };
      });
      task = (await store.readTask(taskId).catch(() => null)) ?? visual.task ?? task;
      if (visual.action === "bounce") {
        critiques.push(visual.reason);
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `visual review: sent back to the builder — ${visual.reason}`,
          })
          .catch(() => {});
      } else if (visual.action === "park") {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `visual review: ${visual.reason} — parked for the owner. Open Visual Review in the task, inspect Before / After / Diff per screenshot, then Approve (lands this work) or Request changes (sends your per-screenshot comments back to the builder). Screenshots are stored outside git (factory data), never committed.`,
          })
          .catch(() => {});
        return store.moveTask(taskId, "needs-input", now());
      } else if (task.visualState !== "skipped") {
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `visual review passed: ${visual.reason} — proceeding to land`,
          })
          .catch(() => {});
      }
    }

    if (!critiques.length) {
      const artifacts = await store.collectArtifacts(task).catch(() => [] as string[]);
      if (artifacts.length)
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `verification artifacts saved: ${artifacts.join(", ")}`,
          })
          .catch(() => {});
      await store.recordHistory(task, "done", now()).catch(() => {});
      // Commit & push the finished work before the slot is released,
      // then merge it into main when provably safe; a merge that needs
      // the owner parks the task instead of completing it.
      const landing = await landTaskWork(store, task, now, {
        agent: opts,
      });
      if (landing === "parked") return store.moveTask(taskId, "needs-input", now());
      if (landing === "held") return (await store.readTask(taskId)) ?? task;
      return store.moveTask(taskId, "done", now());
    }
    if (round === maxReviewRounds && !judgeEscalated) {
      // Deadlocked reviewers are escalated before the owner is asked: a
      // judge (planner role, strong model) reads the critiques and the
      // diff and either rules PROCEED (work is acceptable; builder makes
      // the judge's fixes in one more pass) or OWNER (a genuine call
      // only the owner can make). Anything unclear parks as before.
      judgeEscalated = true;
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `review did not converge after ${maxReviewRounds + 1} rounds — escalating to a judge before asking the owner; no owner input yet`,
        })
        .catch(() => {});
      const card: JobCard = {
        id: "judge",
        jobId: task.jobId,
        role: "planner",
        task: `Judge a deadlocked review. Reply first line exactly PROCEED or OWNER, then your ruling in a few lines. PROCEED means the work is acceptable despite the critiques: name the concrete fixes the builder must still make. OWNER means the deadlock is a genuine product/business call only the owner can settle: name that one question.\nTask: ${task.prompt}\nPlan: ${task.plan.slice(0, 2000)}\nDeadlocked critiques:\n${critiques.join("\n")}\nInspect the diff (git diff ${task.baseCommit || "HEAD"}).`,
        worktree: task.worktree,
        constraints: [
          "judge only; do not implement",
          "first line must be PROCEED or OWNER",
        ],
        gates: [],
      };
      await store.writeCard(card);
      const judged = await runStation(card, {
        store,
        command: opts.command,
        providerCommands: opts.providerCommands,
        timeoutMs: opts.timeoutMs,
      }).catch(() => null);
      const ruling = (judged?.detail || judged?.summary || "").trim();
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "agent",
          text: `judge: ${ruling.slice(0, 2000)}`,
        })
        .catch(() => {});
      if (judged?.status === "done" && /^PROCEED\b/i.test(ruling)) {
        instruction = `A judge reviewed the deadlocked reviewer critiques and ruled PROCEED. Apply the judge's fixes and finish:\n${ruling}`;
        task = await store.moveTask(taskId, "running", now());
        // One more builder pass under the ruling, not a fresh deadlock.
        const built = await builderLoop(task, instruction, opts);
        if (built.ok)
          return store.moveTask(taskId, "in-review", now()).then(async (t) => {
            await store
              .appendPrompt(taskId, {
                at: now(),
                kind: "system",
                text: "judge-ruled builder pass finished; the work proceeds on the judge's ruling — reviewers do not re-litigate settled critiques",
              })
              .catch(() => {});
            return t;
          });
        await store
          .appendPrompt(taskId, {
            at: now(),
            kind: "system",
            text: `judge-ruled builder pass did not finish: ${built.summary}`,
          })
          .catch(() => {});
        return store.moveTask(taskId, "needs-input", now());
      }
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `review did not converge after ${maxReviewRounds + 1} rounds, and the judge did not clear it: ${critiques.join(" | ")}`,
        })
        .catch(() => {});
      return store.moveTask(taskId, "needs-input", now());
    }
    if (round === maxReviewRounds) {
      await store
        .appendPrompt(taskId, {
          at: now(),
          kind: "system",
          text: `review did not converge after ${maxReviewRounds + 1} rounds: ${critiques.join(" | ")}`,
        })
        .catch(() => {});
      return store.moveTask(taskId, "needs-input", now());
    }
    instruction = `Reviewer conflicts to resolve:\n${critiques.join("\n")}`;
    task = await store.moveTask(taskId, "running", now());
  }
  return store.moveTask(taskId, "needs-input", now());
}

/** Task pipeline: runs the inner pipeline, then returns its warm slot. */
export async function runTaskPipeline(taskId: string, opts: PipelineOptions): Promise<Task> {
  try {
    return await runTaskPipelineInner(taskId, opts);
  } finally {
    const task = await opts.store.readTask(taskId).catch(() => null);
    if (task) releaseWorktree(task);
  }
}

/**
 * Persist a finished task's work before its worktree slot is released
 * (release resets the slot, so afterwards the work would only exist as a
 * diff snapshot): commit everything in the worktree on a `task/<id>`
 * branch and push that branch. Best-effort by design — a failed push is
 * recorded on the task, never fails it. Merging the branch into main
 * stays a deliberate step; the merge gate has already proven it lands.
 */
export type CommitAndPushOutcome =
  | {
      status: "nothing";
      secretFiles: string[];
    }
  | {
      status: "pushed";
      branch: string;
      commit: string;
      secretFiles: string[];
    }
  | {
      status: "local";
      branch: string;
      commit: string;
      secretFiles: string[];
    }
  | {
      status: "committed-locally";
      branch: string;
      commit: string;
      pushError: string;
      secretFiles: string[];
    }
  | {
      status: "failed";
      reason: string;
      secretFiles: string[];
    };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export async function commitAndPushTaskWork(
  store: FactoryStore,
  task: Task,
  now: () => string,
): Promise<CommitAndPushOutcome> {
  let secretFiles: string[] = [];
  try {
    const project = await store.readProject(task.projectId).catch(() => null);
    if (!project?.repoPath)
      return {
        status: "failed",
        reason: "project has no local repo path",
        secretFiles,
      };
    const repo = realpathSync(project.repoPath);
    const branch = `task/${task.id}`;
    if (!task.worktree || !existsSync(task.worktree) || !worktreeLeasedByTask(task)) {
      const commit = persistedBranchCommit(repo, task);
      if (!commit)
        return {
          status: "nothing",
          secretFiles,
        };
      if (!gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
        git(repo, `branch -f ${branch} ${commit}`);
      if (!hasOrigin(repo)) {
        await updatePending(store, task, {
          branchPushPending: null,
        });
        return {
          status: "local",
          branch,
          commit,
          secretFiles,
        };
      }
      try {
        execSync(`git push origin ${branch}`, {
          cwd: repo,
          encoding: "utf8",
          timeout: 120_000,
          env: pushEnv(),
        });
        await updatePending(store, task, {
          branchPushPending: null,
        });
        return {
          status: "pushed",
          branch,
          commit,
          secretFiles,
        };
      } catch (err) {
        const pushError = errLine(err);
        await updatePending(store, task, {
          branchPushPending: {
            targetRef: branch,
            commit,
            attempts: 1,
            lastError: pushError,
            nextRetryAt: nextRetryIso(now, 1),
          },
        });
        return {
          status: "committed-locally",
          branch,
          commit,
          pushError,
          secretFiles,
        };
      }
    }
    const status = execSync("git status --porcelain", {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const head = git(task.worktree, "rev-parse HEAD");
    const base = task.baseCommit || head;
    if (!status && head === base)
      return {
        status: "nothing",
        secretFiles,
      };
    if (status) {
      const dirty = listDirtyFiles(task.worktree);
      secretFiles = dirty.filter(isSecretLikeFile);
      const safe = dirty.filter((f) => !isSecretLikeFile(f));
      if (safe.length) {
        execFileSync(
          "git",
          [
            "add",
            "-A",
            "--",
            ...safe,
          ],
          {
            cwd: task.worktree,
            timeout: 30_000,
          },
        );
        execSync(
          `git -c user.name="Agent Factory" -c user.email="factory@localhost" commit -q -m "task ${task.id}: ${task.title.slice(0, 72)}"`,
          {
            cwd: task.worktree,
            encoding: "utf8",
            timeout: 60_000,
          },
        );
      } else if (!safe.length && head === base) {
        return {
          status: "nothing",
          secretFiles,
        };
      }
    }
    const commit = git(task.worktree, "rev-parse HEAD");
    if (commit === base && !status)
      return {
        status: "nothing",
        secretFiles,
      };
    const onBranch = gitOk(task.worktree, `symbolic-ref -q HEAD refs/heads/${branch}`);
    if (!onBranch) git(repo, `branch -f ${branch} ${commit}`);
    else if (!gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
      git(repo, `branch -f ${branch} ${commit}`);
    if (!hasOrigin(repo)) {
      await updatePending(store, task, {
        branchPushPending: null,
      });
      return {
        status: "local",
        branch,
        commit,
        secretFiles,
      };
    }
    try {
      execSync(`git push origin ${branch}`, {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: pushEnv(),
      });
      await updatePending(store, task, {
        branchPushPending: null,
      });
      return {
        status: "pushed",
        branch,
        commit,
        secretFiles,
      };
    } catch (err) {
      const pushError = errLine(err);
      await updatePending(store, task, {
        branchPushPending: {
          targetRef: branch,
          commit,
          attempts: 1,
          lastError: pushError,
          nextRetryAt: nextRetryIso(now, 1),
        },
      });
      return {
        status: "committed-locally",
        branch,
        commit,
        pushError,
        secretFiles,
      };
    }
  } catch (err) {
    return {
      status: "failed",
      reason: errLine(err),
      secretFiles,
    };
  }
}

/**
 * Auto-merge a finished task's branch into the project's main, in the
 * owner's own checkout — but only when that is provably safe: main is
 * the checked-out branch, the checkout is clean (never merge under the
 * owner's uncommitted work), the merge gate is still clean against
 * current main, and the merge would not change decisions files beyond
 * what was already accepted. Otherwise, whenever `main` exists, the
 * same merge first runs in a detached temporary worktree. If no
 * checkout tracks `main`, only the local `main` ref is moved to the
 * merge commit (compare-and-swap), so no index or working tree can be
 * desynchronised. If a checkout does track `main` — including the
 * owner's checkout on a dirty `main` — the merge commit is instead
 * brought in there with `git merge --ff-only`: git itself updates
 * that checkout's index and working tree, preserves uncommitted work
 * that the merge does not touch, and refuses, leaving everything
 * untouched, when local work would be overwritten (that case parks).
 * The owner's work is never stashed, committed, or reset. Regular
 * push only, never force; a merge is one `git revert` away from
 * undone. Anything else parks the task for the owner with the branch
 * already pushed and safe.
 */
export type MergeOutcome =
  | {
      status: "merged-pushed";
      mergeCommit: string;
    }
  | {
      status: "merged-local";
      mergeCommit: string;
    }
  | {
      status: "merged-locally";
      mergeCommit: string;
      mainPushError: string;
    }
  | {
      status: "already-merged";
      mergeCommit: string;
      noRemote?: boolean;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "parked";
      parkKind: "conflict" | "decisions" | "other";
      reason: string;
      files?: string[];
      resolution?: string;
    }
  | {
      status: "nothing";
    }
  | {
      status: "failed";
      reason: string;
    };

/**
 * Decisions files the task branch introduces relative to its base, read
 * from the in-progress merge in `worktree` (HEAD is the main side,
 * MERGE_HEAD the task side). Best-effort: an unreadable comparison
 * returns no files and the post-resolution re-check below is the proof.
 */
function taskBranchDecisions(worktree: string, fresh: Task, branch: string): string[] {
  try {
    const branchHead = gitOk(worktree, "rev-parse -q --verify MERGE_HEAD")
      ? git(worktree, "rev-parse MERGE_HEAD")
      : git(worktree, `rev-parse ${branch}`);
    const mainHead = git(worktree, "rev-parse HEAD");
    let base = fresh.baseCommit ?? "";
    if (!base || !gitOk(worktree, `merge-base --is-ancestor ${base} ${branchHead}`))
      base = git(worktree, `merge-base ${mainHead} ${branchHead}`);
    if (!base) return [];
    return git(worktree, `diff --name-only ${base} ${branchHead}`)
      .split("\n")
      .filter(Boolean)
      .filter(isDecisionsFile);
  } catch {
    return [];
  }
}

/**
 * Decisions files an agent-resolved merge would actually land, relative
 * to its first parent (pre-merge main). Null when it cannot be proven —
 * the caller fails closed rather than landing an unchecked merge.
 */
function mergedDecisionsChange(worktree: string): string[] | null {
  try {
    return git(worktree, "diff --name-only HEAD^1 HEAD")
      .split("\n")
      .filter(Boolean)
      .filter(isDecisionsFile);
  } catch {
    return null;
  }
}

/** Introduced decisions files the owner has not acknowledged at main. */
function unackedIntroducedDecisions(worktree: string, fresh: Task, branch: string): string[] {
  const introduced = taskBranchDecisions(worktree, fresh, branch);
  if (!introduced.length) return [];
  try {
    return fresh.decisionsAckHead === git(worktree, "rev-parse HEAD") ? [] : introduced;
  } catch {
    return introduced;
  }
}

/** Landed decisions files the owner has not acknowledged; null unprovable. */
function unackedLandedDecisions(worktree: string, fresh: Task): string[] | null {
  const landed = mergedDecisionsChange(worktree);
  if (landed === null || !landed.length) return landed;
  try {
    return fresh.decisionsAckHead === git(worktree, "rev-parse HEAD^1") ? [] : landed;
  } catch {
    return landed;
  }
}

/**
 * Settle a conflicted merge attempt whose merge is still in progress in
 * `worktree`. With a resolver agent, the agent resolves the live conflict
 * and success returns so the caller can land the merge commit. Without
 * one — or when the agent fails — the merge is aborted and the caller
 * parks the task with the conflict (and the failed attempt) intact.
 *
 * The owner decisions gate is re-checked here, status-independent of
 * the caller's mergeability prediction: an unacknowledged decisions
 * change parks for the owner before any agent is spawned, and again
 * after resolution before the merge may land — a resolver agent must
 * never land a decisions change the owner has not acknowledged.
 */
async function settleMergeConflict(
  store: FactoryStore,
  fresh: Task,
  now: () => string,
  branch: string,
  worktree: string,
  files: string[],
  agent: PipelineOptions | undefined,
  abort: () => string | void,
): Promise<
  | {
      status: "resolved";
    }
  | {
      status: "parked";
      outcome: Extract<
        MergeOutcome,
        {
          status: "parked";
        }
      >;
    }
> {
  type Parked = Extract<
    MergeOutcome,
    {
      status: "parked";
    }
  >;
  const parked = (resolution?: string): Parked => ({
    status: "parked",
    parkKind: "conflict",
    reason: `merge conflict in ${files.join(", ")}`,
    files,
    ...(resolution
      ? {
          resolution,
        }
      : {}),
  });
  const abortNote = () => {
    const problem = abort() ?? "";
    return problem
      ? `; restoring the pre-merge state failed: ${problem} — check main before resuming`
      : "";
  };
  const decisionsParked = (decisionsFiles: string[], resolution?: string): Parked => ({
    status: "parked",
    parkKind: "decisions",
    reason: `decisions change in ${decisionsFiles.join(", ")}`,
    files: decisionsFiles,
    ...(resolution
      ? {
          resolution,
        }
      : {}),
  });
  // Owner gate before any agent is spawned, independent of how the
  // caller predicted this merge: an unacknowledged decisions change
  // on the task branch parks here and the resolver never runs.
  const introduced = unackedIntroducedDecisions(worktree, fresh, branch);
  if (introduced.length) {
    abort();
    return {
      status: "parked",
      outcome: decisionsParked(introduced),
    };
  }
  if (!agent) {
    abort();
    return {
      status: "parked",
      outcome: parked(),
    };
  }
  const resolved = await resolveMergeWithAgent(fresh, branch, worktree, files, agent);
  if (!resolved.ok)
    return {
      status: "parked",
      outcome: parked(`automatic agent resolution failed: ${resolved.reason}${abortNote()}`),
    };
  // Re-check the owner decisions gate on the resolved merge itself
  // before it may land: whatever the prediction said, a decisions
  // change the owner has not acknowledged at pre-merge main never
  // lands via the resolver. Unprovable also fails closed.
  const landedDecisions = unackedLandedDecisions(worktree, fresh);
  if (landedDecisions === null)
    return {
      status: "parked",
      outcome: parked(
        `agent resolved the merge but its decisions change could not be re-checked${abortNote() || "; the pre-merge main was restored"}`,
      ),
    };
  if (landedDecisions.length)
    return {
      status: "parked",
      outcome: decisionsParked(
        landedDecisions,
        `agent resolved the merge but it lands an unacknowledged decisions change${abortNote() || "; the pre-merge main was restored"}`,
      ),
    };
  // The agent-resolved merge was never reviewed or verified in this
  // form: re-run the project's verify gate on the merged tree before
  // it may land. No verify command means nothing to re-run.
  const project = await agent.store.readProject(fresh.projectId).catch(() => null);
  const verifyCmd = effectiveVerifyCommand(
    {
      ...fresh,
      worktree,
    },
    project?.repoPath ?? "",
  );
  if (verifyCmd) {
    const checked = runVerify(
      {
        ...fresh,
        worktree,
        verifyCommand: verifyCmd,
      },
      agent.timeoutMs,
    );
    if (!checked.ok)
      return {
        status: "parked",
        outcome: parked(
          `agent resolved the merge but the merged tree failed verify (${verifyCmd}): ${checked.out.slice(0, 400)}${abortNote() || "; the pre-merge main was restored"}`,
        ),
      };
  }
  await store
    .appendPrompt(fresh.id, {
      at: now(),
      kind: "system",
      text: verifyCmd
        ? `merge conflict in ${files.join(", ")} — a fixer agent resolved it automatically; mechanical merge checks and verify (${verifyCmd}) passed on the merged tree`
        : `merge conflict in ${files.join(", ")} — a fixer agent resolved it automatically; mechanical merge checks passed, no verify command exists to re-run`,
    })
    .catch(() => {});
  return {
    status: "resolved",
  };
}

/** Restore the exact pre-merge HEAD in the project checkout; "" on proof. */
function restorePreMergeMain(repo: string, preMergeHead: string): string {
  try {
    if (mergeInProgress(repo))
      execSync("git merge --abort", {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      });
  } catch {
    /* the reset below is the fallback */
  }
  try {
    if (git(repo, "rev-parse HEAD") !== preMergeHead) git(repo, `reset --hard -q ${preMergeHead}`);
    if (mergeInProgress(repo)) return "a merge is still in progress";
    if (git(repo, "rev-parse HEAD") !== preMergeHead)
      return `HEAD is ${git(repo, "rev-parse HEAD").slice(0, 7)}, expected ${preMergeHead.slice(0, 7)}`;
    if (git(repo, "status --porcelain --untracked-files=no").trim())
      return "tracked worktree is not clean";
    return "";
  } catch (err) {
    return errLine(err);
  }
}

/**
 * Merge a finished task's branch into `main` from a detached temporary
 * worktree. The merge commit is then landed without ever moving a
 * checked-out branch ref behind its index: when `mainWorktree` (the
 * checkout tracking `main`, if any) is set, git fast-forwards that
 * checkout itself; otherwise the local `main` ref is moved by
 * compare-and-swap. The merge itself matches the in-place one
 * (`--no-ff`, same message shape). Detached is mandatory — git refuses
 * the same branch in two worktrees.
 */
function mainWorktreePath(repo: string): string | null {
  try {
    for (const block of git(repo, "worktree list --porcelain").split("\n\n")) {
      const lines = block.split("\n");
      if (!lines.includes("branch refs/heads/main")) continue;
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      if (wtLine) return wtLine.slice("worktree ".length);
    }
  } catch {
    /* fall through */
  }
  return null;
}
function removeIsolatedWorktree(repo: string, scratch: string, wt: string): void {
  try {
    execFileSync(
      "git",
      [
        "worktree",
        "remove",
        "--force",
        wt,
      ],
      {
        cwd: repo,
        timeout: 60_000,
      },
    );
  } catch {
    /* ignore */
  }
  try {
    rmSync(scratch, {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Record and push an isolated merge result: the local merge supersedes
 * the branch push obligation, and `main` is pushed regularly (never
 * forced), queuing a main-push retry on failure — mirroring the
 * in-place merge tail.
 */
async function pushIsolatedMain(
  store: FactoryStore,
  fresh: Task,
  now: () => string,
  repo: string,
  mergeCommit: string,
): Promise<MergeOutcome> {
  // Supersession: local merge supersedes the branch push obligation.
  await updatePending(store, fresh, {
    branchPushPending: null,
  });
  if (!hasOrigin(repo)) {
    await updatePending(store, fresh, {
      branchPushPending: null,
      mainPushPending: null,
    });
    return {
      status: "merged-local",
      mergeCommit,
    };
  }
  try {
    execSync("git push origin main", {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env: pushEnv(),
    });
    await updatePending(store, fresh, {
      branchPushPending: null,
      mainPushPending: null,
    });
    return {
      status: "merged-pushed",
      mergeCommit,
    };
  } catch (err) {
    const mainPushError = errLine(err);
    await updatePending(store, fresh, {
      branchPushPending: null,
      mainPushPending: {
        targetRef: "main",
        commit: mergeCommit,
        attempts: 1,
        lastError: mainPushError,
        nextRetryAt: nextRetryIso(now, 1),
      },
    });
    return {
      status: "merged-locally",
      mergeCommit,
      mainPushError,
    };
  }
}

/**
 * Land an isolated merge commit on `main`; returns an outcome when
 * landing could not proceed, or null once `main` points at it. Never
 * moves a checked-out branch ref directly: a checkout tracking `main`
 * is fast-forwarded by git itself (refusing, untouched, when local
 * work would be overwritten); otherwise the ref moves by CAS.
 */
function advanceIsolatedMain(
  repo: string,
  branch: string,
  mainHead: string,
  mergeCommit: string,
  mainWorktree: string | null,
): MergeOutcome | null {
  if (mainWorktree) {
    if (git(repo, "rev-parse refs/heads/main") !== mainHead) {
      return {
        status: "failed",
        reason: "main moved during the isolated merge — retry landing",
      };
    }
    try {
      execFileSync(
        "git",
        [
          "merge",
          "--ff-only",
          "-q",
          mergeCommit,
        ],
        {
          cwd: mainWorktree,
          timeout: 120_000,
        },
      );
    } catch {
      try {
        if (git(repo, "rev-parse refs/heads/main") !== mainHead) {
          return {
            status: "failed",
            reason: "main moved during the isolated merge — retry landing",
          };
        }
      } catch {
        /* fall through to parked */
      }
      return {
        status: "parked",
        parkKind: "other",
        reason: `landing into the checked-out main would overwrite uncommitted work — merge it when that work is committed or moved (git merge ${branch})`,
      };
    }
    return null;
  }
  try {
    execFileSync(
      "git",
      [
        "update-ref",
        "refs/heads/main",
        mergeCommit,
        mainHead,
      ],
      {
        cwd: repo,
        timeout: 30_000,
      },
    );
  } catch {
    return {
      status: "failed",
      reason: "main moved during the isolated merge — retry landing",
    };
  }
  return null;
}

async function mergeTaskBranchIsolated(
  store: FactoryStore,
  fresh: Task,
  now: () => string,
  repo: string,
  branch: string,
  mainWorktree: string | null,
  agent?: PipelineOptions,
): Promise<MergeOutcome> {
  const mainHead = git(repo, "rev-parse refs/heads/main");
  const sanitized = fresh.id.replace(/[^A-Za-z0-9_-]/g, "-");
  const scratch = mkdtempSync(join(tmpdir(), `factory-land-${sanitized}-`));
  const wt = join(scratch, "wt");
  const cleanup = () => removeIsolatedWorktree(repo, scratch, wt);
  try {
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "--detach",
        wt,
        mainHead,
      ],
      {
        cwd: repo,
        timeout: 60_000,
      },
    );
  } catch (err) {
    cleanup();
    return {
      status: "failed",
      reason: errLine(err),
    };
  }
  try {
    const message = `merge ${branch}: ${fresh.title.replace(/[\r\n]+/g, " ").slice(0, 72)}`;
    try {
      execFileSync(
        "git",
        [
          "merge",
          "--no-ff",
          "-q",
          branch,
          "-m",
          message,
        ],
        {
          cwd: wt,
          timeout: 120_000,
        },
      );
    } catch {
      let conflicted = "";
      try {
        conflicted = execFileSync(
          "git",
          [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ],
          {
            cwd: wt,
            encoding: "utf8",
            timeout: 30_000,
          },
        ).trim();
      } catch {
        /* ignore */
      }
      const files = conflicted
        ? conflicted.split("\n").filter(Boolean)
        : [
            "unknown files",
          ];
      // The merge is still in progress: the agent resolves the live
      // conflict, and only an abort parks the task.
      const settled = await settleMergeConflict(store, fresh, now, branch, wt, files, agent, () => {
        try {
          execFileSync(
            "git",
            [
              "merge",
              "--abort",
            ],
            {
              cwd: wt,
              timeout: 30_000,
            },
          );
        } catch {
          /* ignore */
        }
      });
      if (settled.status === "parked") return settled.outcome;
    }
    const mergeCommit = git(wt, "rev-parse HEAD");
    const advance = advanceIsolatedMain(repo, branch, mainHead, mergeCommit, mainWorktree);
    if (advance) return advance;
    return await pushIsolatedMain(store, fresh, now, repo, mergeCommit);
  } finally {
    cleanup();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export async function mergeTaskIntoMain(
  store: FactoryStore,
  task: Task,
  now: () => string,
  commitOutcome?: CommitAndPushOutcome,
  opts?: {
    forceRef?: boolean;
    agent?: PipelineOptions;
  },
): Promise<MergeOutcome> {
  try {
    const project = await store.readProject(task.projectId).catch(() => null);
    if (!project?.repoPath)
      return {
        status: "skipped",
        reason: "project has no local repo path — merge the pushed branch manually",
      };
    const repo = realpathSync(project.repoPath);
    const branch = `task/${task.id}`;
    const fresh = (await store.readTask(task.id).catch(() => null)) ?? task;
    let commit =
      commitOutcome &&
      (commitOutcome.status === "pushed" ||
        commitOutcome.status === "local" ||
        commitOutcome.status === "committed-locally")
        ? commitOutcome.commit
        : persistedBranchCommit(repo, fresh);
    if (commit && fresh.baseCommit && commit === fresh.baseCommit)
      return {
        status: "nothing",
      };
    // Self-heal a missing ref lease-safely.
    if (!gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`)) {
      if (!commit && worktreeLeasedByTask(fresh) && fresh.worktree && worktreeAheadOfBase(fresh)) {
        try {
          commit = git(fresh.worktree, "rev-parse HEAD");
        } catch {
          commit = "";
        }
      }
      if (!commit)
        return {
          status: "nothing",
        };
      git(repo, `branch -f ${branch} ${commit}`);
    } else if (!commit) {
      commit = refCommit(repo, fresh);
    }
    // Already merged into local main?
    if (
      gitOk(repo, `rev-parse --verify -q refs/heads/main`) &&
      gitOk(repo, `merge-base --is-ancestor ${branch} main`)
    ) {
      const mergeCommit = git(repo, "rev-parse main");
      await updatePending(store, fresh, {
        branchPushPending: null,
      });
      const onMain = (() => {
        try {
          return git(repo, "symbolic-ref -q HEAD") === "refs/heads/main";
        } catch {
          return false;
        }
      })();
      const clean = !execSync("git status --porcelain --untracked-files=no", {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
      if (onMain && clean) {
        if (!hasOrigin(repo)) {
          await updatePending(store, fresh, {
            branchPushPending: null,
            mainPushPending: null,
          });
          return {
            status: "already-merged",
            mergeCommit,
            noRemote: true,
          };
        }
        try {
          execSync("git push origin main", {
            cwd: repo,
            encoding: "utf8",
            timeout: 120_000,
            env: pushEnv(),
          });
          await updatePending(store, fresh, {
            branchPushPending: null,
            mainPushPending: null,
          });
          return {
            status: "already-merged",
            mergeCommit,
          };
        } catch (err) {
          const mainPushError = errLine(err);
          const cur = (await store.readTask(task.id).catch(() => null)) ?? fresh;
          if (!cur.mainPushPending)
            await updatePending(store, fresh, {
              mainPushPending: {
                targetRef: "main",
                commit: mergeCommit,
                attempts: 1,
                lastError: mainPushError,
                nextRetryAt: nextRetryIso(now, 1),
              },
            });
          else
            await updatePending(store, fresh, {
              branchPushPending: null,
            });
          // If a main push was already owed, caller/sweep knows; report merged-locally only when newly owed? Keep already-merged when pre-existing pending.
          return cur.mainPushPending
            ? {
                status: "already-merged",
                mergeCommit,
              }
            : {
                status: "merged-locally",
                mergeCommit,
                mainPushError,
              };
        }
      }
      if (!hasOrigin(repo)) {
        await updatePending(store, fresh, {
          branchPushPending: null,
          mainPushPending: null,
        });
        return {
          status: "already-merged",
          mergeCommit,
          noRemote: true,
        };
      }
      // Checkout cannot push now; only claim pushed when remote main already matches.
      if (remoteRefCommit(repo, "main") === mergeCommit) {
        await updatePending(store, fresh, {
          branchPushPending: null,
          mainPushPending: null,
        });
        return {
          status: "already-merged",
          mergeCommit,
        };
      }
      const cur2 = (await store.readTask(task.id).catch(() => null)) ?? fresh;
      if (!cur2.mainPushPending) {
        const mainPushError = "main push not attempted — project checkout is not on a clean main";
        await updatePending(store, fresh, {
          mainPushPending: {
            targetRef: "main",
            commit: mergeCommit,
            attempts: 1,
            lastError: mainPushError,
            nextRetryAt: nextRetryIso(now, 1),
          },
        });
        return {
          status: "merged-locally",
          mergeCommit,
          mainPushError,
        };
      }
      return {
        status: "already-merged",
        mergeCommit,
      };
    }
    const forceRef = !!opts?.forceRef;
    const onMain = (() => {
      try {
        return git(repo, "symbolic-ref -q HEAD") === "refs/heads/main";
      } catch {
        return false;
      }
    })();
    const clean = !execSync("git status --porcelain --untracked-files=no", {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const mainExists = gitOk(repo, "rev-parse --verify -q refs/heads/main");
    // The isolated path serves every checkout that cannot merge in
    // place (not on `main`, or on a dirty `main`) as long as `main`
    // exists; how the merge commit is landed — ref CAS versus a
    // git-driven fast-forward of the checkout tracking `main` — is
    // decided inside from where `main` is checked out, if anywhere.
    const mainWt = mainExists ? mainWorktreePath(repo) : null;
    const isolated = (!onMain || !clean) && mainExists;
    const mergeCheck = assessMergeability(repo, fresh, {
      expectedCommit: commit,
      forceRef,
      ...(isolated
        ? {
            againstCommit: git(repo, "rev-parse refs/heads/main"),
          }
        : {}),
    });
    // Decisions gate is status-independent and runs before any merge
    // attempt in both the in-place and isolated paths below: an
    // unacknowledged decisions change parks for the owner even when the
    // merge also conflicts — a resolver agent must never land it.
    if (
      mergeCheck.status !== "unknown" &&
      mergeCheck.decisions.taskChanged.length &&
      fresh.decisionsAckHead !== mergeCheck.currentHead
    ) {
      return {
        status: "parked",
        parkKind: "decisions",
        reason: `decisions change in ${mergeCheck.decisions.taskChanged.join(", ")}`,
        files: mergeCheck.decisions.taskChanged,
      };
    }
    // With a resolver agent available, a predicted conflict is not parked:
    // the real merge below is attempted and the agent resolves the live
    // conflict. Without one, park before touching the tree.
    if (mergeCheck.status === "conflict" && !opts?.agent) {
      return {
        status: "parked",
        parkKind: "conflict",
        reason: `merge conflict in ${mergeCheck.files.join(", ") || "unknown files"}`,
        files: mergeCheck.files.length
          ? mergeCheck.files
          : [
              "unknown files",
            ],
      };
    }
    if (!onMain || !clean) {
      if (!isolated) {
        return {
          status: "skipped",
          reason: `the project checkout is ${!onMain ? "not on main" : "dirty with uncommitted work"} — merge it when the checkout is clean (git merge ${branch})`,
        };
      }
      return await mergeTaskBranchIsolated(store, fresh, now, repo, branch, mainWt, opts?.agent);
    }
    const preMergeHead = git(repo, "rev-parse HEAD");
    try {
      execSync(`git merge --no-ff -q ${branch} -m "merge ${branch}: ${fresh.title.slice(0, 72)}"`, {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
      });
    } catch {
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
      const files = conflicted
        ? conflicted.split("\n").filter(Boolean)
        : [
            "unknown files",
          ];
      // The merge is still in progress: the agent resolves the live
      // conflict, and only an abort parks the task.
      const settled = await settleMergeConflict(
        store,
        fresh,
        now,
        branch,
        repo,
        files,
        opts?.agent,
        () => restorePreMergeMain(repo, preMergeHead),
      );
      if (settled.status === "parked") return settled.outcome;
    }
    const mergeCommit = git(repo, "rev-parse HEAD");
    // Supersession: local merge supersedes the branch push obligation.
    await updatePending(store, fresh, {
      branchPushPending: null,
    });
    if (!hasOrigin(repo)) {
      await updatePending(store, fresh, {
        branchPushPending: null,
        mainPushPending: null,
      });
      return {
        status: "merged-local",
        mergeCommit,
      };
    }
    try {
      execSync("git push origin main", {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: pushEnv(),
      });
      await updatePending(store, fresh, {
        branchPushPending: null,
        mainPushPending: null,
      });
      return {
        status: "merged-pushed",
        mergeCommit,
      };
    } catch (err) {
      const mainPushError = errLine(err);
      await updatePending(store, fresh, {
        branchPushPending: null,
        mainPushPending: {
          targetRef: "main",
          commit: mergeCommit,
          attempts: 1,
          lastError: mainPushError,
          nextRetryAt: nextRetryIso(now, 1),
        },
      });
      return {
        status: "merged-locally",
        mergeCommit,
        mainPushError,
      };
    }
  } catch (err) {
    return {
      status: "failed",
      reason: errLine(err),
    };
  }
}

const secretSuffix = (files: string[]) =>
  files.length
    ? `; left secret-like file(s) uncommitted, they are never auto-saved: ${files.join(", ")}`
    : "";

export interface FinalizeOutcome {
  status: "finalized" | "kept";
  detail: string;
}

/** Snapshot the diff for reviewability. Best-effort: cleanup still proceeds. */
function snapshotDiffForFinalize(task: Task): void {
  // A stale record may point at a slot since leased by another task:
  // never snapshot (or touch) a worktree this task does not hold.
  if (!task.worktree || !existsSync(task.worktree) || !worktreeLeasedByTask(task)) return;
  try {
    const snapshot = taskDiff(task);
    if (snapshot) {
      mkdirSync(join(dirname(task.worktree), "diffs"), {
        recursive: true,
      });
      writeFileSync(diffSnapshotPath(task), snapshot);
    }
  } catch {
    // reviewability is best-effort; cleanup still proceeds
  }
}

function mergeInProgress(worktree: string): boolean {
  try {
    const p = git(worktree, "rev-parse --git-path MERGE_HEAD").trim();
    return existsSync(p.startsWith("/") ? p : join(worktree, p));
  } catch {
    return true;
  }
}

function deleteFinalizedBranch(
  repo: string,
  branch: string,
): {
  ok: boolean;
  remoteNote: string;
} {
  // Only called after the branch itself was proven an ancestor of main.
  // A failed local -d blocks the remote delete: never force-delete a
  // remote branch whose local proof could not be acted on.
  try {
    git(repo, `branch -d ${branch}`);
  } catch {
    if (gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
      return {
        ok: false,
        remoteNote: "local branch kept (branch -d failed); remote branch kept",
      };
  }
  if (gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
    return {
      ok: false,
      remoteNote: "local branch still present after delete; remote branch kept",
    };
  let remoteNote = "no remote branch";
  try {
    if (hasOrigin(repo) && remoteRefCommit(repo, branch)) {
      execSync(`git push origin --delete ${branch}`, {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: pushEnv(),
      });
      remoteNote = "remote branch deleted";
    }
  } catch {
    return {
      ok: false,
      remoteNote: "remote branch kept (delete failed; remove it manually)",
    };
  }
  if (hasOrigin(repo) && remoteRefCommit(repo, branch))
    return {
      ok: false,
      remoteNote: "remote branch still present after delete",
    };
  return {
    ok: true,
    remoteNote,
  };
}

/** Detach a worktree off its branch and reset it clean onto `main`. */
function detachAndResetWorktree(repo: string, worktree: string): string[] {
  // Fail closed even for direct callers: `clean -fdq` (no `-x`) keeps
  // every ignored file, so an unrecognised one must never be reset over.
  const blockers = preservationBlockers(worktree);
  if (blockers.length)
    return [
      `unrecognised or secret-like ignored file(s) kept live: ${blockers.join(", ")}`,
    ];
  const problems: string[] = [];
  try {
    git(worktree, "checkout -q --detach HEAD");
  } catch {
    problems.push("detach failed");
  }
  try {
    const mainHead = git(repo, "rev-parse refs/heads/main");
    git(worktree, `reset --hard -q ${mainHead}`);
    git(worktree, "clean -fdq");
    if (git(worktree, "status --porcelain").trim()) problems.push("worktree not clean after reset");
    if (mergeInProgress(worktree)) problems.push("merge still in progress after reset");
    if (git(worktree, "rev-parse HEAD") !== mainHead) problems.push("worktree HEAD is not main");
  } catch {
    problems.push("reset onto main failed");
  }
  return problems;
}

/** Remove a legacy per-task worktree and prune its registration. */
function removeLegacyWorktree(repo: string, worktree: string): void {
  try {
    git(repo, `worktree remove --force ${worktree}`);
  } catch {
    try {
      rmSync(worktree, {
        recursive: true,
        force: true,
      });
    } catch {
      /* prune below still drops the registration */
    }
  }
  try {
    git(repo, "worktree prune");
  } catch {
    /* best effort */
  }
}

const IGNORED_CARRYOVER_DIRS = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
]);

/**
 * The only ignored files allowed to carry over when a slot is reset for
 * reuse: dependency installs and build/tool caches, recognised by a
 * directory segment. `isSecretLikeFile` is a floor, not a proof, so any
 * other ignored path (a root `token.json`, `auth.txt`, a `data/` file)
 * is unrecognised and fail-closed — it blocks the reset and keeps the
 * worktree live rather than silently leaking into the next task's slot.
 */
export function isAllowlistedIgnoredCarryover(path: string): boolean {
  // Directory segments only (never the file name itself). A directory
  // is carry-over when its exact name is allowlisted above, or it is a
  // cache directory by suffix (cache, *-cache, *_cache — the committed
  // warm-cache contract). A segment merely containing "cache"
  // (my-cache-token.json, cachebearer/) is unrecognised, fail-closed.
  return path
    .split("/")
    .slice(0, -1)
    .some((seg) => {
      const name = seg.toLowerCase();
      return (
        IGNORED_CARRYOVER_DIRS.has(name) ||
        name === "cache" ||
        name.endsWith("-cache") ||
        name.endsWith("_cache")
      );
    });
}

/** Every ignored untracked file, or null when the listing itself failed. */
function listIgnoredFiles(worktree: string): string[] | null {
  try {
    return git(worktree, "ls-files --others --ignored --exclude-standard")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Ignored files that are not on the carry-over allowlist. */
export function unrecognisedIgnoredFiles(worktree: string): string[] {
  const ignored = listIgnoredFiles(worktree);
  if (ignored === null)
    return [
      "(could not list ignored files)",
    ];
  return ignored.filter((f) => !isAllowlistedIgnoredCarryover(f));
}

/**
 * Files that block any reset/removal of this worktree: recognised
 * secret-like leftovers plus every unrecognised ignored file. Fails
 * closed — an enumeration miss or an unreadable listing blocks reuse.
 */
function preservationBlockers(worktree: string): string[] {
  return [
    ...new Set([
      ...secretLeftovers(worktree),
      ...unrecognisedIgnoredFiles(worktree),
    ]),
  ];
}

function secretLeftovers(worktree: string): string[] {
  const found = new Set<string>();
  try {
    for (const l of git(worktree, "status --porcelain --untracked-files=all").split("\n")) {
      let f = l.slice(3).trim();
      if (f.includes(" -> ")) f = f.split(" -> ")[1] ?? f;
      f = f.replace(/^"|"$/g, "");
      if (f && isSecretLikeFile(f)) found.add(f);
    }
  } catch {
    /* fall through to the ignored scan */
  }
  try {
    // Ignored secrets (.env, *.key under a .gitignore rule) are invisible
    // to plain status, and a reset/reuse would leak them to the next task.
    for (const f of git(worktree, "ls-files --others --ignored --exclude-standard").split("\n")) {
      const name = f.trim();
      if (name && isSecretLikeFile(name)) found.add(name);
    }
  } catch {
    /* no ignored listing available */
  }
  return [
    ...found,
  ];
}

function resolveOneFinalizedWorktree(
  repo: string,
  poolDir: string,
  worktree: string,
  problems: string[],
  preservedSecrets: string[],
): string[] {
  // Uncommitted secret-like files and unrecognised ignored files are
  // never auto-saved and never deleted: a reset/clean or removal would
  // destroy or leak them, so this worktree is kept live exactly as the
  // park paths keep theirs.
  const secrets = preservationBlockers(worktree);
  if (secrets.length) {
    preservedSecrets.push(...secrets);
    return secrets;
  }
  const slotMatch = /^slot-(\d+)$/.exec(worktree.split("/").pop() ?? "");
  if (slotMatch && dirname(worktree) === poolDir) {
    problems.push(...detachAndResetWorktree(repo, worktree));
    try {
      unlinkSync(leasePath(poolDir, Number(slotMatch[1])));
    } catch {
      /* already released */
    }
    if (existsSync(leasePath(poolDir, Number(slotMatch[1]))))
      problems.push("lease still held after release");
    return [];
  }
  removeLegacyWorktree(repo, worktree);
  if (existsSync(worktree)) problems.push("legacy worktree still present after removal");
  return [];
}

/** Mechanical post-check for one resolved pool slot. */
function verifyFinalizedSlot(
  worktree: string,
  poolDir: string,
  slot: number,
  mainHead: string,
): string[] {
  if (!existsSync(worktree))
    return [
      `pool slot ${worktree} missing after reset`,
    ];
  const problems: string[] = [];
  try {
    if (git(worktree, "status --porcelain").trim()) problems.push("worktree not clean");
    if (mergeInProgress(worktree)) problems.push("merge still in progress");
    if (git(worktree, "rev-parse HEAD") !== mainHead) problems.push("worktree HEAD is not main");
    if (gitOk(worktree, "symbolic-ref -q HEAD")) problems.push("worktree is not detached");
  } catch {
    problems.push("could not verify the resolved slot");
  }
  // Allowlist re-check: `clean -fdq` keeps ignored files, so whatever
  // remains must be recognised carry-over — never a secret, never an
  // unrecognised ignored file that would leak to the next task.
  const remaining = preservationBlockers(worktree);
  if (remaining.length)
    problems.push(`ignored file(s) not cleared for reuse: ${remaining.join(", ")}`);
  if (existsSync(leasePath(poolDir, slot))) problems.push("lease still held after release");
  return problems;
}

/** Problems for a worktree kept live: its preserved secrets must remain. */
function preservedWorktreeProblems(worktree: string): string[] {
  return secretLeftovers(worktree)
    .filter((f) => !existsSync(join(worktree, f)))
    .map((f) => `preserved secret ${f} missing`);
}

/** Mechanical post-check that a resolved worktree is provably clean. */
function verifyFinalizedWorktrees(
  repo: string,
  task: Task,
  existingBefore: string[],
  preserved: Set<string>,
): string[] {
  const problems: string[] = [];
  const poolDir = worktreePoolDir(repo, task.projectId);
  let mainHead = "";
  try {
    mainHead = git(repo, "rev-parse refs/heads/main");
  } catch {
    return [
      "no main HEAD to verify the resolved worktree against",
    ];
  }
  for (const worktree of existingBefore) {
    if (preserved.has(worktree)) {
      problems.push(...preservedWorktreeProblems(worktree));
      continue;
    }
    const slotMatch = /^slot-(\d+)$/.exec(worktree.split("/").pop() ?? "");
    if (slotMatch && dirname(worktree) === poolDir)
      problems.push(...verifyFinalizedSlot(worktree, poolDir, Number(slotMatch[1]), mainHead));
    else if (existsSync(worktree)) problems.push("legacy worktree still present after removal");
  }
  return problems;
}

/** Post-delete proof for finalize; returns a problem or "". */
function postFinalizeProblem(
  repo: string,
  task: Task,
  resolved: ReturnType<typeof resolveFinalizedWorktree>,
  mergeCommit: string,
): string {
  if (mergeCommit && !gitOk(repo, `merge-base --is-ancestor ${mergeCommit} main`))
    return "the merged commit is not an ancestor of main after finalize";
  const post = verifyFinalizedWorktrees(
    repo,
    task,
    resolved.existingWorktrees,
    new Set(resolved.preservedWorktrees),
  );
  return post.length ? `worktree not proven clean after finalize (${post.join("; ")})` : "";
}

/**
 * Resolve a finalized task's worktree(s). A warm-pool slot is detached
 * off the task branch onto the new `main`, reset clean and unleased —
 * the slot directory stays for reuse. A legacy per-task worktree is
 * removed and pruned. Only worktrees this task actually holds are
 * touched: a stale record may point at a slot since leased by another
 * task, and that slot (lease, HEAD, contents) is hands-off.
 */
function resolveFinalizedWorktree(
  repo: string,
  task: Task,
): {
  problems: string[];
  preservedSecrets: string[];
  preservedWorktrees: string[];
  existingWorktrees: string[];
  skippedWorktrees: string[];
} {
  const problems: string[] = [];
  const preservedSecrets: string[] = [];
  const preservedWorktrees: string[] = [];
  const skippedWorktrees: string[] = [];
  const poolDir = worktreePoolDir(repo, task.projectId);
  const candidates = new Set<string>();
  if (task.worktree) candidates.add(task.worktree);
  candidates.add(join(poolDir, task.id)); // legacy per-task dir
  const existingWorktrees = [
    ...candidates,
  ].filter((w) => existsSync(w));
  for (const worktree of existingWorktrees) {
    if (
      !worktreeLeasedByTask({
        ...task,
        worktree,
      })
    ) {
      // A stale pointer at another task's slot: hands-off. This task
      // holds no lease there, so it does not block finalize — but the
      // caller must not claim that slot was resolved.
      skippedWorktrees.push(worktree);
      preservedWorktrees.push(worktree);
      continue;
    }
    const secrets = resolveOneFinalizedWorktree(
      repo,
      poolDir,
      worktree,
      problems,
      preservedSecrets,
    );
    if (secrets.length) preservedWorktrees.push(worktree);
  }
  problems.push(
    ...verifyFinalizedWorktrees(repo, task, existingWorktrees, new Set(preservedWorktrees)),
  );
  return {
    problems,
    preservedSecrets,
    preservedWorktrees,
    existingWorktrees,
    skippedWorktrees,
  };
}

type FinalizeProof =
  | {
      ok: true;
      branchExists: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

/** Strict merge proof: deletion requires the branch itself on main. */
function finalizeProof(repo: string, branch: string, mergeCommit: string): FinalizeProof {
  if (!gitOk(repo, "rev-parse --verify -q refs/heads/main"))
    return {
      ok: false,
      reason: "no main branch; branch and worktree kept",
    };
  const branchExists = gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`);
  // A mergeCommit-only ancestry proves a merge landed, never that this
  // branch's unique commits did — it authorizes no delete at all.
  if (branchExists && gitOk(repo, `merge-base --is-ancestor ${branch} main`))
    return {
      ok: true,
      branchExists,
    };
  if (!branchExists && mergeCommit && gitOk(repo, `merge-base --is-ancestor ${mergeCommit} main`))
    return {
      ok: true,
      branchExists,
    };
  return {
    ok: false,
    reason: `branch ${branch} is not merged into main; kept for manual landing`,
  };
}

/** Finalize outcome when the local branch is already absent. */
function absentBranchOutcome(
  repo: string,
  task: Task,
  branch: string,
  resolved: ReturnType<typeof resolveFinalizedWorktree>,
  mergeCommit: string,
): FinalizeOutcome {
  const problem = postFinalizeProblem(repo, task, resolved, mergeCommit);
  if (problem)
    return {
      status: "kept",
      detail: `merged on main but ${problem}`,
    };
  const shortA = mergeCommit ? mergeCommit.slice(0, 7) : "unknown";
  const skipNote = resolved.skippedWorktrees.length
    ? "; stale worktree pointer kept hands-off (leased by another task)"
    : "";
  return {
    status: "finalized",
    detail: `finalized on main (${shortA}): branch ${branch} already absent locally, no remote delete attempted; worktree cleanup verified${skipNote}`,
  };
}

/**
 * Finish a merged task mechanically: once the merge is proven on `main`
 * (the merged commit is an ancestor of `main`, never the agent's word),
 * snapshot the diff for reviewability, resolve the old worktree
 * (detached onto the new `main`, reset clean; pool slots also release
 * their lease, legacy worktrees are removed and pruned), and delete the
 * merged `task/<id>` branch locally and on the remote. Anything not
 * provably merged is kept exactly as it is for manual landing. Only
 * branches merged by this finalize path are deleted; the pre-existing
 * backlog of merged `task/*` branches is left for manual deletion.
 */
export async function finalizeTaskWork(
  store: FactoryStore,
  taskId: string,
  mergeCommit: string,
): Promise<FinalizeOutcome> {
  const kept = (detail: string): FinalizeOutcome => ({
    status: "kept",
    detail,
  });
  const task = await store.readTask(taskId).catch(() => null);
  if (!task) return kept("task no longer exists; nothing finalized");
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath) return kept("no project repo; branch and worktree kept");
  const repo = realpathSync(project.repoPath);
  const branch = `task/${taskId}`;
  const proof = finalizeProof(repo, branch, mergeCommit);
  if (!proof.ok) return kept(proof.reason);
  const branchExists = proof.branchExists;
  // MergeCommit-only proof (no local branch) never authorizes a remote
  // delete: keep the remote branch and the worktree for manual deletion.
  if (!branchExists && hasOrigin(repo) && remoteRefCommit(repo, branch))
    return kept(
      `merged on main but remote branch ${branch} kept: no local branch proof for this task; delete it manually`,
    );
  snapshotDiffForFinalize(task);
  // Resolve the worktree before deleting the branch: a slot may still
  // be checked out on it, and git refuses a checked-out branch.
  const resolved = resolveFinalizedWorktree(repo, task);
  if (resolved.problems.length)
    return kept(
      `merged on main but worktree not proven clean (${resolved.problems.join("; ")}); branch ${branch} kept`,
    );
  // Preserved blockers keep the live worktree (and its checked-out branch):
  // deleting the branch or claiming the slot resolved would be false.
  if (resolved.preservedSecrets.length)
    return kept(
      `merged on main but worktree kept live with uncommitted secret-like or unrecognised ignored file(s): ${resolved.preservedSecrets.join(", ")}; branch ${branch} kept — remove or commit those file(s), then finalize manually`,
    );
  if (!branchExists) return absentBranchOutcome(repo, task, branch, resolved, mergeCommit);
  const deleted = deleteFinalizedBranch(repo, branch);
  if (!deleted.ok) return kept(`merged on main but branch not deleted: ${deleted.remoteNote}`);
  // Final mechanical proof before claiming anything: branch gone locally
  // (and remotely, checked in deleteFinalizedBranch), the merge commit is
  // still an ancestor of main, and every resolved worktree re-verifies as
  // clean, detached, unleased and merge-free after the delete.
  if (gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
    return kept(`merged on main but branch ${branch} still present after delete`);
  const problem = postFinalizeProblem(repo, task, resolved, mergeCommit);
  if (problem)
    return kept(`branch ${branch} deleted but ${problem}; worktree kept for manual cleanup`);
  const short = mergeCommit ? mergeCommit.slice(0, 7) : "unknown";
  return {
    status: "finalized",
    detail: `finalized on main (${short}): branch ${branch} deleted locally, ${deleted.remoteNote}; worktree cleanup verified${resolved.skippedWorktrees.length ? "; stale worktree pointer kept hands-off (leased by another task)" : ""}`,
  };
}

/** Single writer of the one `auto-commit:` status line per landing attempt. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export async function landTaskWork(
  store: FactoryStore,
  task: Task,
  now: () => string,
  opts?: {
    agent?: PipelineOptions;
  },
): Promise<"done" | "parked" | "held"> {
  const commitOutcome = await commitAndPushTaskWork(store, task, now);
  const freshAfterCommit = (await store.readTask(task.id).catch(() => null)) ?? task;
  const mergeOutcome: MergeOutcome = await mergeTaskIntoMain(
    store,
    freshAfterCommit,
    now,
    commitOutcome,
    {
      agent: opts?.agent,
    },
  );
  const fresh = (await store.readTask(task.id).catch(() => null)) ?? freshAfterCommit;
  const branch = `task/${task.id}`;
  const commit =
    commitOutcome.status === "pushed" ||
    commitOutcome.status === "local" ||
    commitOutcome.status === "committed-locally"
      ? commitOutcome.commit
      : (fresh.branchPushPending?.commit ?? fresh.mainPushPending?.commit ?? "");
  const short = commit ? commit.slice(0, 7) : "unknown";
  const note = async (text: string) => {
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text,
      })
      .catch(() => {});
  };
  if (mergeOutcome.status === "parked") {
    if (mergeOutcome.parkKind === "conflict") {
      const files = mergeOutcome.files?.length ? mergeOutcome.files.join(", ") : "unknown files";
      const attempt = mergeOutcome.resolution ? ` — ${mergeOutcome.resolution}` : "";
      await note(
        `auto-commit: parked — merge conflict in ${files}; branch ${branch} is committed-locally (${short})${attempt}, resolve via builder resume${secretSuffix(commitOutcome.secretFiles)}`,
      );
    } else if (mergeOutcome.parkKind === "decisions") {
      const files = mergeOutcome.files?.length ? mergeOutcome.files.join(", ") : "unknown files";
      await note(
        `auto-commit: parked — decisions change in ${files}; owner to decide${secretSuffix(commitOutcome.secretFiles)}`,
      );
    } else {
      await note(
        `auto-commit: parked — ${mergeOutcome.reason}${secretSuffix(commitOutcome.secretFiles)}`,
      );
    }
    return "parked";
  }
  if (commitOutcome.status === "nothing" && mergeOutcome.status === "nothing") {
    if (commitOutcome.secretFiles.length) {
      await note(`auto-commit: nothing to commit${secretSuffix(commitOutcome.secretFiles)}`);
    }
    return "done";
  }
  if (mergeOutcome.status === "already-merged" && fresh.mainPushPending) {
    await note(
      `auto-commit: merged-locally, push-pending — main push pending at ${fresh.mainPushPending.commit.slice(0, 7)} — push retry queued${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "held";
  }
  if (mergeOutcome.status === "merged-local") {
    const mc = mergeOutcome.mergeCommit.slice(0, 7);
    const fin = await finalizeTaskWork(store, task.id, mergeOutcome.mergeCommit);
    await note(
      `auto-commit: merged into main (${mc}) locally — no origin remote configured — undo with: git revert -m 1 ${mc}${secretSuffix(commitOutcome.secretFiles)}; ${fin.detail}`,
    );
    return "done";
  }
  if (mergeOutcome.status === "merged-pushed" || mergeOutcome.status === "already-merged") {
    const mc = mergeOutcome.mergeCommit.slice(0, 7);
    const fin = await finalizeTaskWork(store, task.id, mergeOutcome.mergeCommit);
    if (mergeOutcome.status === "already-merged" && mergeOutcome.noRemote)
      await note(
        `auto-commit: merged into main (${mc}) locally — no origin remote configured — undo with: git revert -m 1 ${mc}${secretSuffix(commitOutcome.secretFiles)}; ${fin.detail}`,
      );
    else if (commitOutcome.status === "pushed")
      await note(
        `auto-commit: pushed branch ${branch} (${short}) — merged into main (${mc}) and pushed — undo with: git revert -m 1 ${mc}${secretSuffix(commitOutcome.secretFiles)}; ${fin.detail}`,
      );
    else
      await note(
        `auto-commit: merged into main (${mc}) and pushed — undo with: git revert -m 1 ${mc}${secretSuffix(commitOutcome.secretFiles)}; ${fin.detail}`,
      );
    return "done";
  }
  if (mergeOutcome.status === "merged-locally") {
    await note(
      `auto-commit: merged-locally, push-pending — merged ${branch} into main locally (${mergeOutcome.mergeCommit.slice(0, 7)}), but pushing main failed (${mergeOutcome.mainPushError}) — push retry queued${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "held";
  }
  // Pending held states take precedence over skipped/failed descriptions.
  if (fresh.branchPushPending || fresh.mainPushPending) {
    if (fresh.mainPushPending) {
      await note(
        `auto-commit: merged-locally, push-pending — main push pending at ${fresh.mainPushPending.commit.slice(0, 7)} — push retry queued${secretSuffix(commitOutcome.secretFiles)}`,
      );
    } else {
      const extra =
        mergeOutcome.status === "skipped"
          ? `; merge skipped: ${mergeOutcome.reason}`
          : mergeOutcome.status === "failed"
            ? `; merge failed (${mergeOutcome.reason})`
            : "";
      await note(
        `auto-commit: committed-locally, push-pending — committed ${short} on branch ${branch} locally, but the branch push failed (${commitOutcome.status === "committed-locally" ? commitOutcome.pushError : (fresh.branchPushPending?.lastError ?? "")}) — push retry queued${extra}${secretSuffix(commitOutcome.secretFiles)}`,
      );
    }
    return "held";
  }
  if (mergeOutcome.status === "skipped") {
    // Work is committed on the branch but NOT on main: that is a stall,
    // never a completion. State it loudly, queue a merge retry via the
    // branch-pending obligation (the sweep re-runs the merge in ref
    // mode), and hold the task in-review until it actually lands.
    // Holding only helps when landing can succeed later: a pushed branch
    // (origin exists) or an existing local main to merge into. A local-only
    // repo with no main at all has nowhere to land — committed-locally is
    // its terminal state, as before.
    let canLandLater = commitOutcome.status === "pushed";
    if (!canLandLater && commit) {
      try {
        const project = await store.readProject(task.projectId).catch(() => null);
        if (project?.repoPath)
          canLandLater = gitOk(
            realpathSync(project.repoPath),
            "rev-parse --verify -q refs/heads/main",
          );
      } catch {
        canLandLater = false;
      }
    }
    if (
      commit &&
      canLandLater &&
      (commitOutcome.status === "pushed" ||
        commitOutcome.status === "local" ||
        commitOutcome.status === "committed-locally")
    ) {
      if (!fresh.branchPushPending)
        await updatePending(store, fresh, {
          branchPushPending: {
            targetRef: branch,
            commit,
            attempts: 1,
            lastError: `merge skipped: ${mergeOutcome.reason}`,
            nextRetryAt: nextRetryIso(now, 1),
          },
        });
      await note(
        `auto-commit: MERGE STALLED — branch ${branch} (${short}) is committed but not merged into main; merge skipped: ${mergeOutcome.reason} — merge retry queued, task held in-review until it lands${secretSuffix(commitOutcome.secretFiles)}`,
      );
      return "held";
    }
    if (commitOutcome.status === "local")
      await note(
        `auto-commit: committed-locally — committed ${short} on branch ${branch} locally — no origin remote configured; merge skipped: ${mergeOutcome.reason}${secretSuffix(commitOutcome.secretFiles)}`,
      );
    else
      await note(
        `auto-commit: merge skipped: ${mergeOutcome.reason}${secretSuffix(commitOutcome.secretFiles)}`,
      );
    return "done";
  }
  if (commitOutcome.status === "local") {
    await note(
      `auto-commit: committed-locally — committed ${short} on branch ${branch} locally — no origin remote configured${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "done";
  }
  if (commitOutcome.status === "pushed") {
    await note(
      `auto-commit: pushed branch ${branch} (${short}) — ready to merge into main${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "done";
  }
  if (commitOutcome.status === "committed-locally") {
    await note(
      `auto-commit: committed-locally, push-pending — committed ${short} on branch ${branch} locally, but the branch push failed (${commitOutcome.pushError}) — push retry queued${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "held";
  }
  if (commitOutcome.status === "failed") {
    await note(
      `auto-commit: failed (${commitOutcome.reason}) — the work is still in the diff snapshot${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "done";
  }
  if (mergeOutcome.status === "failed") {
    // A failed merge with committed work is a stall, not a completion:
    // same loud statement and queued retry as a skipped merge.
    if (commit) {
      if (!fresh.branchPushPending)
        await updatePending(store, fresh, {
          branchPushPending: {
            targetRef: branch,
            commit,
            attempts: 1,
            lastError: `merge failed: ${mergeOutcome.reason}`,
            nextRetryAt: nextRetryIso(now, 1),
          },
        });
      await note(
        `auto-commit: MERGE STALLED — branch ${branch} (${short}) is committed but not merged into main; merge failed (${mergeOutcome.reason}) — merge retry queued, task held in-review until it lands${secretSuffix(commitOutcome.secretFiles)}`,
      );
      return "held";
    }
    await note(
      `auto-commit: failed (${mergeOutcome.reason})${secretSuffix(commitOutcome.secretFiles)}`,
    );
    return "done";
  }
  return "done";
}

export const MAX_PUSH_ATTEMPTS = 8;
const pushRetryInFlight = new Set<string>();

function backoffMs(attempts: number): number {
  const steps = [
    60_000,
    300_000,
    900_000,
    3_600_000,
  ];
  return steps[Math.min(steps.length - 1, Math.max(0, attempts - 1))] ?? 3_600_000;
}
function nextRetryIso(now: () => string, attempts: number): string {
  const t = Date.parse(now());
  const base = Number.isNaN(t) ? Date.now() : t;
  return new Date(base + backoffMs(attempts)).toISOString();
}
function isDue(
  pending: {
    nextRetryAt: string;
  },
  now: () => string,
): boolean {
  if (!pending.nextRetryAt) return true;
  const d = Date.parse(pending.nextRetryAt);
  const n = Date.parse(now());
  if (Number.isNaN(d) || Number.isNaN(n)) return true;
  return d <= n;
}
function remoteRefCommit(repo: string, ref: string): string {
  try {
    const out = execSync(`git ls-remote origin ${ref}`, {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: pushEnv(),
    }).trim();
    return out.split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Retry owed pushes for tasks held in `in-review` — plus `done` tasks
 * whose rollback revert still owes its main push (a rollback marks the
 * task rolled back before pushing, so the push retry must admit it).
 * One `push retry:` line per attempt (parked lines keep the
 * `auto-commit: parked` vocabulary). Exported so tests can call it
 * directly and concurrently.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
export async function retryPendingPushes(
  store: FactoryStore,
  now: () => string = () => new Date().toISOString(),
  active?: ReadonlySet<string>,
): Promise<string[]> {
  const retried: string[] = [];
  const tasks = await store.listTasks().catch(() => [] as Task[]);
  for (const task of tasks) {
    // A done task only ever owes a rollback revert's main push, never a branch push.
    if (task.state === "done" && !task.mainPushPending) continue;
    if (task.state !== "in-review" && task.state !== "done") continue;
    if (!task.branchPushPending && !task.mainPushPending) continue;
    if (active?.has(task.id)) continue;
    if (pushRetryInFlight.has(task.id)) continue;
    const duePending =
      task.mainPushPending && isDue(task.mainPushPending, now)
        ? task.mainPushPending
        : task.branchPushPending && isDue(task.branchPushPending, now)
          ? task.branchPushPending
          : null;
    if (!duePending) continue;
    pushRetryInFlight.add(task.id);
    try {
      const fresh = (await store.readTask(task.id).catch(() => null)) ?? task;
      if (fresh.state === "done" && !fresh.mainPushPending) continue;
      if (fresh.state !== "in-review" && fresh.state !== "done") continue;
      if (!fresh.branchPushPending && !fresh.mainPushPending) continue;
      const pending =
        fresh.mainPushPending && isDue(fresh.mainPushPending, now)
          ? fresh.mainPushPending
          : fresh.branchPushPending && isDue(fresh.branchPushPending, now)
            ? fresh.branchPushPending
            : null;
      if (!pending) continue;
      retried.push(fresh.id);
      await retryOnePendingPush(store, fresh, now);
    } finally {
      pushRetryInFlight.delete(task.id);
    }
  }
  return retried;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function retryOnePendingPush(
  store: FactoryStore,
  task: Task,
  now: () => string,
): Promise<void> {
  const note = async (text: string) => {
    await store
      .appendPrompt(task.id, {
        at: now(),
        kind: "system",
        text,
      })
      .catch(() => {});
  };
  const project = await store.readProject(task.projectId).catch(() => null);
  if (!project?.repoPath) return;
  const repo = realpathSync(project.repoPath);
  const branch = `task/${task.id}`;
  const failRetry = async (target: "branch" | "main", err: unknown) => {
    const cur = (await store.readTask(task.id).catch(() => null)) ?? task;
    const field = target === "main" ? cur.mainPushPending : cur.branchPushPending;
    if (!field) return;
    const attempts = field.attempts + 1;
    const msg = errLine(err);
    const owed = {
      ...field,
      attempts,
      lastError: msg,
      nextRetryAt: nextRetryIso(now, attempts),
    };
    await updatePending(
      store,
      cur,
      target === "main"
        ? {
            mainPushPending: owed,
          }
        : {
            branchPushPending: owed,
          },
    );
    if (attempts >= MAX_PUSH_ATTEMPTS) {
      await note(
        `push retry: automatic retries stopped after ${attempts} attempts for ${field.targetRef} (${field.commit.slice(0, 7)}); the work is safe locally — push it manually`,
      );
      // A rolled-back task stays done with its revert safe locally; only
      // held in-review tasks park for the owner.
      if (cur.state === "in-review")
        await store.moveTask(task.id, "needs-input", now()).catch(() => {});
    } else {
      await note(
        `push retry: pushing ${field.targetRef} (${field.commit.slice(0, 7)}) failed (${msg}) — will retry automatically; the work is safe locally`,
      );
    }
  };

  // Main push owed: supersession — never retry the branch after a merge.
  if (task.mainPushPending) {
    const pending = task.mainPushPending;
    try {
      if (remoteRefCommit(repo, "main") !== pending.commit) {
        execSync("git push origin main", {
          cwd: repo,
          encoding: "utf8",
          timeout: 120_000,
          env: pushEnv(),
        });
      }
      await updatePending(store, task, {
        branchPushPending: null,
        mainPushPending: null,
      });
      const finMain = await finalizeTaskWork(store, task.id, pending.commit);
      await note(
        `push retry: pushed main (${pending.commit.slice(0, 7)}) — landed; ${finMain.detail}`,
      );
      // A rolled-back task is already done; only held in-review tasks move.
      if (task.state === "in-review") await store.moveTask(task.id, "done", now()).catch(() => {});
    } catch (err) {
      await failRetry("main", err);
    }
    return;
  }

  const pending = task.branchPushPending;
  if (!pending) return;
  // Supersession check: already merged locally — owed obligation is main.
  if (
    gitOk(repo, `rev-parse --verify -q refs/heads/main`) &&
    gitOk(repo, `merge-base --is-ancestor ${pending.commit} main`)
  ) {
    await updatePending(store, task, {
      branchPushPending: null,
    });
    const mergeCommit = git(repo, "rev-parse main");
    try {
      if (remoteRefCommit(repo, "main") !== mergeCommit)
        execSync("git push origin main", {
          cwd: repo,
          encoding: "utf8",
          timeout: 120_000,
          env: pushEnv(),
        });
      await updatePending(store, task, {
        branchPushPending: null,
        mainPushPending: null,
      });
      const finSuper = await finalizeTaskWork(store, task.id, mergeCommit);
      await note(
        `push retry: pushed main (${mergeCommit.slice(0, 7)}) — landed; ${finSuper.detail}`,
      );
      await store.moveTask(task.id, "done", now()).catch(() => {});
    } catch (err) {
      await updatePending(store, task, {
        mainPushPending: {
          targetRef: "main",
          commit: mergeCommit,
          attempts: 1,
          lastError: errLine(err),
          nextRetryAt: nextRetryIso(now, 1),
        },
      });
      await note(
        `push retry: merged-locally, push-pending — pushing main (${mergeCommit.slice(0, 7)}) failed (${errLine(err)}) — will retry automatically; the work is safe locally`,
      );
    }
    return;
  }
  try {
    if (remoteRefCommit(repo, branch) !== pending.commit) {
      if (!gitOk(repo, `rev-parse --verify -q refs/heads/${branch}`))
        git(repo, `branch -f ${branch} ${pending.commit}`);
      execSync(`git push origin ${branch}`, {
        cwd: repo,
        encoding: "utf8",
        timeout: 120_000,
        env: pushEnv(),
      });
    }
  } catch (err) {
    await failRetry("branch", err);
    return;
  }
  await updatePending(store, task, {
    branchPushPending: null,
  });
  // Continue landing through the merge helper in ref-based mode.
  const fresh = (await store.readTask(task.id).catch(() => null)) ?? task;
  const mergeOutcome = await mergeTaskIntoMain(
    store,
    fresh,
    now,
    {
      status: "pushed",
      branch,
      commit: pending.commit,
      secretFiles: [],
    },
    {
      forceRef: true,
    },
  );
  const after = (await store.readTask(task.id).catch(() => null)) ?? fresh;
  if (mergeOutcome.status === "parked") {
    if (mergeOutcome.parkKind === "conflict") {
      const files = mergeOutcome.files?.length ? mergeOutcome.files.join(", ") : "unknown files";
      await note(
        `auto-commit: parked — merge conflict in ${files}; branch ${branch} is committed-locally (${pending.commit.slice(0, 7)}), resolve via builder resume`,
      );
    } else if (mergeOutcome.parkKind === "decisions") {
      const files = mergeOutcome.files?.length ? mergeOutcome.files.join(", ") : "unknown files";
      await note(`auto-commit: parked — decisions change in ${files}; owner to decide`);
    } else {
      await note(`auto-commit: parked — ${mergeOutcome.reason}`);
    }
    await store.moveTask(task.id, "needs-input", now()).catch(() => {});
    return;
  }
  if (mergeOutcome.status === "merged-locally") {
    await note(
      `push retry: merged-locally, push-pending — merged ${branch} into main locally (${mergeOutcome.mergeCommit.slice(0, 7)}), but pushing main failed (${mergeOutcome.mainPushError}) — push retry queued`,
    );
    return;
  }
  if (after.mainPushPending) {
    await note(
      `push retry: merged-locally, push-pending — main push pending at ${after.mainPushPending.commit.slice(0, 7)} — push retry queued`,
    );
    return;
  }
  if (mergeOutcome.status === "merged-local") {
    const finRef = await finalizeTaskWork(store, task.id, mergeOutcome.mergeCommit);
    await note(
      `push retry: merged into main (${mergeOutcome.mergeCommit.slice(0, 7)}) locally — no origin remote configured — landed; ${finRef.detail}`,
    );
    await store.moveTask(task.id, "done", now()).catch(() => {});
    return;
  }
  if (mergeOutcome.status === "already-merged" && mergeOutcome.noRemote) {
    const finRef = await finalizeTaskWork(store, task.id, mergeOutcome.mergeCommit);
    await note(
      `push retry: pushed branch ${branch} (${pending.commit.slice(0, 7)}) and merged into main (${mergeOutcome.mergeCommit.slice(0, 7)}) locally — no origin remote configured — landed; ${finRef.detail}`,
    );
    await store.moveTask(task.id, "done", now()).catch(() => {});
    return;
  }
  if (mergeOutcome.status === "merged-pushed" || mergeOutcome.status === "already-merged") {
    const finRef = await finalizeTaskWork(store, task.id, mergeOutcome.mergeCommit);
    await note(
      `push retry: pushed branch ${branch} (${pending.commit.slice(0, 7)}) and merged into main (${mergeOutcome.mergeCommit.slice(0, 7)}) — landed; ${finRef.detail}`,
    );
    await store.moveTask(task.id, "done", now()).catch(() => {});
    return;
  }
  if (mergeOutcome.status === "skipped") {
    await note(
      `push retry: pushed branch ${branch} (${pending.commit.slice(0, 7)}) — landed; merge skipped: ${mergeOutcome.reason}`,
    );
    await store.moveTask(task.id, "done", now()).catch(() => {});
    return;
  }
  await note(`push retry: pushed branch ${branch} (${pending.commit.slice(0, 7)}) — landed`);
  await store.moveTask(task.id, "done", now()).catch(() => {});
}

export interface DispatchOptions extends PipelineOptions {
  maxParallelTasks: number; // cap on tasks running in parallel — NOT a count of agents/stations
  ramFloorMb: number;
  active: Set<string>; // task ids with a pipeline already in flight here
  launchPlan?: (taskId: string) => Promise<void>; // queued planning; launched before implementation
}

/**
 * One dispatch tick: fill free parallel slots from the persisted queue.
 * Queued planning launches first (it offloads the human), then approved
 * tasks nearest to landing on main. Tasks that do not fit stay in
 * `state: "planned"` — that is the queue — and a later tick picks them
 * up as running tasks finish and slots (and warm worktrees) free up.
 * Returns the tasks launched by this tick, plans first.
 */
const ORPHAN_GRACE_MS = 2 * 60_000;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export async function dispatchTick(opts: DispatchOptions): Promise<string[]> {
  const { store, active } = opts;
  const now = opts.now ?? (() => new Date().toISOString());
  await retryPendingPushes(store, now, active).catch(() => {});
  let tasks = await store.listTasks();
  // Auto-approve (Settings default): draft plans with no open questions
  // move forward without waiting for the owner's click — including
  // plans drafted before this was switched on. Questions still park.
  if (opts.autoApprove) {
    for (const task of tasks) {
      if (
        task.state === "planned" &&
        task.planState === "draft" &&
        !(task.planQuestions?.length ?? 0) &&
        !active.has(task.id)
      ) {
        try {
          const approved = approvePlan(task, now());
          await store.writeTask(approved);
          await store
            .appendPrompt(task.id, {
              at: now(),
              kind: "system",
              text: "plan auto-approved — Settings move plans forward without a click; implementation starts automatically",
            })
            .catch(() => {});
        } catch {
          /* a racing transition refused it; next tick retries */
        }
      }
    }
    tasks = await store.listTasks();
  }
  // Interrupted work resumes itself: an interruption is not a question,
  // so it must not wait for the owner. A task left in running/in-review
  // with no pipeline in this process, untouched past the grace period,
  // was interrupted (a dashboard restart kills its stations) — relaunch
  // its pipeline; the same station/session resumes. Tasks already parked
  // by the old park-on-interrupt behaviour (their last entry is the
  // interruption note, unanswered) resume the same way. Real blocks —
  // a builder question, a decisions pause — still park in needs-input
  // from inside the pipeline; a failed verify parks too but auto-resumes
  // once below (environment failures pass on re-run). Pipelines alive in this
  // process are in `active` and are never reclaimed.
  // Global quota pause: a station hit the token limit and recorded a
  // pause-until instant. Launch nothing (plans, builds, resumes) until
  // it passes — one probe after the backoff beats 24 stations failing
  // against the same wall. Auto-approve above still runs (it is free).
  // The recorded reset can be stale (quota may refill earlier), so
  // every probe interval a single task is launched as a probe: if its
  // station completes, tokens are back and the pause clears; if it
  // hits quota again, the pause re-records and probing continues.
  const quota = await store.quotaPause().catch(() => ({
    until: "",
    nextProbeAt: "",
  }));
  let probing = false;
  if (quota.until && Date.parse(quota.until) > Date.parse(now())) {
    if (quota.nextProbeAt && Date.parse(quota.nextProbeAt) > Date.parse(now())) return [];
    await store.claimQuotaProbe(now()).catch(() => {});
    probing = true;
  }

  const resumed: string[] = [];
  if (freeRamMb() >= opts.ramFloorMb) {
    for (const task of tasks) {
      if (probing && resumed.length >= 1) break; // one probe only
      if (active.has(task.id)) continue;
      if ((task.branchPushPending || task.mainPushPending) && task.state !== "needs-input")
        continue; // retry sweep owns held tasks; parked needs-input tasks still auto-resume below
      const orphaned =
        (task.state === "running" || task.state === "in-review") &&
        Date.parse(task.updatedAt) < Date.parse(now()) - ORPHAN_GRACE_MS;
      let parkedInterrupted = false;
      let parkedPickup = false;
      let parkedMerge = false;
      let parkedVerify = false;
      if (!orphaned && task.state === "needs-input") {
        const prompts = await store.listPrompts(task.id).catch(() => []);
        const last = prompts[prompts.length - 1];
        // Quota-wait is not an owner question: once the sweep reaches
        // here the global quota pause has already passed (gate above),
        // so a quota park resumes like an interruption. Legacy parks
        // (recorded before quota classification existed) carry the raw
        // 429 text in a generic failure note: recognize those too, but
        // never resume before the reset instant named in the note.
        parkedInterrupted = last?.kind === "system" && last.text.startsWith("quota:");
        if (
          !parkedInterrupted &&
          last?.kind === "system" &&
          /quota|\b429\b|rate.?limit/i.test(last.text)
        ) {
          const resetAt = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(last.text)?.[1] ?? "";
          parkedInterrupted = !resetAt || Date.parse(resetAt) <= Date.parse(now());
        }
        if (!parkedInterrupted)
          parkedInterrupted =
            last?.kind === "system" && last.text.startsWith("pipeline interrupted");
        // A builder timeout is also not an owner question: tasks parked
        // by the old park-on-first-timeout behaviour resume once, and
        // the builder loop now reiterates automatically. The marker
        // check keeps this from becoming a resume loop — after the new
        // loop has reiterated and parked again, it stays parked.
        if (
          !parkedInterrupted &&
          last?.kind === "system" &&
          last.text.startsWith("builder station did not complete:") &&
          last.text.includes("timed out") &&
          !prompts.some((p) => p.text.includes("automatically reiterating"))
        )
          parkedInterrupted = true;
        // A merge conflict discovered at landing is builder work, not an
        // owner question: resume once and the review loop sends the
        // conflict to the builder. Decisions pauses stay with the owner.
        if (
          !parkedInterrupted &&
          last?.kind === "system" &&
          ((last.text.startsWith("auto-commit: parked") && last.text.includes("merge conflict")) ||
            (last.text.startsWith("auto-merge paused:") && last.text.includes("conflict"))) &&
          !prompts.some((p) => p.text.includes("merge conflict auto-resume"))
        )
          parkedMerge = true;
        // A verification-failed park also resumes itself — once.
        // Verification failures are often the environment, not the work
        // (a fresh worktree missing installed types, a flaky integration
        // test that passes on clean main): one automatic re-run beats
        // waking the owner. If it parks again after that resume, the
        // marker keeps it parked — a repeated failure is real and the
        // owner decides.
        if (
          !parkedInterrupted &&
          last?.kind === "system" &&
          last.text.startsWith("verification failed") &&
          !prompts.some((p) => p.text.includes("verification auto-resume"))
        )
          parkedVerify = true;
        // A decisions pickup park also resumes itself — once. The
        // pipeline's impact judge then decides whether the owner is
        // needed at all; if it already judged and asked, the task
        // stays parked for the owner (no relaunch loop).
        if (
          !parkedInterrupted &&
          last?.kind === "system" &&
          last.text.startsWith("pickup paused") &&
          !prompts.some((p) => p.text.startsWith("decisions-judge:"))
        )
          parkedPickup = true;
      }
      parkedInterrupted = parkedInterrupted || parkedPickup || parkedMerge || parkedVerify;
      if (!orphaned && !parkedInterrupted) continue;
      // running -> running is not a legal transition, so refresh the
      // timestamp directly: without it the grace check keeps refiring
      // and every server generation relaunches a duplicate pipeline.
      if (task.state === "running")
        await store
          .writeTask({
            ...task,
            updatedAt: now(),
          })
          .catch(() => {});
      else await store.moveTask(task.id, "running", now()).catch(() => {});
      const resumeNote = parkedPickup
        ? "resuming automatically — an impact judge will decide whether the owner is needed; no owner input yet"
        : parkedMerge
          ? "merge conflict auto-resume: resuming automatically; the builder resolves the conflict — no owner input needed"
          : parkedVerify
            ? "verification auto-resume: resuming automatically; re-running verification (a fresh-worktree/environment failure passes on re-run — do not edit tests or the pipeline to force it) — no owner input needed; if verification fails again, the task parks for the owner"
            : "resuming automatically; no owner input needed (interruption or builder timeout — the factory reiterates on its own)";
      await store
        .appendPrompt(task.id, {
          at: now(),
          kind: "system",
          text: resumeNote,
        })
        .catch(() => {});
      task.state = "running";
      resumed.push(task.id);
    }
  }
  const running = runningCount(tasks, active);
  const cap: Capacity = {
    running,
    maxParallelTasks: opts.maxParallelTasks,
    freeRamMb: freeRamMb(),
    ramFloorMb: opts.ramFloorMb,
  };
  const available = tasks.filter((t) => !active.has(t.id));
  const launched: string[] = [];
  if (opts.launchPlan) {
    for (const task of selectPlanDispatch(available, cap)) {
      if (probing && (launched.length >= 1 || resumed.length >= 1)) break; // resumed task is the probe
      active.add(task.id);
      launched.push(task.id);
      void opts
        .launchPlan(task.id)
        .catch(() => {})
        .finally(() => active.delete(task.id));
    }
  }
  // Prerequisite gate: approved tasks are considered in queue-priority
  // order and each is checked against current HEAD before it takes a
  // slot. A task whose plan-stated predecessor is missing stays planned
  // (deferred, no builder, no attempt) and the slot goes to the next
  // ready task — post-slice filtering could not fill the vacancy.
  const ordered = selectDispatch(available, {
    running: 0,
    maxParallelTasks: available.length,
    freeRamMb: cap.freeRamMb,
    ramFloorMb: cap.ramFloorMb,
  });
  let slots = Math.max(0, opts.maxParallelTasks - running - launched.length);
  for (const task of ordered) {
    if (slots <= 0) break;
    if (probing && (launched.length >= 1 || resumed.length >= 1)) break; // resumed task is the probe
    const verdict = await gatePrereqsForDispatch(store, task, now());
    if (verdict !== "proceed") continue; // deferred/escalated/malformed: recorded, out of this tick
    active.add(task.id);
    launched.push(task.id);
    slots -= 1;
    void runTaskPipeline(task.id, opts)
      .catch(() => {})
      .finally(() => active.delete(task.id));
  }
  // Resumed orphans already hold their parallel slot (they were counted
  // as running), so they relaunch directly, not through the queue.
  for (const id of resumed) {
    if (probing && launched.length >= 1) break; // one probe only
    active.add(id);
    launched.push(id);
    void runTaskPipeline(id, opts)
      .catch(() => {})
      .finally(() => active.delete(id));
  }
  return launched;
}

/**
 * Latest diff of everything done for this task, against its base commit.
 * A pooled worktree snapshots its diff when the slot is released, so a
 * finished task keeps its diff even after the slot is reused.
 */
/**
 * What the worker has touched so far: changed files in the task worktree
 * (git status), newest first — the head of the list is what it edited
 * most recently. Empty until a worktree exists.
 */
export function worktreeActivity(task: Task): {
  file: string;
  status: string;
  modifiedAt: string;
}[] {
  if (!task.worktree || !existsSync(task.worktree)) return [];
  try {
    const status = execSync("git status --porcelain --untracked-files=all", {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: 10_000,
    });
    const rows = status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2).trim() || "??";
        const file = line.slice(3).trim().replace(/^"|"$/g, "").split(" -> ").pop() ?? "";
        let modifiedAt = "";
        try {
          modifiedAt = statSync(join(task.worktree, file)).mtime.toISOString();
        } catch {
          /* deleted file */
        }
        return {
          file,
          status: code,
          modifiedAt,
        };
      })
      .filter((r) => r.file);
    return rows.sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || "")).slice(0, 50);
  } catch {
    return [];
  }
}

export function taskDiff(task: Task): string {
  if (!task.worktree) return "";
  try {
    const snapshot = readFileSync(diffSnapshotPath(task), "utf8");
    if (snapshot) return snapshot;
  } catch {
    // no snapshot: read the live worktree below
  }
  if (!existsSync(task.worktree)) return "";
  const base = task.baseCommit || "HEAD";
  try {
    const diff = execSync(`git diff ${base}`, {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const status = execSync("git status --short", {
      cwd: task.worktree,
      encoding: "utf8",
      timeout: 15_000,
    });
    return [
      `--- git status --short ---`,
      status.trim(),
      `--- git diff ${base} ---`,
      diff,
    ]
      .join("\n")
      .slice(0, 100_000);
  } catch {
    return "";
  }
}
