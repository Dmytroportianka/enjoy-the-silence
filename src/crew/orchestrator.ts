import { evaluateGates } from "../governance/gates";
import { type DeliveryNote, type JobCard, renderPrompt } from "./jobcard";
import {
  looksLikeExpiredSession,
  looksLikeQuotaLimit,
  looksLikeSessionInUse,
  looksLikeWorkspaceSwitch,
  MuseJsonlParser,
  parseMuseOutput,
  QUOTA_BACKOFF_MS,
  readSessionUsage,
} from "./preset";
import {
  classifyProviderOutcome,
  PROVIDERS,
  type ProviderId,
  type ProviderRoute,
  parseProviderOutput,
  presetSwitchReason,
  type StationPreset,
  validatePreset,
  validateRoute,
} from "./providers";
import type { FactoryStore } from "./store";

// Thin orchestrator: spawn one separate process per station,
// cwd = its isolated worktree, prompt = the rendered job card, hard timeout,
// reply parsed into a delivery note. Kills are scoped to that station's
// own process — never a system-wide pkill.
const running = new Map<
  string,
  {
    kill: () => void;
  }
>();

export function killStation(stationId: string): boolean {
  const h = running.get(stationId);
  if (!h) return false;
  h.kill();
  running.delete(stationId);
  return true;
}

export interface ActiveStation {
  jobId: string;
  stationId: string;
  role: JobCard["role"];
  model: string; // routed model, or "custom command" when a caller overrode it
  effort: string;
  startedAt: string; // ISO: when the current agent process started
  commandLine: string; // exact argv the agent process was spawned with (last arg truncated)
  prompt: string; // the rendered job card the agent was given
  sessionId: string | null; // resumed muse session, when this run resumes one
  outputBytes: number; // stdout+stderr bytes so far; grows while the agent works
}
// Which station is live for a job right now — the dashboard shows this so
// the owner can see what a running task is doing, not just its history.
const activeStations = new Map<string, ActiveStation>();
export function activeStationFor(jobId: string): ActiveStation | null {
  return activeStations.get(jobId) ?? null;
}

/**
 * Live output of one station, buffered for the control room: parsed
 * display lines (for the live log) plus a bounded raw tail (for
 * debugging). The buffer dies with the server process — stations run
 * in-process, so there is nothing to persist; the delivery note keeps
 * the final text on disk. Local-only surface: never reuse this on the
 * :8123 status page, which is the externally reachable one.
 */
export interface StreamLine {
  seq: number;
  at: string;
  text: string;
}
const MAX_STREAM_LINES = 1500;
const MAX_RAW_CHARS = 256_000;

export class StationOutput {
  readonly stationId: string;
  done = false;
  private lines: StreamLine[] = [];
  private nextSeq = 0;
  private raw = "";
  private rawBase = 0; // absolute byte offset of this.raw's first char
  private parsedListeners = new Set<(l: StreamLine) => void>();
  private rawListeners = new Set<(chunk: string, endOffset: number) => void>();
  private doneListeners = new Set<() => void>();

  constructor(stationId: string) {
    this.stationId = stationId;
  }

  /** Append display lines plus the raw bytes they were decoded from. */
  append(lines: string[], rawChunk: string): void {
    if (rawChunk) {
      this.raw += rawChunk;
      if (this.raw.length > MAX_RAW_CHARS) {
        const cut = this.raw.length - MAX_RAW_CHARS;
        this.raw = this.raw.slice(cut);
        this.rawBase += cut;
      }
      const end = this.rawBase + this.raw.length;
      for (const f of this.rawListeners) f(rawChunk, end);
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry: StreamLine = {
        seq: this.nextSeq++,
        at: new Date().toISOString(),
        text: line,
      };
      this.lines.push(entry);
      if (this.lines.length > MAX_STREAM_LINES)
        this.lines.splice(0, this.lines.length - MAX_STREAM_LINES);
      for (const f of this.parsedListeners) f(entry);
    }
  }

