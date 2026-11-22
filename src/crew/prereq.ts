// Plan-stated prerequisites: a task whose approved plan declares it builds
// on a predecessor commit or symbol must not burn builder iterations when
// that predecessor is not in the base yet. The planner writes an explicit
// "## prerequisites" section (see the planner card in dispatch.ts); this
// module parses that section, checks each item against a base commit, and
// formats/parses the keyed deferral notes dispatchTick counts.
//
// Presence bar (deliberate): a commit is present when it is an ancestor of
// the base; a symbol is present when `git grep` finds it in the base tree.
// That is what "the predecessor landed" observably means at dispatch time,
// with known limits: grep can false-pass on a comment mention, and a
// renamed symbol or a rewritten short hash can false-defer. Deeper fitness
// (exported, typechecks, behaves) is the builder's and reviewers' job.

import { execFileSync } from "node:child_process";

export const PREREQ_KINDS = [
  "commit",
  "symbol",
  "pending",
] as const;
export type PrereqKind = (typeof PREREQ_KINDS)[number];

export interface PrereqItem {
  kind: PrereqKind;
  value: string; // commit: sha as written; symbol: name; pending: free text
  path?: string; // symbol only: the `in <path>` scope, repo-rooted
  line: number; // 1-based plan line, so malformed notes can quote it
}

export interface PrereqParse {
  present: boolean; // a ## prerequisites section exists at all
  items: PrereqItem[];
  malformed: string[]; // reasons; non-empty means the task must not dispatch
}

/** Deferrals before dispatchTick escalates to blocked (tick count, not time). */
export const PREREQ_DEFERRAL_LIMIT = 3;

export const PREREQ_DEFER_PREFIX = "prereq deferred:";
export const PREREQ_MISSING_PREFIX = "prereq-missing:";
export const PREREQ_MALFORMED_PREFIX = "prereq malformed:";
export const PREREQ_BLOCKED_PREFIX = "prereq blocked:";
export const PREREQ_OVERRIDE_PREFIX = "prereq override:";

const SECTION_RE = /^##\s*prerequisites?\s*$/i;
const COMMIT_RE = /^commit\s*:\s*([0-9a-f]{7,40})$/i;
const SYMBOL_RE = /^symbol\s*:\s*(.+)$/i;
const PENDING_RE = /^pending\s*:\s*(.+)$/i;

/** Canonical identity of one item, used to compare missing sets across ticks. */
export function prereqKey(item: PrereqItem): string {
  if (item.kind === "commit") return `commit:${item.value.toLowerCase()}`;
  if (item.kind === "symbol") return `symbol:${item.value}${item.path ? ` in ${item.path}` : ""}`;
  return `pending:${item.value.trim()}`;
}

/** Canonical identity of a missing set, so a changed set resets the count. */
export function prereqSetKey(keys: readonly string[]): string {
  return [
    ...keys,
  ]
    .sort()
    .join("\n");
}

/** Human phrase for one item in deferral/blocked notes. */
export function describePrereq(item: PrereqItem): string {
  if (item.kind === "commit") return `commit ${item.value.slice(0, 7)}`;
  if (item.kind === "symbol") return `symbol ${item.value}${item.path ? ` in ${item.path}` : ""}`;
  return `pending prerequisite (${item.value.trim().slice(0, 120)})`;
}

/**
 * Pull the explicit "## prerequisites" section out of a plan. No section
 * means no gate (present: false). A section whose lines do not parse is
 * malformed — a visible signal, never a silent pass and never a silent
 * no-gate. Only bullets directly under the section are read; prose there
 * is malformed too, so a dependency stated as free text cannot slip past.
 */
export function parsePlanPrereqs(plan: string): PrereqParse {
  const lines = plan.split("\n");
  const head = lines.findIndex((l) => SECTION_RE.test(l.trim()));
  if (head === -1)
    return {
      present: false,
      items: [],
      malformed: [],
    };
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+\S/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const items: PrereqItem[] = [];
  const malformed: string[] = [];
  let bullets = 0;
  for (let i = head + 1; i < end; i++) {
    if (collectSectionLine(lines[i] ?? "", i + 1, items, malformed)) bullets += 1;
  }
  if (!bullets && !malformed.length) malformed.push("the section lists no prerequisites");
  return {
    present: true,
    items,
    malformed,
  };
}

/** One raw section line into the buckets; true when it counted as a bullet. */
function collectSectionLine(
  raw: string,
  line: number,
  items: PrereqItem[],
  malformed: string[],
): boolean {
  if (!raw.trim()) return false;
  const parsed = parseBullet(raw, line);
  if (parsed.item) items.push(parsed.item);
  else malformed.push(parsed.error);
  return parsed.item !== null || parsed.bullet;
}

interface BulletParse {
  item: PrereqItem | null;
  bullet: boolean; // the line was a bullet, even when it did not parse
  error: string;
}

