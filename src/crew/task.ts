import { z } from "zod";

// The user's unit of work, one level above job cards: a stated task with
// its full prompt history and plan-approval state. Stations (builder/QC
// job cards) execute it; the kanban state below is what the dashboard
// shows. Pure logic only — persistence lives in FactoryStore.

export const TASK_STATES = [
  "planned",
  "running",
  "needs-input",
  "in-review",
  "done",
  "blocked",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PLAN_STATES = [
  "none",
  "draft",
  "approved",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const OwedPushSchema = z.object({
  targetRef: z.string().min(1),
  commit: z.string().min(1),
  attempts: z.number().int().min(0).default(0),
  lastError: z.string().default(""),
  nextRetryAt: z.string().default(""),
});
export type OwedPush = z.infer<typeof OwedPushSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  jobId: z.string().min(1), // stations live under jobs/<jobId> in the store
  title: z.string().min(1),
  prompt: z.string().min(1), // the original statement, verbatim
  plan: z.string().default(""),
  planState: z.enum(PLAN_STATES).default("none"),
  planQuestions: z.array(z.string()).default([]), // red-team points the planner left to the owner; block approval
  planBaseCommit: z.string().default(""), // repo HEAD the plan was drafted against; a builder must not implement a plan whose base has moved (stale plan)
  settledQuestions: z.array(z.string()).default([]), // questions the owner already answered — settled decisions, never re-asked in any wording
  planRequested: z.boolean().default(false), // owner asked for a plan; queued planning outranks implementation
  state: z.enum(TASK_STATES).default("planned"),
  worktree: z.string().default(""), // the task's own worktree, set at dispatch
  baseCommit: z.string().default(""), // HEAD the worktree was cut from; diffs are read against it
  decisionsPendingHead: z.string().default(""), // main HEAD whose decisions-file merge changes await the owner
  decisionsAckHead: z.string().default(""), // main HEAD whose decisions-file merge changes the owner accepted
  decisionsBaselineHash: z.string().default(""), // hash of all decisions files at the task's base; unchanged = no decisions check at all
  decisionsChange: z.string().default(""), // proposed decisions.md lines, identified at planning (not at merge); "" = none
  taskType: z
    .enum([
      "general",
      "security",
      "ui",
      "css",
      "backend",
      "docs",
    ])
    .default("general"),
  tags: z.array(z.string()).default([]), // history facets, e.g. cybersecurity, visual-enhancement
  attempts: z.number().int().min(0).default(0), // implementation attempts; retries escalate the tier
  // Triage, evaluated by one cheap station before planning: how big the
  // task is and which process lane it earns. The lane can only reduce
  // ceremony (red-teams, approval), never gates. Empty = not triaged
  // yet / owner has not overridden. The owner may set lane manually.
  lane: z
    .enum([
      "",
      "fast",
      "standard",
      "careful",
    ])
    .default(""),
  triage: z.string().default(""), // one-line verdict: size, risk flags, effort estimate
  retroReviewedAt: z.string().default(""), // when the owner reviewed the retro and closed the feature; empty = retro still open
  // Visual Review (screenshot diffs): none until the stage runs, pending
  // while the owner must approve/request changes, approved/passed when
  // the gate may land, changes-requested while the builder reworks.
  // Screenshots themselves live outside git (store tasks/<id>/visual/).
  visualState: z
    .enum([
      "none",
      "pending",
      "passed",
      "approved",
      "changes-requested",
      "skipped",
      "error",
    ])
    .default("none"),
  visualApprovedHashes: z.array(z.string()).default([]), // sha256 of after-PNGs the owner approved; a re-capture must match to pass
  redteams: z.number().int().min(0).max(2).default(2), // how many red-team reviewers the plan gets, decided by triage for this task (0 fast, 1 light, 2 full)
  verifyCommand: z.string().default(""), // how success is proven, e.g. "bun test" or a playwright run
  branchPushPending: OwedPushSchema.nullable().default(null), // owed `git push origin task/<id>` at `commit`
  mainPushPending: OwedPushSchema.nullable().default(null), // owed `git push origin main` at the merge `commit`
  rolledBackAt: z.string().default(""), // when the owner rolled back the landed merge; empty = never rolled back
  revertCommit: z.string().default(""), // the revert commit created by the rollback; empty = none
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * A small, meaningful title from a stated prompt — never just the first
 * 80 characters. Takes the first clause (up to a comma, dash or sentence
 * end), drops request filler ("please", "can you", "we should"), and
 * caps at eight words. Triage may replace this with a better title it
 * writes itself; this is the floor for paths that never triage.
 */
export function deriveTitle(prompt: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const clause =
    firstLine
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/^["“']+|["”']+$/g, "")
      .split(/[.!?]\s/)[0]
      ?.split(/[,;—–]/)[0]
      ?.replace(
        /^(please\s+|can you\s+|could you\s+|we should\s+|i want\s+|need to\s+|let's\s+)/i,
        "",
      )
      .trim() ?? "";
  const words = clause
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ")
    .replace(/[.!?,;:]+$/, "");
  if (!words) return "Untitled task";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Normalized statement identity: case, punctuation and spacing do not make a new task. */
export function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "planned",
  "running",
  "in-review",
  "needs-input",
  "blocked",
]);

/**
 * The existing task a new statement duplicates, if any: same project,
 * still active (not done/failed — restating those is a legitimate
 * retry or new work), and either the same normalized statement or a
 * near-identical one (token Jaccard >= 0.85 over at least 5 tokens).
 * Duplicate active tasks burn parallel slots building the same thing
 * twice and then fight at merge time.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function findDuplicateTask(tasks: Task[], projectId: string, prompt: string): Task | null {
  const norm = normalizePrompt(prompt);
  if (!norm) return null;
  const tokens = new Set(norm.split(" "));
  for (const t of tasks) {
    if (t.projectId !== projectId || !ACTIVE_STATES.has(t.state)) continue;
    const other = normalizePrompt(t.prompt);
    if (other === norm) return t;
    if (tokens.size >= 5) {
      const otherTokens = new Set(other.split(" "));
      let shared = 0;
      for (const tok of tokens) if (otherTokens.has(tok)) shared++;
      const union = tokens.size + otherTokens.size - shared;
      if (union > 0 && shared / union >= 0.85) return t;
    }
  }
  return null;
}

const RETRO_DUP_STATES: ReadonlySet<string> = new Set([
  "planned",
  "running",
  "in-review",
  "needs-input",
  "blocked",
  "done",
]);

/**
 * The existing task a retro finding duplicates, if any. Wider than
 * findDuplicateTask: a retro point must not re-file work that is already
 * done (restating done work is legitimate for an owner-stated task, not
 * for an automatically filed point), and it matches on the finding title
 * as well as the full statement. Failed tasks are excluded — re-filing
 * after a failure is a legitimate retry.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function findRetroDuplicate(
  tasks: Task[],
  projectId: string,
  finding: string,
  excludeId = "",
): Task | null {
  const normFinding = normalizePrompt(finding);
  const title = (finding.split(" — ")[0] ?? finding).trim();
  const normTitle = normalizePrompt(title);
  if (!normTitle) return null;
  const titleTokens = new Set(normTitle.split(" "));
  for (const t of tasks) {
    if (t.projectId !== projectId || t.id === excludeId || !RETRO_DUP_STATES.has(t.state)) continue;
    if (normalizePrompt(t.prompt) === normFinding || normalizePrompt(t.prompt) === normTitle)
      return t;
    const otherTitle = normalizePrompt(t.title);
    if (otherTitle === normTitle) return t;
    if (titleTokens.size >= 4) {
      const otherTokens = new Set(otherTitle.split(" "));
      let shared = 0;
      for (const tok of titleTokens) if (otherTokens.has(tok)) shared++;
      const union = titleTokens.size + otherTokens.size - shared;
      const smaller = Math.min(titleTokens.size, otherTokens.size);
      if (union > 0 && (shared / union >= 0.7 || (shared >= 4 && shared / smaller >= 0.8)))
        return t;
    }
  }
  return null;
}

export const PromptEntrySchema = z.object({
  at: z.string().min(1),
  kind: z.enum([
    "user",
    "agent",
    "system",
  ]),
  text: z.string(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

// A project's manual roadmap board: a lightweight planned/in-progress/
// implemented list the owner keeps by hand. It is intentionally NOT the
// feature flow — a feature is actually built, reviewed and landed through
// the Task pipeline above. The two share the word "feature" but are
// separate; the dashboard labels this "Roadmap" to avoid the collision.
export const FeatureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: z
    .enum([
      "planned",
      "in-progress",
      "implemented",
    ])
    .default("planned"),
  notes: z.string().default(""),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  businessPlan: z.string().default(""), // what the business is and where it is going
  rules: z.string().default(""), // general project rules every agent must respect
  smeSoul: z.string().default(""), // explicit SME persona; derived from the above when empty
  coderSoul: z.string().default(""), // explicit coder-reviewer persona; derived when empty
  goals: z.array(z.string()).default([]),
  moat: z.string().default(""),
  repoPath: z.string().default(""),
  devCommand: z.string().default(""), // e.g. "bun run dev"; empty = dev mode not configured
  devPort: z.number().int().min(0).max(65535).default(0),
  // How the owner tests this system: run it interactively (dev), rely on
  // automated checks only (checks), or take diffs and test/push themselves
  // (push-only). Asked at registration; shapes what agents must prove.
  testMode: z
    .enum([
      "dev",
      "checks",
      "push-only",
    ])
    .default("checks"),
  features: z.array(FeatureSchema).default([]),
  // The commit this data was captured at. The folder keeps moving after
  // that; when HEAD no longer matches, the data is stale, not wrong.
  lastCommit: z.string().default(""),
  lastSyncAt: z.string().default(""),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * The SME's soul for a project: who the subject-matter expert is when
 * judging plans and work. Explicit smeSoul wins; otherwise it is derived
 * from the project's own description, business plan, goals, moat, rules.
 */
/**
 * The coder reviewer's soul: a pragmatic senior engineer for this
 * project. Explicit coderSoul wins; otherwise derived from the project
 * rules and testing mode. (The outsider red-team gets no soul by design.)
 */
export function coderPersona(project: Project): string {
  if (project.coderSoul.trim()) return project.coderSoul.trim();
  if (globalSouls.coder.trim()) return globalSouls.coder.trim();
  const parts = [
    `You are a pragmatic senior coder reviewing work on ${project.name}.`,
    "You care about correctness, tests that actually exercise the change, simplicity over cleverness, and diffs that stay inside the task.",
    project.rules ? `Project rules you enforce without exception: ${project.rules}` : "",
    project.testMode === "dev"
      ? "This project runs interactively: prefer checks a dev can reproduce locally."
      : "",
    project.testMode === "push-only"
      ? "This project cannot be run locally: judge the diff on its face and say what the owner must test by hand."
      : "",
  ].filter(Boolean);
  return parts.join("\n");
}

// Global souls from Settings: used when a project has no soul of its
// own, in place of the built-in composed default. Set by the dashboard
// server at startup and when the owner saves Settings.
let globalSouls: {
  sme: string;
  coder: string;
} = {
  sme: "",
  coder: "",
};
export function setGlobalSouls(souls: { sme?: string; coder?: string }): void {
  globalSouls = {
    sme: String(souls.sme ?? ""),
    coder: String(souls.coder ?? ""),
  };
}
export function getGlobalSouls(): {
  sme: string;
  coder: string;
} {
  return globalSouls;
}

export function smePersona(project: Project): string {
  if (project.smeSoul.trim()) return project.smeSoul.trim();
  if (globalSouls.sme.trim()) return globalSouls.sme.trim();
  const parts = [
    `You are the subject-matter expert for ${project.name}.`,
    project.description ? `Business: ${project.description}` : "",
    project.businessPlan ? `Business plan: ${project.businessPlan}` : "",
    project.goals.length ? `Goals: ${project.goals.join("; ")}` : "",
    project.moat ? `Moat (what makes this defensible): ${project.moat}` : "",
    project.rules ? `General rules you enforce without exception: ${project.rules}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

export function newTask(
  input: {
    id: string;
    projectId: string;
    title: string;
    prompt: string;
    jobId?: string;
  },
  now: string,
): Task {
  return TaskSchema.parse({
    ...input,
    jobId: input.jobId ?? input.id,
    plan: "",
    planState: "none",
    state: "planned",
    worktree: "",
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Record a drafted plan. Only a planned task can receive one. `questions`
 * are red-team points the planner could not decide alone; the owner must
 * answer them before the plan can be approved. A plan the owner writes or
 * edits by hand carries none: editing it is the owner's decision.
 */
export function draftPlan(
  task: Task,
  plan: string,
  now: string,
  questions: string[] = [],
  baseCommit = "",
): Task {
  if (task.state !== "planned")
    throw new Error(`task ${task.id}: cannot draft a plan while ${task.state}`);
  if (!plan.trim()) throw new Error(`task ${task.id}: plan is empty`);
  // Every plan is attached to the last commit hash it was drafted
  // against. Callers that know the repo HEAD pass it; a hand-written
  // plan (dashboard editor) passes "" and keeps any existing pin.
  return {
    ...task,
    plan,
    planState: "draft",
    planQuestions: questions,
    planBaseCommit: baseCommit || task.planBaseCommit,
    updatedAt: now,
  };
}

/** The autonomy gate: nothing dispatches until the owner approves a plan. */
export function approvePlan(task: Task, now: string): Task {
  if (task.state !== "planned")
    throw new Error(`task ${task.id}: cannot approve a plan while ${task.state}`);
  if (task.planState !== "draft") throw new Error(`task ${task.id}: no drafted plan to approve`);
  if (task.planQuestions.length) {
    throw new Error(
      `task ${task.id}: the planner needs your decision on ${task.planQuestions.length} red-team point(s); answer them first`,
    );
  }
  return {
    ...task,
    planState: "approved",
    updatedAt: now,
  };
}

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  planned: [
    "running",
    "blocked",
  ],
  running: [
    "needs-input",
    "in-review",
    "blocked",
    "failed",
    "planned", // prereq deferral: no builder started, back to the queue with the plan still approved
  ],
  "needs-input": [
    "running",
    "blocked",
  ],
  "in-review": [
    "done",
    "planned",
    "running",
    "blocked",
    "failed",
    "needs-input",
  ], // -> running is the internal review bounce; -> needs-input parks for the owner
  blocked: [
    "planned",
  ],
  failed: [
    "planned",
  ],
  done: [],
};

export function transitionTask(task: Task, to: TaskState, now: string): Task {
  if (!TRANSITIONS[task.state].includes(to)) {
    throw new Error(`task ${task.id}: illegal transition ${task.state} -> ${to}`);
  }
  if (task.state === "planned" && to === "running" && task.planState !== "approved") {
    throw new Error(`task ${task.id}: cannot run before the plan is approved`);
  }
  // QC sending work back means a fresh plan must be drafted and approved.
  const planState = task.state === "in-review" && to === "planned" ? "draft" : task.planState;
  return {
    ...task,
    state: to,
    planState,
    updatedAt: now,
  };
}

export type TaskType = Task["taskType"];
export interface Tier {
  name: "cheap" | "standard" | "smart";
  effort: "low" | "medium" | "high";
}

const TIER_LADDER: Tier[] = [
  {
    name: "cheap",
    effort: "low",
  },
  {
    name: "standard",
    effort: "medium",
  },
  {
    name: "smart",
    effort: "high",
  },
];
const BASE_TIER: Record<TaskType, number> = {
  security: 2,
  backend: 1,
  general: 1,
  ui: 0,
  css: 0,
  docs: 0,
};

/**
 * Model/effort selection by task type, escalating one rung per retry and
 * capped at the top: security starts smart, visual work starts cheap.
 * attempt is 0-based (0 = first implementation attempt).
 */
export function tierFor(taskType: TaskType, attempt: number): Tier {
  const idx = Math.min(TIER_LADDER.length - 1, (BASE_TIER[taskType] ?? 1) + Math.max(0, attempt));
  return (
    TIER_LADDER[idx] ?? {
      name: "standard",
      effort: "medium",
    }
  );
}

export interface Capacity {
  running: number; // tasks currently running in parallel (a task's stations run sequentially inside it)
  maxParallelTasks: number; // owner-set cap on tasks running in parallel — NOT a count of agents/stations
  freeRamMb: number; // observed free memory
  ramFloorMb: number; // owner-set floor: dispatch only above this
}

const oldestFirst = (a: Task, b: Task) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Queue priority, highest first:
 * 0 — offload the human: planning the owner asked for (the plan, its
 *     red-team and the questions are work the owner would otherwise do).
 * 1 — push to main: approved work that already has implementation
 *     attempts; finishing and landing it beats starting something new.
 * 2 — fresh approved work.
 * Oldest first inside each tier.
 */
export function priorityRank(task: Task): number {
  if (task.state === "planned" && task.planState === "none" && task.planRequested) return 0;
  if (task.state === "planned" && task.planState === "approved" && task.attempts > 0) return 1;
  return 2;
}

const byPriority = (a: Task, b: Task) => priorityRank(a) - priorityRank(b) || oldestFirst(a, b);

/**
 * Approved tasks in queue-priority order (see priorityRank), as many as
 * capacity allows, none when free RAM is under the floor. Tasks that do
 * not fit stay in `state: "planned"`: that persisted state is the queue,
 * picked up by a later dispatch tick. Pure: callers observe RAM and
 * persist results.
 */
export function selectDispatch(tasks: Task[], cap: Capacity): Task[] {
  if (cap.freeRamMb < cap.ramFloorMb) return [];
  const slots = Math.max(0, cap.maxParallelTasks - cap.running);
  if (slots === 0) return [];
  return tasks
    .filter((t) => t.state === "planned" && t.planState === "approved")
    .sort(byPriority)
    .slice(0, slots);
}

/**
 * Queued planning, oldest first: tasks the owner asked to plan. Planning
 * outranks implementation, so a dispatch tick fills its free slots with
 * these before it launches any approved task.
 */
export function selectPlanDispatch(tasks: Task[], cap: Capacity): Task[] {
  if (cap.freeRamMb < cap.ramFloorMb) return [];
  const slots = Math.max(0, cap.maxParallelTasks - cap.running);
  if (slots === 0) return [];
  return tasks
    .filter((t) => t.state === "planned" && t.planState === "none" && t.planRequested)
    .sort(oldestFirst)
    .slice(0, slots);
}

/** Tasks waiting in the queue for a parallel slot, in pickup order (see priorityRank). */
export function queuedTasks(tasks: Task[]): Task[] {
  return tasks
    .filter(
      (t) =>
        t.state === "planned" &&
        ((t.planState === "none" && t.planRequested) || t.planState === "approved"),
    )
    .sort(byPriority);
}