  /** The station process ended (or was killed): close all tail readers. */
  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const f of [
      ...this.doneListeners,
    ])
      f();
  }

  /** Buffered lines newer than sinceSeq, oldest first. */
  replayParsed(sinceSeq: number): StreamLine[] {
    return this.lines.filter((l) => l.seq > sinceSeq);
  }

  /** Buffered raw text starting at sinceOffset (absolute byte space). */
  replayRaw(sinceOffset: number): {
    text: string;
    from: number;
    end: number;
  } {
    const from = Math.max(sinceOffset, this.rawBase);
    return {
      text: this.raw.slice(from - this.rawBase),
      from,
      end: this.rawBase + this.raw.length,
    };
  }

  lastLine(): string {
    return this.lines[this.lines.length - 1]?.text ?? "";
  }

  subscribeParsed(f: (l: StreamLine) => void): () => void {
    this.parsedListeners.add(f);
    return () => this.parsedListeners.delete(f);
  }

  subscribeRaw(f: (chunk: string, endOffset: number) => void): () => void {
    this.rawListeners.add(f);
    return () => this.rawListeners.delete(f);
  }

  onDone(f: () => void): () => void {
    this.doneListeners.add(f);
    return () => this.doneListeners.delete(f);
  }
}

const outputs = new Map<string, StationOutput>(); // keyed by stationId
// Subscribers that registered before the station spawned (the output
// object is created when the process starts, not when runStation is
// called): attach them the moment the object exists.
const pendingOutputSubs = new Map<string, Set<(out: StationOutput) => void>>();

/** Watch a station's live output; attaches now if it is mid-run, otherwise
 *  (never ran here, or a previous run already finished) it waits for the
 *  next spawn of that station id. */