function parseSymbolBullet(bullet: string, line: number): BulletParse {
  const body = SYMBOL_RE.exec(bullet)?.[1]?.trim() ?? "";
  const inAt = body.toLowerCase().lastIndexOf(" in ");
  const name = (inAt === -1 ? body : body.slice(0, inAt)).trim();
  const path = (inAt === -1 ? "" : body.slice(inAt + 4)).trim();
  if (!name)
    return {
      item: null,
      bullet: true,
      error: `line ${line}: symbol has no name`,
    };
  return {
    item: {
      kind: "symbol",
      value: name,
      path: path || undefined,
      line,
    },
    bullet: true,
    error: "",
  };
}

function parsePendingBullet(bullet: string, line: number): BulletParse {
  const pending = PENDING_RE.exec(bullet)?.[1]?.trim() ?? "";
  if (!pending)
    return {
      item: null,
      bullet: true,
      error: `line ${line}: pending: names nothing to wait on`,
    };
  return {
    item: {
      kind: "pending",
      value: pending,
      line,
    },
    bullet: true,
    error: "",
  };
}

/** One section line: a prereq item, or a malformed reason (never silent). */
function parseBullet(raw: string, line: number): BulletParse {
  const bullet = /^\s*[-*]\s+(.*)$/.exec(raw)?.[1]?.trim() ?? "";
  if (!bullet)
    return {
      item: null,
      bullet: false,
      error: `line ${line}: not a "- " bullet: ${raw.trim().slice(0, 80)}`,
    };
  const commit = COMMIT_RE.exec(bullet)?.[1] ?? "";
  if (commit)
    return {
      item: {
        kind: "commit",
        value: commit,
        line,
      },
      bullet: true,
      error: "",
    };
  if (/^symbol/i.test(bullet)) return parseSymbolBullet(bullet, line);
  if (/^pending/i.test(bullet)) return parsePendingBullet(bullet, line);
  if (/^commit\s*:/i.test(bullet))
    return {
      item: null,
      bullet: true,
      error: `line ${line}: commit must be 7-40 hex chars: ${bullet.slice(0, 80)}`,
    };
  return {
    item: null,
    bullet: true,
    error: `line ${line}: use "- commit: <sha>", "- symbol: <name>" or "- pending: <what>": ${bullet.slice(0, 80)}`,
  };
}

