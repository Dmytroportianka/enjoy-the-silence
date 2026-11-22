import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Muse preset — probed live 2026-10-21 against `muse exec --help` and an
// echo-provider run, a headless agent preset encodes three facts:
//   command:    muse exec --json "<prompt>"   (one-shot, headless)
//   resume:     muse exec --json --session-id <uuid> "<prompt>"
//   output:     JSONL events; session id is stream.id (kind:"session"),
//               text arrives as payload_type "run.output.delta",
//               final answer is payload_type "run.terminal.completed".
// Plain (non --json) exec prints only the final text. Parse failure falls
// back to raw stdout — never a blank reply.
export const MUSE_PRESET = {
  command: [
    "muse",
    "exec",
    "--json",
  ],
  resumeFlag: "--session-id",
  output: "muse-jsonl",
} as const;

export interface ParsedOutput {
  reply: string;
  sessionId: string | null;
  /** True when the agent's final-answer event arrived, even if the process then exited non-zero. */
  completed: boolean;
}

/** One meaningful fact decoded from a muse JSONL line, or null for non-JSON. */
export interface MuseEventLine {
  kind: "session" | "delta" | "terminal" | "other";
  sessionId?: string;
  text?: string;
  /** Human-readable one-line description for events that are not text. */
  label?: string;
}

/** Decode one muse JSONL line into its live-log meaning. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function describeMuseLine(line: string): MuseEventLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const stream = o.stream as Record<string, unknown> | undefined;
  const sessionId =
    stream?.kind === "session" && typeof stream.id === "string" ? stream.id : undefined;
  const payload = o.payload as Record<string, unknown> | undefined;
  const payloadType = typeof o.payload_type === "string" ? o.payload_type : "";
  const text = typeof payload?.text === "string" ? payload.text : "";
  // Every muse line carries the stream object, so payload_type — not the
  // stream — decides what the line is. The session id is captured from
  // whatever line carries it (a bare session event announces it first).
  if (payloadType === "run.output.delta")
    return {
      kind: "delta",
      sessionId,
      text,
    };
  if (payloadType === "run.terminal.completed")
    return {
      kind: "terminal",
      sessionId,
      text,
    };
  if (sessionId && !payloadType && !text)
    return {
      kind: "session",
      sessionId,
      label: `[session ${sessionId}]`,
    };
  if (payloadType || text) {
    // Tool calls and housekeeping events: name what happened so the live
    // log is readable without the raw JSON. Text, when present, is kept.
    const name =
      typeof payload?.name === "string"
        ? payload.name
        : typeof payload?.type === "string"
          ? payload.type
          : payloadType;
    return {
      kind: "other",
      sessionId,
      label: `[${name}${text ? `: ${text}` : ""}]`.slice(0, 300),
    };
  }
  return null;
}

// Deltas accumulate into a paragraph; flush it when it hits a newline or
// this many chars so the live log updates without one line per token.
const FLUSH_DELTA_CHARS = 160;

/**
 * Incremental muse JSONL parser for the live log: feed chunks as they
 * stream in, get back display lines. Delta text accumulates and flushes
 * on newlines/size so a thinking agent stays visibly alive; session id
 * and final-answer state are captured for the delivery path to reuse.
 * Non-JSON lines (plain stdout from a stub or a broken run) pass through.
 */
export class MuseJsonlParser {
  sessionId: string | null = null;
  completed = false;
  /** All reply text seen so far (deltas + terminal). */
  reply = "";
  private carry = "";
  private pending = "";

