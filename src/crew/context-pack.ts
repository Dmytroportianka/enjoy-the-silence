import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FactoryStore } from "./store";
import type { Project, Task } from "./task";

// Inter-station context pack: assemble the (role-specific) raw context a
// station needs once, cache it by a content hash, and reuse it on retries
// and re-runs. The pack is a DETERMINISTIC CONCATENATION of raw inputs —
// never an LLM summary — so that red-team/QC keep their independent
// judgment (see CACHING_PLAN.md guardrails). Per-role slices ensure a station
// never receives another role's framing.

export type ContextRole =
  | "planner"
  | "builder"
  | "qc"
  | "redteam"
  | "outsider"
  | "coder"
  | "reviewer"
  | "fixer"
  | "retro";

export interface ContextPackInputs {
  role: ContextRole;
  taskId: string;
  task: Task;
  project: Project | null;
  plan: string; // full approved plan (may be empty for planner)
  decisions: string; // decisions.md content
  patterns: string; // PATTERNS.md content
  souls: string; // role-relevant soul text (already selected by caller)
  fileList: string; // "Files:\n..." from extractContext
  settledDecisions?: string; // owner answers already given
  diffStat?: string;
  touchedFiles?: string[];
  extra?: string; // station-specific tail (e.g. failure detail)
}

// Which sections each role actually receives. Anything not listed is omitted,
// so a role never inherits another role's framing.
const ROLE_SECTIONS: Record<ContextRole, string[]> = {
  planner: [
    "task",
    "project",
    "decisions",
    "patterns",
    "souls",
    "fileList",
  ],
  builder: [
    "task",
    "planBrief",
    "settledDecisions",
    "patterns",
    "souls",
    "fileList",
  ],
  qc: [
    "task",
    "planBrief",
    "successCriteria",
    "patterns",
    "souls",
    "fileList",
    "diffStat",
  ],
  redteam: [
    "task",
    "plan",
    "decisions",
    "patterns",
    "souls",
    "fileList",
  ],
  outsider: [
    "task",
    "plan",
    "decisions",
    "patterns",
    "souls",
    "fileList",
  ],
  coder: [
    "task",
    "planBrief",
    "diffStat",
    "touchedFiles",
    "patterns",
    "souls",
    "fileList",
  ],
  reviewer: [
    "task",
    "planBrief",
    "diffStat",
    "touchedFiles",
    "patterns",
    "souls",
    "project",
  ],
  fixer: [
    "task",
    "planBrief",
    "settledDecisions",
    "patterns",
    "souls",
    "fileList",
    "extra",
  ],
  retro: [
    "task",
    "planBrief",
    "decisions",
    "souls",
    "fileList",
    "extra",
  ],
};

export interface ContextPackMeta {
  key: string;
  role: ContextRole;
  createdAt: string;
  version: number;
}

export const CONTEXT_PACK_VERSION = 3; // v3: volatile task fields (state/attempts) left the key and content

/** Strip a plan down to its execution brief (mirrors dispatch.executionBrief). */
function planBrief(plan: string, cap = 6000): string {
  const BRIEF_KEEP =
    /intent|why|approach|success|steps?|implementation|scope|visual|screenshot|deferred/i;
  const BRIEF_DROP = /red-team|redteam|questions for the owner|decisions/i;
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
  return brief.length > cap ? `${brief.slice(0, cap)}\n[brief truncated at ${cap} chars]` : brief;
}