function gitStatus(repo: string, args: readonly string[]): number | null {
  try {
    execFileSync(
      "git",
      [
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return 0;
  } catch (err) {
    const status = (
      err as {
        status?: number | null;
      }
    ).status;
    return typeof status === "number" ? status : null;
  }
}

function gitOut(repo: string, args: readonly string[]): string | null {
  try {
    return execFileSync(
      "git",
      [
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
      },
    ).trim();
  } catch {
    return null;
  }
}

export interface PrereqCheckResult {
  missing: string[]; // prereqKeys absent from the base
  unknown: string[]; // could not be checked (infra); the caller proceeds
  base: string; // resolved base commit ("" when unreadable)
}

/**
 * Check each item against the base commit. A named commit that is not an
 * ancestor of the base (or names no object at all) is missing; a symbol
 * `git grep` cannot find in the base tree is missing; a pending: line is
 * always missing — its predecessor is not yet knowable. When the base
 * itself is unreadable nothing is proven: every item is unknown and the
 * caller proceeds, the same fail-open the stale-plan gate uses for an
 * unreadable repo.
 */
export function checkPrereqs(
  repo: string,
  base: string,
  items: readonly PrereqItem[],
): PrereqCheckResult {
  const resolved =
    base ||
    gitOut(repo, [
      "rev-parse",
      "HEAD",
    ]) ||
    "";
  if (!resolved)
    return {
      missing: [],
      unknown: items.map((i) => prereqKey(i)),
      base: "",
    };
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const item of items) {
    const verdict = checkOneItem(repo, resolved, item);
    if (verdict === "present") continue;
    if (verdict === "missing") missing.push(prereqKey(item));
    else unknown.push(prereqKey(item));
  }
  return {
    missing,
    unknown,
    base: resolved,
  };
}

type ItemVerdict = "present" | "missing" | "unknown";

/** One item against a resolved base: ancestry for commits, git grep for symbols. */
function checkOneItem(repo: string, base: string, item: PrereqItem): ItemVerdict {
  if (item.kind === "pending") return "missing";
  if (item.kind === "commit") {
    const status = gitStatus(repo, [
      "merge-base",
      "--is-ancestor",
      item.value,
      base,
    ]);
    if (status === 0) return "present";
    return status === null ? "unknown" : "missing";
  }
  const args: string[] = [
    "grep",
    "-F",
    "-q",
    "-e",
    item.value,
    base,
    "--",
    item.path ?? ".",
  ];
  const status = gitStatus(repo, args);
  if (status === 0) return "present";
  return status === 1 ? "missing" : "unknown";
}

export interface DeferralRecord {
  missing: string[];
  base: string;
}

/** Machine trailer of a deferral note, or null when the note is not one. */
export function parseDeferralNote(text: string): DeferralRecord | null {
  if (!text.startsWith(PREREQ_DEFER_PREFIX)) return null;
  const trailer = text
    .split("\n")
    .find((l) => l.startsWith(PREREQ_MISSING_PREFIX))
    ?.slice(PREREQ_MISSING_PREFIX.length)
    .trim();
  if (!trailer) return null;
  try {
    const raw: unknown = JSON.parse(trailer);
    if (typeof raw !== "object" || raw === null) return null;
    const { missing, base } = raw as {
      missing?: unknown;
      base?: unknown;
    };
    if (!Array.isArray(missing) || !missing.every((m) => typeof m === "string")) return null;
    if (typeof base !== "string") return null;
    return {
      missing,
      base,
    };
  } catch {
    return null;
  }
}

export interface PromptLike {
  kind: string;
  text: string;
}

/**
 * The trailing run of deferral notes for this exact missing set — the
 * escalation window. Any other note (owner reply, another gate, a pass
 * that later regressed) breaks consecutiveness, and a changed missing
 * set restarts the count at zero.
 */
export function consecutiveDeferrals(
  prompts: readonly PromptLike[],
  setKey: string,
): DeferralRecord[] {
  const run: DeferralRecord[] = [];
  for (let i = prompts.length - 1; i >= 0; i--) {
    const record = parseDeferralNote(prompts[i]?.text ?? "");
    if (!record || prereqSetKey(record.missing) !== setKey) break;
    run.unshift(record);
  }
  return run;
}

/**
 * Scoped single-use owner override, borrowed from the stale-plan gate's
 * phrase: the latest human reply says "proceed anyway" and no prereq note
 * was recorded after it. The override note the caller records consumes it
 * exactly once. The pipeline re-check passes ignoreReceipts: the tick's
 * receipt must not consume the override before the same dispatch's
 * pipeline runs — the pipeline records its own receipt, which consumes
 * later ticks.
 */
export function ownerOverrideAfter(
  prompts: readonly PromptLike[],
  ignoreReceipts = false,
): boolean {
  let lastUser = -1;
  let lastPrereq = -1;
  prompts.forEach((p, i) => {
    if (p.kind === "user" && /proceed anyway/i.test(p.text)) lastUser = i;
    if (
      p.text.startsWith(PREREQ_DEFER_PREFIX) ||
      p.text.startsWith(PREREQ_MALFORMED_PREFIX) ||
      p.text.startsWith(PREREQ_BLOCKED_PREFIX) ||
      (!ignoreReceipts && p.text.startsWith(PREREQ_OVERRIDE_PREFIX))
    )
      lastPrereq = i;
  });
  return lastUser !== -1 && lastUser > lastPrereq;
}

/** One-line human reason plus the machine trailer the next tick parses. */
export function deferralNote(
  items: readonly PrereqItem[],
  missing: readonly string[],
  base: string,
  origin: string,
): string {
  const names = items
    .filter((i) => missing.includes(prereqKey(i)))
    .map((i) => describePrereq(i))
    .join(", ");
  const short = base ? base.slice(0, 7) : "(unknown base)";
  return `${PREREQ_DEFER_PREFIX} plan requires ${names} — not in base ${short} (${origin}), so no builder started; the task stays planned and retries automatically.${"\n"}${PREREQ_MISSING_PREFIX} ${JSON.stringify(
    {
      missing: [
        ...missing,
      ].sort(),
      base,
    },
  )}`;
}

export function malformedNote(malformed: readonly string[], origin: string): string {
  return `${PREREQ_MALFORMED_PREFIX} the plan's ## prerequisites section cannot be checked (${origin}): ${malformed.join("; ")}. Fix the section to "- commit: <sha>", "- symbol: <name>" or "- pending: <what>" (or drop it when independent) and send the task back to planned.`;
}

export function blockedNote(
  items: readonly PrereqItem[],
  missing: readonly string[],
  base: string,
  history: readonly DeferralRecord[],
): string {
  const names = items
    .filter((i) => missing.includes(prereqKey(i)))
    .map((i) => describePrereq(i))
    .join(", ");
  const short = base ? base.slice(0, 7) : "(unknown base)";
  const prior = history.map((h) => h.missing.join(", ")).join(" / ");
  return `${PREREQ_BLOCKED_PREFIX} ${names} still missing from base ${short} after ${PREREQ_DEFERRAL_LIMIT} consecutive deferrals (stored deferrals waited on: ${prior || "none parsed"}). Land the predecessor or drop the prerequisite from the plan, then send the task back to planned.`;
}