  /** Drain pending delta text as one display line (trailing newlines off). */
  private takePending(): string {
    const p = this.pending.replace(/\n+$/, "");
    this.pending = "";
    return p;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  feed(chunk: string): string[] {
    const out: string[] = [];
    this.carry += chunk;
    let idx: number;
    while ((idx = this.carry.indexOf("\n")) >= 0) {
      const line = this.carry.slice(0, idx).replace(/\r$/, "");
      this.carry = this.carry.slice(idx + 1);
      const ev = describeMuseLine(line);
      if (!ev) {
        if (line) out.push(line);
        continue;
      }
      this.sessionId ??= ev.sessionId ?? null;
      if (ev.kind === "session") {
        const p = this.takePending();
        if (p) out.push(p);
        if (ev.label) out.push(ev.label);
      } else if (ev.kind === "delta") {
        this.pending += ev.text ?? "";
        this.reply += ev.text ?? "";
        if (this.pending.includes("\n") || this.pending.length > FLUSH_DELTA_CHARS) {
          const p = this.takePending();
          if (p) out.push(p);
        }
      } else if (ev.kind === "terminal") {
        const p = this.takePending();
        if (p) out.push(p);
        if (ev.text) {
          this.reply += ev.text;
          out.push(ev.text);
        }
        this.completed = true;
      } else {
        const p = this.takePending();
        if (p) out.push(p);
        if (ev.label) out.push(ev.label);
      }
    }
    return out;
  }

  /** Drain anything still buffered (partial line, pending deltas). */
  flush(): string[] {
    const out: string[] = [];
    if (this.carry.trim()) out.push(this.carry);
    this.carry = "";
    const p = this.takePending();
    if (p) out.push(p);
    return out;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function parseMuseOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed)
    return {
      reply: "",
      sessionId: null,
      completed: false,
    };
  let sessionId: string | null = null;
  let terminal = "";
  const deltas: string[] = [];
  let lastText = "";
  let sawJson = false;
  for (const line of trimmed.split("\n")) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    sawJson = true;
    const o = obj as Record<string, unknown>;
    const stream = o.stream as Record<string, unknown> | undefined;
    if (stream?.kind === "session" && typeof stream.id === "string") sessionId = stream.id;
    const payload = o.payload as Record<string, unknown> | undefined;
    const payloadType = typeof o.payload_type === "string" ? o.payload_type : "";
    if (payloadType === "run.output.delta" && typeof payload?.text === "string")
      deltas.push(payload.text);
    else if (payloadType === "run.terminal.completed" && typeof payload?.text === "string")
      terminal = payload.text;
    else if (typeof payload?.text === "string" && /output|assistant|message/.test(payloadType))
      lastText = payload.text;
  }
  if (!sawJson)
    return {
      reply: trimmed,
      sessionId: null,
      completed: false,
    };
  // JSONL with no final answer (killed/crashed mid-stream): never hand the
  // raw event dump back as the reply — it poisons every downstream check.
  return {
    reply: terminal || deltas.join("") || lastText,
    sessionId,
    completed: terminal !== "",
  };
}

/**
 * Token usage for one muse session, summed from its session log
 * (`$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`). Each model
 * call records `payload.event.usage`; the sibling `record.quantity`
 * mirrors the same numbers, so only the usage path is summed. Returns
 * null when the log cannot be found or read — usage is logging, never
 * a reason to fail a station.
 */

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function readSessionUsage(
  sessionId: string,
  sessionsRoot?: string,
): {
  inputTokens: number;
  outputTokens: number;
} | null {
  try {
    const root =
      sessionsRoot ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "muse", "sessions");
    // Session logs live under YYYY/MM/DD/<id>/; a flat <day>/<id>/
    // layout is also accepted so older stores still read.
    const findLog = (dir: string, depth: number): string | null => {
      const direct = join(dir, sessionId, "session.jsonl");
      if (existsSync(direct)) return direct;
      if (depth <= 0) return null;
      for (const entry of readdirSync(dir, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const hit = findLog(join(dir, entry.name), depth - 1);
        if (hit) return hit;
      }
      return null;
    };
    const file = findLog(root, 3);
    if (!file) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let seen = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = (
        (obj as Record<string, unknown>)?.payload as Record<string, unknown> | undefined
      )?.event as Record<string, unknown> | undefined;
      const u = usage?.usage as Record<string, unknown> | undefined;
      if (u && typeof u.input_tokens === "number") {
        inputTokens += u.input_tokens;
        outputTokens += typeof u.output_tokens === "number" ? u.output_tokens : 0;
        seen = true;
      }
    }
    return seen
      ? {
          inputTokens,
          outputTokens,
        }
      : null;
  } catch {
    return null;
  }
}

export const QUOTA_BACKOFF_MS = 30 * 60_000;
export const QUOTA_PROBE_MS = 5 * 60_000;
const QUOTA_RE =
  /rate.?limit|usage limit|quota|too many requests|\b429\b|limit resets|exceeded your.*limit|credits exhausted/i;
/**
 * A token/usage-limit failure is not a code failure: the agent ran out
 * of allowance. Classified separately so the factory can pause and
 * resume after the reset instead of retrying against the wall (or
 * parking for the owner forever). Only meaningful on a failed run.
 */
export function looksLikeQuotaLimit(stdout: string, stderr: string): boolean {
  return QUOTA_RE.test(`${stdout}\n${stderr}`);
}

const EXPIRED_RE =
  /no (conversation|session) found|session.*not.*exist|unable to resume|unknown session/i;
export function looksLikeExpiredSession(stdout: string, stderr: string): boolean {
  return EXPIRED_RE.test(`${stdout}\n${stderr}`);
}

const WORKSPACE_SWITCH_RE = /refusing to resume in workspace|was created in workspace/i;
/** The stored session belongs to another worktree (warm-pool slot moved). */
export function looksLikeWorkspaceSwitch(stdout: string, stderr: string): boolean {
  return WORKSPACE_SWITCH_RE.test(`${stdout}\n${stderr}`);
}

const SESSION_IN_USE_RE = /already in use/i;
/**
 * The stored session is locked by a still-running (or orphaned) agent
 * process from a previous server generation. Its result can never be
 * adopted, so the station must start fresh, like an expired session.
 */
export function looksLikeSessionInUse(stdout: string, stderr: string): boolean {
  return SESSION_IN_USE_RE.test(`${stdout}\n${stderr}`);
}