function successCriteria(plan: string): string {
  // Pull the "Success criteria" section verbatim if present.
  const match = plan.match(/#{1,3}\s*success criteria[\s\S]*?(?=\n#{1,3}\s|$)/i);
  return match ? match[0].trim() : "";
}

function sectionTask(i: ContextPackInputs): string {
  const t = i.task;
  return [
    `Task: ${t.title}`,
    `Prompt: ${t.prompt}`,
    // No state/attempts here: they change on every dispatch and retry,
    // and a pack whose bytes change can be neither disk-cached nor
    // prefix-cached by the API. Lane/type are semantic and stay.
    `Lane: ${t.lane ?? "default"} | Type: ${t.taskType}`,
    t.tags?.length ? `Tags: ${t.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sectionProject(i: ContextPackInputs): string {
  const p = i.project;
  if (!p) return "";
  return [
    `Project: ${p.name}`,
    p.description ? `Description: ${p.description}` : "",
    p.businessPlan ? `Business plan: ${p.businessPlan}` : "",
    p.rules ? `Rules: ${p.rules}` : "",
    p.goals?.length ? `Goals: ${p.goals.join("; ")}` : "",
    p.testMode ? `Test mode: ${p.testMode}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Cap a section so no single input (a long decisions.md, a big file list,
// a sprawling PATTERNS.md) can balloon the pack. Truncation is mechanical
// (head slice + marker) — never an LLM summary, per CACHING_PLAN guardrails.
function cap(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[truncated at ${max} chars]`;
}

// Overall ceiling for one context pack. Builder/QC/etc. receive at most this
// much stable context; the variable tail (instruction, diff) is appended
// after it. Keeps a single station from ingesting hundreds of thousands of
// tokens of stable text on top of its growing session history.
const PACK_CAP = 24_000;

function buildSections(i: ContextPackInputs): Record<string, string> {
  return {
    task: cap(sectionTask(i), 2_000),
    project: cap(sectionProject(i), 2_000),
    plan: cap(i.plan.trim(), 12_000),
    planBrief: planBrief(i.plan),
    successCriteria: cap(successCriteria(i.plan), 2_000),
    decisions: cap(i.decisions.trim(), 3_000),
    patterns: cap(i.patterns.trim(), 4_000),
    souls: cap(i.souls.trim(), 2_000),
    fileList: cap(i.fileList.trim(), 3_000),
    settledDecisions: cap((i.settledDecisions ?? "").trim(), 2_000),
    diffStat: cap((i.diffStat ?? "").trim(), 4_000),
    touchedFiles: cap((i.touchedFiles ?? []).join("\n").trim(), 2_000),
    extra: cap((i.extra ?? "").trim(), 4_000),
  };
}

export function buildContextPack(i: ContextPackInputs): string {
  const sections = buildSections(i);
  const wanted = ROLE_SECTIONS[i.role] ?? [];
  const out: string[] = [
    `# Context pack — role: ${i.role} (task ${i.taskId})`,
    "",
  ];
  const LABELS: Record<string, string> = {
    task: "Task",
    project: "Project",
    plan: "Plan",
    planBrief: "Plan (execution brief)",
    successCriteria: "Success criteria",
    decisions: "Decisions",
    patterns: "Patterns",
    souls: "Souls",
    fileList: "Files",
    settledDecisions: "Settled decisions",
    diffStat: "Diff stat",
    touchedFiles: "Touched files",
    extra: "Extra",
  };
  for (const key of wanted) {
    const body = sections[key];
    if (!body) continue;
    out.push(`## ${LABELS[key] ?? key}`);
    out.push(body);
    out.push("");
  }
  const joined = out.join("\n").trim();
  if (joined.length <= PACK_CAP) return joined;
  return `${joined.slice(0, PACK_CAP)}\n\n[context pack truncated at ${PACK_CAP} chars]`;
}

export function contextPackKey(i: ContextPackInputs): string {
  // Canonical, stable serialization of the inputs that affect the pack.
  const canonical = JSON.stringify({
    role: i.role,
    taskId: i.taskId,
    // Volatile fields (state, attempts, updatedAt) are deliberately NOT
    // part of the key: they change between planning, dispatch and every
    // retry without changing what a station needs to know, and keying on
    // them made every retry a cache miss (and a new API prefix).
    task: {
      title: i.task.title,
      prompt: i.task.prompt,
      lane: i.task.lane,
      taskType: i.task.taskType,
      tags: i.task.tags,
      plan: i.task.plan,
    },
    project: i.project
      ? {
          id: i.project.id,
          name: i.project.name,
          description: i.project.description,
          businessPlan: i.project.businessPlan,
          rules: i.project.rules,
          goals: i.project.goals,
          testMode: i.project.testMode,
          smeSoul: i.project.smeSoul,
          coderSoul: i.project.coderSoul,
        }
      : null,
    plan: i.plan,
    decisions: i.decisions,
    patterns: i.patterns,
    souls: i.souls,
    fileList: i.fileList,
    settledDecisions: i.settledDecisions ?? "",
    diffStat: i.diffStat ?? "",
    touchedFiles: i.touchedFiles ?? [],
    extra: i.extra ?? "",
    version: CONTEXT_PACK_VERSION,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function contextPackFileName(role: ContextRole): string {
  return `context.${role}.md`;
}

export function contextPackMetaFileName(role: ContextRole): string {
  return `context.${role}.meta.json`;
}

export async function readContextPack(
  store: FactoryStore,
  taskId: string,
  role: ContextRole,
): Promise<{
  content: string;
  key: string;
  hit: boolean;
} | null> {
  const dir = join(store.dir, "tasks", taskId);
  const metaPath = join(dir, contextPackMetaFileName(role));
  const contentPath = join(dir, contextPackFileName(role));
  try {
    const metaRaw = await Bun.file(metaPath)
      .json()
      .catch(() => null);
    const meta = metaRaw as ContextPackMeta | null;
    if (!meta || typeof meta.key !== "string") return null;
    const content = await Bun.file(contentPath)
      .text()
      .catch(() => null);
    if (content === null) return null;
    return {
      content,
      key: meta.key,
      hit: true,
    };
  } catch {
    return null;
  }
}

export async function writeContextPack(
  store: FactoryStore,
  taskId: string,
  role: ContextRole,
  content: string,
  key: string,
): Promise<void> {
  const dir = join(store.dir, "tasks", taskId);
  mkdirSync(dir, {
    recursive: true,
  });
  const meta: ContextPackMeta = {
    key,
    role,
    createdAt: new Date().toISOString(),
    version: CONTEXT_PACK_VERSION,
  };
  await Bun.write(join(dir, contextPackFileName(role)), content);
  await Bun.write(join(dir, contextPackMetaFileName(role)), JSON.stringify(meta, null, 2));
}

export async function invalidateContextPack(
  store: FactoryStore,
  taskId: string,
  role?: ContextRole,
): Promise<void> {
  const dir = join(store.dir, "tasks", taskId);
  if (role) {
    try {
      rmSync(join(dir, contextPackFileName(role)), {
        force: true,
      });
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(dir, contextPackMetaFileName(role)), {
        force: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  // Invalidate all roles.
  const { readdirSync } = await import("node:fs");
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("context.") && (name.endsWith(".md") || name.endsWith(".meta.json"))) {
        try {
          rmSync(join(dir, name), {
            force: true,
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir missing */
  }
}

// Convenience: read-or-build. Returns { content, key, hit }.
export async function getContextPack(
  store: FactoryStore,
  inputs: ContextPackInputs,
): Promise<{
  content: string;
  key: string;
  hit: boolean;
}> {
  const key = contextPackKey(inputs);
  const cached = await readContextPack(store, inputs.taskId, inputs.role);
  if (cached && cached.key === key) {
    return {
      content: cached.content,
      key,
      hit: true,
    };
  }
  const content = buildContextPack(inputs);
  await writeContextPack(store, inputs.taskId, inputs.role, content, key);
  return {
    content,
    key,
    hit: false,
  };
}
