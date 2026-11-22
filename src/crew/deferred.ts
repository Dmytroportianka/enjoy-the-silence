import { z } from "zod";
import type { Task } from "./task";

// Deferred minor red-team points: a red-team point tagged MINOR does not
// bounce the plan through a reviser + re-review round. It is written to
// a per-project deferred list (Inbox-visible, owner-dismissible), and
// when a later task looks related, the point returns as a blocking plan
// question — the owner answers include/skip, and an included point is
// folded into that task's plan (marked [deferred:<id>] so the factory
// can close it deterministically). MAJOR points keep today's flow.

export const DeferredPointSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceTaskId: z.string().default(""),
  sourceTitle: z.string().default(""),
  text: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  at: z.string().min(1),
  status: z
    .enum([
      "open",
      "dismissed",
      "included",
    ])
    .default("open"),
  includedInTaskId: z.string().default(""),
});
export type DeferredPoint = z.infer<typeof DeferredPointSchema>;

export interface RedteamPoints {
  majors: string[];
  minors: string[];
}

/**
 * Parse a red-team reply into MAJOR/MINOR points. Tagged lines win:
 * "- MAJOR: ..." / "- MINOR: ..." (bullet and colon optional variants).
 * On a REJECT, an untagged point line counts as MAJOR — deferral must be
 * an explicit judgment, never a parse accident. On a PASS, untagged
 * prose is not a point at all.
 */
export function parseRedteamPoints(text: string, verdict: "pass" | "reject"): RedteamPoints {
  const majors: string[] = [];
  const minors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const tagged = /^(?:[-*]\s*)?(MAJOR|MINOR)\s*[:—-]\s*(.+)$/i.exec(line);
    if (tagged) {
      const point = (tagged[2] ?? "").trim();
      if (point) ((tagged[1] ?? "").toUpperCase() === "MINOR" ? minors : majors).push(point);
      continue;
    }
    const untagged = untaggedMajor(line, verdict);
    if (untagged) majors.push(untagged);
  }
  return {
    majors,
    minors,
  };
}

function untaggedMajor(line: string, verdict: "pass" | "reject"): string {
  if (verdict !== "reject") return "";
  const bullet = /^(?:[-*]\s+|\d+[.)]\s+)(.+)$/.exec(line);
  const body = (bullet?.[1] ?? "").trim();
  if (!body || /^(pass|reject)\b/i.test(body)) return "";
  if (/^(because|however|overall|in summary|note that)\b/i.test(body)) return "";
  return body;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "should",
  "would",
  "could",
  "when",
  "then",
  "than",
  "into",
  "from",
  "have",
  "has",
  "will",
  "must",
  "only",
  "also",
  "more",
  "less",
  "over",
  "under",
  "about",
  "which",
  "there",
  "their",
  "them",
  "then",
  "been",
  "were",
  "are",
  "was",
  "not",
  "but",
  "plan",
  "task",
  "point",
  "minor",
  "major",
  "add",
  "use",
  "make",
  "made",
  "work",
  "code",
]);

export function keywordsFor(text: string, tags: string[] = []): string[] {
  const words = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]{3,}/g)) {
    const w = m[0].replace(/[-_]+/g, " ");
    for (const part of w.split(" ")) if (part.length >= 4 && !STOPWORDS.has(part)) words.add(part);
  }
  for (const m of text.matchAll(/[\w.-]+\/[\w./-]+/g)) words.add(m[0].toLowerCase()); // file paths relate strongly
  for (const t of tags) if (t.trim()) words.add(t.trim().toLowerCase());
  return [
    ...words,
  ].slice(0, 24);
}

export function newDeferredPoint(input: {
  id: string;
  projectId: string;
  sourceTaskId: string;
  sourceTitle: string;
  text: string;
  tags: string[];
  at: string;
}): DeferredPoint {
  return DeferredPointSchema.parse({
    ...input,
    keywords: keywordsFor(input.text, input.tags),
    status: "open",
    includedInTaskId: "",
  });
}

/** Open deferred points that look related to a task: shared keywords/tags/paths. */
export function relatedDeferred(points: DeferredPoint[], task: Task, limit = 3): DeferredPoint[] {
  const taskKeys = new Set(keywordsFor(`${task.title} ${task.prompt}`, task.tags));
  const scored: {
    point: DeferredPoint;
    score: number;
  }[] = [];
  for (const point of points) {
    if (point.status !== "open" || point.sourceTaskId === task.id) continue;
    const score = deferredScore(point, task, taskKeys);
    if (score >= 2)
      scored.push({
        point,
        score,
      });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.point.at.localeCompare(b.point.at))
    .slice(0, limit)
    .map((s) => s.point);
}

function deferredScore(point: DeferredPoint, task: Task, taskKeys: Set<string>): number {
  let score = 0;
  for (const k of point.keywords) if (taskKeys.has(k)) score += k.includes("/") ? 3 : 1;
  const taskTags = (task.tags ?? []).map((x) => x.toLowerCase());
  for (const tag of point.tags) if (taskTags.includes(tag.toLowerCase())) score += 2;
  return score;
}

/** The blocking plan question for one deferred point. The marker makes it machine-closeable. */
export function deferredQuestion(point: DeferredPoint): string {
  return `Include this deferred minor point from "${point.sourceTitle || point.sourceTaskId}" in this task? [deferred:${point.id}] "${point.text}" — answer include (it joins this plan) or skip (it stays deferred for a later task).`;
}

export const DEFERRED_MARKER = /\[deferred:([A-Za-z0-9_-]+)\]/g;

/** Ids of deferred points whose marker the (revised) plan now carries = owner included them. */
export function includedDeferredIds(plan: string): string[] {
  return [
    ...plan.matchAll(DEFERRED_MARKER),
  ]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
}