export function watchStation(stationId: string, cb: (out: StationOutput) => void): () => void {
  const existing = outputs.get(stationId);
  if (existing && !existing.done) {
    cb(existing);
    return () => {};
  }
  let set = pendingOutputSubs.get(stationId);
  if (!set) {
    set = new Set();
    pendingOutputSubs.set(stationId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** The station's buffered live output, or null when it never ran here. */
export function stationOutput(stationId: string): StationOutput | null {
  return outputs.get(stationId) ?? null;
}

/** Last parsed line of a station's live log — the floor view's one-liner. */
export function lastStationLine(stationId: string): string {
  return outputs.get(stationId)?.lastLine() ?? "";
}

export interface RunOptions {
  store: FactoryStore;
  command?: readonly string[];
  timeoutMs?: number;
  model?: string; // override the station's routed model (muse routes only; other providers keep their Settings model)
  effort?: string; // override the routed reasoning effort
  providerCommands?: Partial<Record<ProviderId, readonly string[]>>; // per-provider stub commands (tests)
  deltaTask?: string; // sent instead of card.task when resuming a session that already holds the full card
}

/**
 * Station model routing: judgment stations (planning, red-teaming,
 * judging, retros) run the strong model; execution stations run the
 * fast coding model and only escalate when a caller says so (the
 * builder passes its attempt tier). Until now every station silently
 * ran the CLI default at effort high — the tier ladder was decoration.
 */
export const STATION_ROUTES: Record<JobCard["role"], ProviderRoute> = {
  planner: {
    provider: "muse",
    model: "muse-wonder-1.0",
    effort: "high",
  },
  redteam: {
    provider: "muse",
    model: "muse-wonder-1.0",
    effort: "medium",
  },
  sme: {
    provider: "muse",
    model: "muse-wonder-1.0",
    effort: "medium",
  },
  coder: {
    provider: "muse",
    model: "muse-spark-1.3",
    effort: "high",
  },
  outsider: {
    provider: "muse",
    model: "muse-spark-1.3",
    effort: "low",
  },
  builder: {
    provider: "muse",
    model: "muse-spark-1.3",
    effort: "medium",
  },
  qc: {
    provider: "muse",
    model: "muse-spark-1.3",
    effort: "medium",
  },
  fixer: {
    provider: "muse",
    model: "muse-spark-1.3",
    effort: "medium",
  },
};

export const KNOWN_MODELS = [
  "muse-wonder-1.0",
  "muse-spark-1.3",
] as const;
export const KNOWN_EFFORTS = [
  "low",
  "medium",
  "high",
] as const;

// Live routing: an ordered list of presets, one active. A preset is a
// complete station-routing set; when the active preset's provider runs
// out of quota, the factory swaps the WHOLE active preset to the next
// one in the owner's order and the station retries under it. Owners can
// keep any number of presets (Settings suggests some per installed CLI).
export const DEFAULT_PRESET: StationPreset = {
  id: "default",
  name: "Muse — judgment & build (Meta)",
  routes: STATION_ROUTES,
  critical: {
    onQuota: true,
    failureRatePercent: 0,
    errorRatePercent: 0,
    minSamples: 5,
  },
};
let livePresets: StationPreset[] = [
  DEFAULT_PRESET,
];
let activePresetId = DEFAULT_PRESET.id;
export function getPresets(): StationPreset[] {
  return livePresets;
}
export function getActivePresetId(): string {
  return activePresetId;
}
export function getActivePreset(): StationPreset {
  return livePresets.find((x) => x.id === activePresetId) ?? livePresets[0] ?? DEFAULT_PRESET;
}
export function setActivePreset(id: string): boolean {
  if (!livePresets.some((x) => x.id === id)) return false;
  activePresetId = id;
  return true;
}
export function setPresets(presets: unknown, activeId?: string): void {
  if (!Array.isArray(presets)) return;
  const validated = presets
    .map((x) => validatePreset(x))
    .filter((x): x is StationPreset => x !== null);
  if (!validated.length) return;
  livePresets = validated;
  if (activeId && validated.some((x) => x.id === activeId)) activePresetId = activeId;
  if (!validated.some((x) => x.id === activePresetId))
    activePresetId = validated[0]?.id ?? DEFAULT_PRESET.id;
}
export function getStationRoutes(): Record<JobCard["role"], ProviderRoute> {
  return getActivePreset().routes;
}
export function setStationRoutes(
  partial: Partial<
    Record<
      JobCard["role"],
      {
        provider?: string;
        model: string;
        effort: string;
      }
    >
  >,
): void {
  const active = getActivePreset();
  const routes = {
    ...active.routes,
  };
  for (const [role, route] of Object.entries(partial) as [
    JobCard["role"],
    {
      provider?: string;
      model: string;
      effort: string;
    },
  ][]) {
    if (!route) continue;
    const valid = validateRoute(route);
    if (!valid) continue;
    if (
      valid.provider === "muse" &&
      !(PROVIDERS.muse.suggestedModels as string[]).includes(valid.model)
    )
      continue;
    routes[role] = valid;
  }
  livePresets = livePresets.map((x) =>
    x.id === active.id
      ? {
          ...x,
          routes,
        }
      : x,
  );
}

/** Stored sessions are provider-scoped: "<provider>:<id>" (legacy plain ids are muse). */
export function decodeStoredSession(stored: string | null, provider: ProviderId): string | null {
  if (!stored) return null;
  const sep = stored.indexOf(":");
  if (sep < 0) return provider === "muse" ? stored : null;
  return stored.slice(0, sep) === provider ? stored.slice(sep + 1) : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export async function runStation(card: JobCard, opts: RunOptions): Promise<DeliveryNote> {
  const timeoutMs = opts.timeoutMs ?? 60 * 60_000; // real builder tasks run long; a kill now pauses resumably, never terminally fails

  // The card's armed gates are enforced here, not just advertised in the
  // prompt: a veto/block/ask short-circuits the station before any agent is
  // spawned. Plan-mode and tradeoff run elsewhere (Muse hook, merge gate).
  const gateBlockers = evaluateGates(card).filter((v) => v.decision !== "allow");
  if (gateBlockers.length) {
    const reason = gateBlockers.map((v) => `${v.gate}: ${v.reasons.join("; ")}`).join(" | ");
    const note: DeliveryNote = {
      stationId: card.id,
      status: "blocked",
      summary: `blocked: ${reason}`.slice(0, 500),
      detail: reason,
      sessionId: null,
      artifacts: [],
    };
    await opts.store.saveDelivery(card.jobId, note);
    return note;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  async function runOnce(
    route: ProviderRoute,
    resume: string | null,
  ): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    timedOut: boolean;
    parsed: ReturnType<typeof parseMuseOutput> & {
      inputTokens?: number;
      outputTokens?: number;
    };
  }> {
    // A resumed session already holds the full card in its history:
    // sending it again re-bills the same text. Callers that know what
    // changed supply a delta; a fresh session always gets the full card.
    const promptCard =
      resume && opts.deltaTask
        ? {
            ...card,
            task: opts.deltaTask,
          }
        : card;
    const promptText = renderPrompt(promptCard);
    const def = PROVIDERS[route.provider];
    const stubCommand = opts.command ?? opts.providerCommands?.[route.provider];
    // Model overrides from callers (tier escalation, judge) name muse
    // models; they apply to muse routes only — another provider keeps
    // the model the owner picked for it in Settings.
    const effectiveModel = route.provider === "muse" ? (opts.model ?? route.model) : route.model;
    const effectiveEffort = opts.effort ?? route.effort;
    // Stub commands (tests) receive the prompt untouched as the last
    // argument; real providers build their own argv from the route.
    const args = stubCommand
      ? [
          ...stubCommand,
          promptText,
        ]
      : def.buildArgs({
          model: effectiveModel,
          effort: effectiveEffort,
          resumeId: def.supportsResume ? resume : null,
          prompt: promptText,
        });
    // What the owner sees in the "command" modal: the exact spawn, with
    // the (long) prompt kept separately instead of flooding the argv line.
    const shown = args.map((a) =>
      a.length > 90 ? `${a.slice(0, 90)}… <prompt: ${a.length} chars, shown below>` : a,
    );
    // Live output: parsed display lines for the control room log, plus a
    // bounded raw tail for the debugging view. Created before the process
    // spawns (and before the station shows as live), so watchStation
    // subscribers from before runStation attach here and a viewer can
    // never observe "live" while the stream 404s. A resume-retry later
    // replaces the entry; old readers are closed by finish() on the
    // previous attempt.
    const parser = new MuseJsonlParser();
    const output = new StationOutput(card.id);
    outputs.set(card.id, output);
    for (const cb of pendingOutputSubs.get(card.id) ?? []) cb(output);
    pendingOutputSubs.delete(card.id);
    activeStations.set(card.jobId, {
      jobId: card.jobId,
      stationId: card.id,
      role: card.role,
      model: stubCommand ? "custom command" : effectiveModel,
      effort: stubCommand ? "" : effectiveEffort,
      startedAt: new Date().toISOString(),
      commandLine: shown.join(" "),
      prompt: promptText,
      sessionId: resume,
      outputBytes: 0,
    });
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        cwd: card.worktree,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      output.append(
        [
          `[stderr] spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        ],
        "",
      );
      output.finish();
      if (activeStations.get(card.jobId)?.stationId === card.id) activeStations.delete(card.jobId);
      throw err;
    }
    let stopped = false;
    let timedOut = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      proc.kill();
    };
    running.set(card.id, {
      kill: stop,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    // Progress probe: agent stdout grows while it works (tokens + tool
    // calls stream out). Count bytes so the Now bar can tell a thinking
    // agent from a dead one — 65k-char prompts make "no file edits yet"
    // a common and misleading signal on its own.
    let outputBytes = 0;
    const readStream = (
      stream: ReadableStream<Uint8Array> | null,
      onChunk: (text: string, chunkBytes: number) => void,
    ): Promise<string> => {
      if (!stream) return Promise.resolve("");
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const pump = async (): Promise<string> => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          outputBytes += value.byteLength;
          const liveNow = activeStations.get(card.jobId);
          if (liveNow?.stationId === card.id) liveNow.outputBytes = outputBytes;
          const chunk = decoder.decode(value, {
            stream: true,
          });
          text += chunk;
          onChunk(chunk, value.byteLength);
        }
      };
      return pump();
    };
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout as unknown as ReadableStream<Uint8Array>, (chunk) =>
        output.append(parser.feed(chunk), chunk),
      ),
      // stderr is not JSON: keep it raw, label it in the parsed view.
      readStream(proc.stderr as unknown as ReadableStream<Uint8Array>, (chunk) =>
        output.append(
          chunk.split("\n").map((l) => (l.trim() ? `[stderr] ${l}` : l)),
          chunk,
        ),
      ),
      proc.exited,
    ]);
    output.append(parser.flush(), "");
    output.finish();
    clearTimeout(timer);
    running.delete(card.id);
    if (activeStations.get(card.jobId)?.stationId === card.id) activeStations.delete(card.jobId);
    // Muse (and stub commands, which speak muse JSONL in tests) parse
    // through the muse parser; other providers parse by their own shape.
    const parsed =
      stubCommand || def.output === "muse-jsonl"
        ? parseMuseOutput(stdout)
        : parseProviderOutput(def, stdout, code);
    return {
      stdout,
      stderr,
      code,
      timedOut,
      parsed,
    };
  }

  const storedRecord = await opts.store.getSessionRecord(card.jobId, card.id);
  const storedSession = storedRecord ? `${storedRecord.provider}:${storedRecord.id}` : null;
  type Attempt = Awaited<ReturnType<typeof runOnce>>;
  const attemptOnRoute = async (route: ProviderRoute): Promise<Attempt> => {
    const resume = decodeStoredSession(storedSession, route.provider);
    let result = await runOnce(route, resume);
    // A stored session can be unusable in this worktree: expired, created
    // in another warm-pool slot, or locked by an orphaned process. Clear
    // it and retry once with a fresh session instead of failing.
    if (
      resume &&
      (looksLikeExpiredSession(result.stdout, result.stderr) ||
        looksLikeWorkspaceSwitch(result.stdout, result.stderr) ||
        looksLikeSessionInUse(result.stdout, result.stderr))
    ) {
      await opts.store.setSession(card.jobId, card.id, null);
      result = await runOnce(route, null);
    }
    return result;
  };
  const isQuotaFailure = (a: Attempt): boolean => {
    const failed = !(a.code === 0 || a.parsed.completed);
    return (
      failed &&
      (looksLikeQuotaLimit(a.stdout, a.stderr) ||
        looksLikeQuotaLimit(a.parsed.reply.split("\n")[0] ?? "", ""))
    );
  };

  // Quota failover: the station's provider is a subscription, not a
  // constant. On a quota failure, mark that provider exhausted until
  // its backoff, then retry the station on the next fallback route
  // (fresh session — resume ids never cross providers). A provider
  // already inside its backoff is skipped without spending a call.
  const primaryRoute = getActivePreset().routes[card.role] ?? STATION_ROUTES[card.role];
  let usedRoute = primaryRoute;
  let failoverNote = "";
  let attempt: Attempt;
  if (opts.command) {
    attempt = await runOnce(
      primaryRoute,
      decodeStoredSession(storedSession, primaryRoute.provider),
    );
  } else {
    const recordOutcome = async (
      route: ProviderRoute,
      preset: StationPreset,
      a: Attempt,
    ): Promise<void> => {
      if (isQuotaFailure(a)) return; // quota has its own switch rule and backoff
      const done = a.code === 0 || a.parsed.completed;
      const outcome = classifyProviderOutcome({
        done,
        timedOut: a.timedOut,
        reply: a.parsed.reply,
        stderr: a.stderr,
      });
      await opts.store
        .appendProviderOutcome(route.provider, outcome, new Date().toISOString(), preset.id)
        .catch(() => {});
    };
    // Preset chain from the active preset onward, in the owner's order.
    // A preset is skipped without spending a call when its route-provider
    // is in quota backoff, or when its provider's recent outcomes reached
    // one of the preset's critical levels (failure / provider-error rate).
    const activeIdx = Math.max(
      0,
      livePresets.findIndex((x) => x.id === activePresetId),
    );
    const ordered = livePresets.slice(activeIdx);
    const chain: {
      preset: StationPreset;
      route: ProviderRoute;
    }[] = [];
    const skipped: string[] = [];
    for (const preset of ordered) {
      const route = preset.routes[card.role] ?? STATION_ROUTES[card.role];
      const quotaPaused =
        (await opts.store.providerQuotaUntil(route.provider).catch(() => "")) >
        new Date().toISOString();
      if (quotaPaused && preset.critical.onQuota) {
        skipped.push(`preset "${preset.name}" quota exhausted on ${route.provider} (in backoff)`);
        continue;
      }
      const health = await opts.store.providerHealth(route.provider).catch(() => null);
      const reason = health ? presetSwitchReason(preset, health) : null;
      if (reason) {
        skipped.push(`preset "${preset.name}" critical level: ${reason} on ${route.provider}`);
        continue;
      }
      chain.push({
        preset,
        route,
      });
    }
    if (!chain.length) {
      const preset = ordered[0] ?? getActivePreset();
      chain.push({
        preset,
        route: preset.routes[card.role] ?? primaryRoute,
      }); // everything skipped/paused: probe the first
    }
    let usedPreset = chain[0]?.preset ?? getActivePreset();
    usedRoute = chain[0]?.route ?? primaryRoute;
    if (usedPreset.id !== activePresetId) {
      failoverNote = `failover: ${skipped[0] ?? `preset "${getActivePreset().name}" unavailable`} — swapped to preset "${usedPreset.name}" (${usedRoute.provider}:${usedRoute.model})`;
      setActivePreset(usedPreset.id);
    }
    attempt = await attemptOnRoute(usedRoute);
    await recordOutcome(usedRoute, usedPreset, attempt);
    for (let i = 1; i < chain.length && isQuotaFailure(attempt); i++) {
      if (!usedPreset.critical.onQuota) break; // this preset's owner disabled quota swap
      await opts.store
        .noteProviderQuota(
          usedRoute.provider,
          new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString(),
        )
        .catch(() => {});
      const next = chain[i];
      if (!next) break;
      // Never spend a call on a backup whose provider just exhausted.
      if (next.route.provider === usedRoute.provider) continue;
      failoverNote = `failover: preset "${usedPreset.name}" quota exhausted on ${usedRoute.provider} — swapped to preset "${next.preset.name}" (${next.route.provider}:${next.route.model})`;
      usedPreset = next.preset;
      usedRoute = next.route;
      setActivePreset(usedPreset.id); // the whole factory follows the swap
      attempt = await attemptOnRoute(usedRoute);
      await recordOutcome(usedRoute, usedPreset, attempt);
    }
    if (isQuotaFailure(attempt))
      await opts.store
        .noteProviderQuota(
          usedRoute.provider,
          new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString(),
        )
        .catch(() => {});
    else if (attempt.code === 0 || attempt.parsed.completed)
      await opts.store.clearProviderQuota(usedRoute.provider).catch(() => {});
  }
  const { stderr, code, timedOut } = attempt;
  const parsed = attempt.parsed;
  if (parsed.sessionId)
    await opts.store.setSession(card.jobId, card.id, parsed.sessionId, usedRoute.provider);

  // A station that delivered its final answer is done even when the agent
  // process then exits non-zero (kill-on-hang, cleanup failure): the work
  // and the verdict are in the reply, not in the exit code.
  const status = code === 0 || parsed.completed ? "done" : "failed";
  // For a failed station with no reply, the meaningful line is the LAST
  // stderr line (the first is muse's workspace banner, not the error).
  const stderrLines = stderr.split("\n").filter((l) => l.trim());
  let summary = (
    parsed.reply.split("\n").find((l) => l.trim()) ??
    (status === "failed" ? stderrLines[stderrLines.length - 1] : stderrLines[0]) ??
    ""
  ).slice(0, 500);
  if (status === "failed" && timedOut)
    summary =
      `station timed out after ${Math.round(timeoutMs / 60_000)} min${summary ? `: ${summary}` : ""}`.slice(
        0,
        500,
      );
  // Token/usage limit: classify it, and pause the whole factory until
  // the reset backoff passes instead of letting every parallel
  // station fail against the same wall.
  if (
    status === "failed" &&
    (looksLikeQuotaLimit(attempt.stdout, stderr) || looksLikeQuotaLimit(summary, ""))
  ) {
    summary = `quota: ${summary}`.slice(0, 500);
    await opts.store
      .noteQuotaPause(new Date(Date.now() + QUOTA_BACKOFF_MS).toISOString())
      .catch(() => {});
  } else if (status === "done") {
    // A station that completes proves tokens are available again:
    // clear any quota pause so dispatch resumes without waiting for
    // the recorded backoff (this is how a probe reopens the factory).
    const paused = await opts.store.quotaPausedUntil().catch(() => "");
    if (paused) await opts.store.clearQuotaPause().catch(() => {});
  }
  const usage =
    parsed.inputTokens !== undefined || parsed.outputTokens !== undefined
      ? {
          inputTokens: parsed.inputTokens ?? 0,
          outputTokens: parsed.outputTokens ?? 0,
        }
      : parsed.sessionId && usedRoute.provider === "muse"
        ? readSessionUsage(parsed.sessionId)
        : null;
  // A later round on the swapped preset must not erase the record
  // that this station already failed over once: carry the first
  // [failover: …] line forward into the new delivery.
  if (!failoverNote) {
    const prior = (await opts.store.listDeliveries(card.jobId).catch(() => [])).find(
      (d) => d.stationId === card.id,
    );
    const line = prior?.detail.split("\n").find((l) => l.startsWith("[failover:"));
    if (line) failoverNote = line.replace(/^\[|\]$/g, "");
  }
  const note: DeliveryNote = {
    stationId: card.id,
    status,
    summary,
    detail: (
      (failoverNote ? `[${failoverNote}]\n` : "") +
      parsed.reply +
      (status === "failed" && stderr.trim() ? `\n\n[stderr]\n${stderr.slice(-1500)}` : "")
    ).slice(0, 8000),
    sessionId: parsed.sessionId,
    artifacts: [],
    model: opts.command ? "custom command" : usedRoute.model,
    provider: opts.command ? "custom" : usedRoute.provider,
    ...(usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }
      : {}),
  };
  await opts.store.saveDelivery(card.jobId, note);
  return note;
}
