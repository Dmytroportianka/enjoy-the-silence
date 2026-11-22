import { driver } from "driver.js";
import { Check, ChevronDown, Circle, Loader2, Play, Search, Send, Square, X } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useMatch, useNavigate } from "react-router";
import {
  countByProject,
  countByState,
  filterWorkOrders,
  hasActiveWorkOrderFilters,
} from "./features-filter";
import { Surface } from "./Surface";
import { WizardDemo } from "./WizardDemo";
import "driver.js/dist/driver.css";

// Expose Driver.js to Playwright/automation so recordings can annotate the
// screen with explanatory tooltips during a walkthrough.
if (typeof window !== "undefined") {
  (window as any).__driverFactory = driver;
  let active: any = null;
  (window as any).showTip = (selector: string, title: string, description: string) => {
    try {
      active?.destroy?.();
    } catch {
      /* ignore */
    }
    const d = driver({
      allowClose: true,
    });
    d.highlight({
      element: selector,
      popover: {
        title,
        description,
        side: "bottom",
        align: "start",
      },
    });
    active = d;
  };
  (window as any).clearTip = () => {
    try {
      active?.destroy?.();
    } catch {
      /* ignore */
    }
    active = null;
  };
}

interface Project {
  id: string;
  online: boolean;
  name: string;
  repoPath: string;
  description: string;
  goals: string[];
  moat: string;
  features: {
    id: string;
    title: string;
    state: string;
  }[];
  lastCommit: string;
  currentCommit: string;
  stale: boolean;
  devCommand: string;
  devPort: number;
  testMode: string;
  businessPlan: string;
  rules: string;
  smeSoul: string;
  coderSoul: string;
  smePersona: string;
  coderPersona: string;
  scouting?: boolean;
  scoutSuggestions?: ScoutSuggestions | null;
  ci?: {
    workflows: {
      file: string;
      name: string;
      triggers: string[];
      jobs: string[];
      runs: string[];
      runsOn: string;
      heavy: boolean;
    }[];
    scripts: string[];
    suggestedVerify: string;
    notInCi: string[];
  } | null;
  dev: {
    running: boolean;
    since: string | null;
    port: number;
  };
}
interface Task {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  plan: string;
  planState: string;
  planQuestions: string[];
  state: string;
  taskType: string;
  tags: string[];
  attempts: number;
  verifyCommand: string;
  worktree: string;
  baseCommit: string;
  updatedAt: string;
  planning?: boolean;
  planRequested?: boolean;
  liveActor?: string | null;
  liveLast?: string | null;
  lane?: string;
  triage?: string;
  retroReviewedAt?: string;
  visualState?: string;
  visualApprovedHashes?: string[];
  rolledBackAt?: string;
  revertCommit?: string;
  retroFindings?: string[];
  retroAt?: string;
  retroSummary?: string;
  waitingQuestion?: string | null;
  waitingContext?: {
    kind: string;
    at: string;
    text: string;
  }[];
  activity?: {
    file: string;
    status: string;
    modifiedAt: string;
  }[];
}
interface ScoutSuggestions {
  description: string;
  rules: string;
  smeSoul: string;
  coderSoul: string;
  at: string;
  error?: string;
}
interface Capacity {
  running: number;
  maxParallelTasks: number;
  queued: number;
  freeRamMb: number;
  ramFloorMb: number;
  ramAdvice?: {
    action: "raise" | "lower";
    suggested: number;
    reason: string;
  } | null;
}
interface PromptEntry {
  kind: string;
  at: string;
  text: string;
}
interface TaskDetailData {
  task: Task;
  prompts: PromptEntry[];
  stations: {
    card: {
      id: string;
      role: string;
    };
    delivery: {
      status: string;
      summary: string;
      detail?: string;
      sessionId?: string | null;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    } | null;
  }[];
  planArtifact: string | null;
  artifacts: string[];
  activity: {
    file: string;
    status: string;
    modifiedAt: string;
  }[];
  similar: {
    title: string;
    tags: string[];
    outcome: string;
  }[];
  planning: boolean;
  planningSince: string | null;
  retro: {
    text: string;
    findings: string[];
    at: string;
    error?: string;
  } | null;
  retroRunning: boolean;
  visual?: {
    taskId: string;
    status: string;
    at: string;
    baseCommit?: string;
    threshold?: number;
    reason?: string;
    shots: {
      name: string;
      route: string;
      viewport: string;
      status: string;
      diffRatio: number;
      diffPixels: number;
      totalPixels: number;
      width: number;
      height: number;
      baseline: string;
      after: string;
      diff: string;
      error?: string;
    }[];
    comments: {
      shot: string;
      comment: string;
      at: string;
    }[];
  } | null;
  live: {
    stationId: string;
    role: string;
    model: string;
    effort: string;
    startedAt: string;
    commandLine?: string;
    prompt?: string;
    sessionId?: string | null;
    outputBytes?: number;
  } | null;
}

const agoText = (iso: string) => {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 1
    ? "just now"
    : min < 60
      ? `${min}m ago`
      : `${Math.floor(min / 60)}h ${min % 60}m ago`;
};

/** What the task is doing right now — the live station, not just history. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
function NowBar({ d, refresh }: { d: TaskDetailData; refresh: () => void }) {
  const t = d.task;
  const lastEdit = d.activity?.[0];
  const [showCommand, setShowCommand] = useState(false);
  if (d.live) {
    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - new Date(d.live.startedAt).getTime()) / 1000),
    );
    const editAgeMs = lastEdit?.modifiedAt
      ? Date.now() - new Date(lastEdit.modifiedAt).getTime()
      : Infinity;
    const quiet = elapsedSec > 20 * 60 && editAgeMs > 20 * 60 * 1000;
    return (
      <Surface surface="elevated" className={`border p-3 my-2 ${quiet ? "border-warning" : ""}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <Loader2 size={16} className="animate-spin text-primary" />
          <button
            className="text-primary font-bold"
            title="Show the exact command and prompt this agent is running"
            onClick={() => setShowCommand(true)}
          >
            Now: {d.live.role}
          </button>
          <span className="text-muted">
            {d.live.model}
            {d.live.effort ? ` · ${d.live.effort} effort` : ""} · running{" "}
            <Elapsed since={d.live.startedAt} />
          </span>
          <span className="text-muted">
            {lastEdit
              ? `last file edit ${agoText(lastEdit.modifiedAt)} (${lastEdit.file})`
              : "no file edits yet"}
          </span>
          <span
            className="text-muted"
            title="Agent output so far (stdout+stderr). It grows while the agent reads, thinks, and calls tools — even before it edits any file."
          >
            ·{" "}
            {d.live.outputBytes
              ? `${(d.live.outputBytes / 1024).toFixed(1)} KB and growing`
              : "starting…"}
          </span>
          <button
            className={btnDangerCls}
            title="Stop the agent process now — the task parks and resumes from your reply"
            onClick={async () => {
              await api(`/api/stations/${encodeURIComponent(d.live?.stationId ?? "")}/cancel`, {
                method: "POST",
              });
              refresh();
            }}
          >
            Stop station
          </button>
        </div>
        {quiet && (
          <p className="text-warning mt-1">
            No file changes for a while — this station may be stuck. It times out at 60:00, saves
            its progress, and resumes rather than failing.
          </p>
        )}
        <LiveLog stationId={d.live.stationId} startedAt={d.live.startedAt} />
        {showCommand && (
          <div
            className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
            role="dialog"
            aria-modal="true"
            onClick={() => setShowCommand(false)}
          >
            <Surface
              surface="elevated"
              className="border p-4 max-w-3xl w-full max-h-[85vh] overflow-auto"
            >
              <div
                className="flex items-center gap-4 flex-wrap"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="m-0">
                  Agent command — {d.live.role} ({d.live.stationId})
                </h3>
                <button className={btnCls} onClick={() => setShowCommand(false)}>
                  Close
                </button>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <p className="text-muted">
                  Started {d.live.startedAt}
                  {d.live.sessionId
                    ? ` · resuming session ${d.live.sessionId}`
                    : " · fresh session"}{" "}
                  · cwd is the task worktree. Click outside or Close to dismiss.
                </p>
                <h4>Command</h4>
                <pre className="bg-surface-sink p-2 whitespace-pre-wrap break-all">
                  {d.live.commandLine ?? "(not recorded — station started before this was tracked)"}
                </pre>
                <h4>Prompt (the job card the agent received)</h4>
                <pre className="bg-surface-sink p-2 whitespace-pre-wrap">
                  {d.live.prompt ?? "(not recorded)"}
                </pre>
              </div>
            </Surface>
          </div>
        )}
      </Surface>
    );
  }
  if (t.state === "running" || t.state === "in-review") {
    return (
      <p className="text-muted my-2">
        Between stations — verifying the work or moving to the next step. Last update{" "}
        {agoText(t.updatedAt)}.
      </p>
    );
  }
  return null;
}

/**
 * Tail a running station's live log over SSE. Default is the parsed view
 * (Muse JSONL events rendered as readable lines); `raw` serves the raw
 * byte tail for debugging. Auto-sticks to the bottom until the owner
 * scrolls up; reconnects replay the in-memory buffer with dedupe, so a
 * dropped connection never prints a line twice.
 */
function LiveLog({ stationId, startedAt }: { stationId: string; startedAt: string }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [rawText, setRawText] = useState("");
  const [ended, setEnded] = useState(false);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const parsedSeqRef = useRef(-1);
  const rawEndRef = useRef(0);

  useEffect(() => {
    // Reset for the new connection (station, process, or view toggle).
    setLines([]);
    setRawText("");
    setEnded(false);
    setUnread(0);
    stickRef.current = true;
    parsedSeqRef.current = -1;
    rawEndRef.current = 0;
    let es: EventSource | null = null;
    try {
      es = new EventSource(
        `/api/stations/${encodeURIComponent(stationId)}/stream${raw ? "?raw=1" : ""}`,
      );
    } catch {
      return;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
    es.onmessage = (ev) => {
      if (raw) {
        const data = String(ev.data ?? "");
        const end = Number(ev.lastEventId);
        let msg: {
          from?: number;
          text?: string;
        };
        try {
          msg = JSON.parse(data) as {
            from?: number;
            text?: string;
          };
        } catch {
          return;
        }
        const from = typeof msg.from === "number" ? msg.from : 0;
        const text = msg.text ?? "";
        // Dedupe on reconnect: skip the part of a replayed chunk the
        // client already holds (offsets count decoded characters).
        const overlap = Math.max(0, rawEndRef.current - from);
        const fresh = text.slice(Math.min(overlap, text.length));
        rawEndRef.current = end;
        if (fresh) {
          setRawText((t) => (t + fresh).slice(-100_000));
          if (!stickRef.current) setUnread((n) => n + 1);
        }
      } else {
        const seq = Number(ev.lastEventId);
        if (!Number.isFinite(seq) || seq <= parsedSeqRef.current) return;
        parsedSeqRef.current = seq;
        let text: string;
        try {
          text = JSON.parse(String(ev.data ?? "")) as string;
        } catch {
          text = String(ev.data ?? "");
        }
        setLines((ls) => [
          ...ls.slice(-1499),
          text,
        ]);
        if (!stickRef.current) setUnread((n) => n + 1);
      }
    };
    es.addEventListener("done", () => {
      setEnded(true);
      es?.close();
    });
    return () => es?.close();
  }, [
    stationId,
    startedAt,
    raw,
  ]);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [
    lines,
    rawText,
  ]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    if (stickRef.current) setUnread(0);
  };
  const jump = () => {
    stickRef.current = true;
    setUnread(0);
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  };
  const last = lines[lines.length - 1] ?? "";

  return (
    <Surface surface="sink" className="border my-1">
      <div className="flex items-center gap-2 flex-wrap px-2 py-1 text-sm">
        <button
          type="button"
          className={btnGhostCls}
          onClick={() => setOpen((v) => !v)}
          title="Stream this agent's output as it happens"
        >
          {open ? <ChevronDown size={14} /> : <Play size={14} />}{" "}
          {open ? "Hide live log" : "Live log"}
        </button>
        {ended ? (
          <span className="text-muted">station ended</span>
        ) : (
          <Loader2 size={12} className="animate-spin text-primary" />
        )}
        {open && (
          <button
            type="button"
            className={btnGhostCls}
            onClick={() => setRaw((v) => !v)}
            title="Raw shows the muse JSONL event stream; parsed shows readable lines"
          >
            {raw ? "parsed view" : "raw JSONL"}
          </button>
        )}
        {open && unread > 0 && (
          <button type="button" className={btnCls} onClick={jump}>
            ↓ {unread} new — jump
          </button>
        )}
        {!open &&
          (last ? (
            <span className="text-muted truncate flex-1 min-w-0" title={last}>
              {last.slice(0, 200)}
            </span>
          ) : (
            <span className="text-muted flex-1">waiting for output…</span>
          ))}
      </div>
      {open && (
        <div
          ref={boxRef}
          onScroll={onScroll}
          className="max-h-64 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap break-words px-2 pb-2"
        >
          {raw
            ? rawText || "no raw output yet"
            : lines.length
              ? lines.join("\n")
              : "no output yet — the agent is starting"}
        </div>
      )}
    </Surface>
  );
}

async function api(
  url: string,
  opts?: RequestInit,
): Promise<{
  r: Response;
  // biome-ignore lint/suspicious/noExplicitAny: dashboard API JSON is untyped at this boundary
  d: Record<string, any>;
}> {
  const r = await fetch(url, opts);
  // biome-ignore lint/suspicious/noExplicitAny: same untyped API boundary
  const d = (await r.json().catch(() => ({}))) as Record<string, any>;
  return {
    r,
    d,
  };
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

/** Shared delete flow for the board cross and the task-page button. */
async function deleteTaskWithConfirm(t: Task): Promise<boolean> {
  if (
    !window.confirm(
      `Permanently delete task "${t.title}" (${t.id})? This cannot be undone. It also deletes its git worktree (including any uncommitted changes) and branch task/${t.id} (including unpushed, unmerged commits), its job and session files, prompt history, plan and artifacts, and its history record.`,
    )
  )
    return false;
  const { r, d } = await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
    method: "DELETE",
  });
  if (!r.ok) {
    window.alert(
      String(d.error ?? "delete failed") +
        (Array.isArray(d.skipped) && d.skipped.length
          ? `\nNot erased / retained for retry:\n${d.skipped.join("\n")}`
          : ""),
    );
    return false;
  }
  if (Array.isArray(d.skipped) && d.skipped.length) {
    window.alert(
      `Task ${t.id} deleted from the board, but these were NOT erased:\n${d.skipped.join("\n")}\nRemove them manually. A persistent receipt was written to deletion-receipts.jsonl in the factory data folder.`,
    );
  }
  return true;
}
const short = (h?: string) => (h ? h.slice(0, 7) : "—");
// Red-team verdicts are a review outcome, not a failure: REJECT only
// means "processed, with points the planner must decide on".
const verdictText = (s: string) =>
  s.replace(/^REJECT\b/i, "Processed — points raised").replace(/^PASS\b/i, "Passed — no points");
function Elapsed({ since }: { since: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const sec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
  return <span>{`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`}</span>;
}

function PlanProgress({ d }: { d: TaskDetailData }) {
  const steps: [
    string,
    string,
  ][] = [
    [
      "planner",
      "Planner",
    ],
    [
      "redteam-sme",
      "SME red-team",
    ],
    [
      "redteam-outsider",
      "Outsider",
    ],
    [
      "plan-reviser",
      "Reviser",
    ],
  ];
  const byId = new Map(
    d.stations.map((s) => [
      s.card.id,
      s,
    ]),
  );
  let seenRunning = false;
  return (
    <Surface surface="elevated" className="border p-3 my-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Loader2 size={16} className="animate-spin text-primary" />
        <b>Planning in progress</b>
        <span className="text-muted">
          {d.planningSince ? <Elapsed since={d.planningSince} /> : "0:00"}
        </span>
        {steps.map(([id, label]) => {
          const s = byId.get(id);
          let icon: ReactNode;
          let cls = "border-surface-elevated-border text-muted";
          if (s?.delivery) {
            icon = <Check size={14} className="text-success" />;
            cls = "border-success text-on-surface-elevated";
          } else if (s && !seenRunning) {
            icon = <Loader2 size={14} className="animate-spin text-primary" />;
            cls = "border-primary text-on-surface-elevated";
            seenRunning = true;
          } else if (s) icon = <Circle size={14} />;
          else icon = <X size={14} className="text-danger" />;
          return (
            <span
              key={id}
              title={s?.delivery ? verdictText(s.delivery.summary) : label}
              className={`inline-flex items-center gap-1.5 border rounded-full px-2.5 py-1 text-sm bg-surface-sink ${cls}`}
            >
              {icon}
              {label}
            </span>
          );
        })}
      </div>
    </Surface>
  );
}

export interface UserRequest {
  key: string;
  taskId: string;
  kind: "worker" | "planner" | "ready" | "blocked" | "failed" | "retro" | "candidate";
  projectId: string;
  title: string;
  prompt: string;
  question: string;
  stage: string;
  stageIndex: number;
  updatedAt: string;
  state: string;
  context?: {
    kind: string;
    at: string;
    text: string;
  }[];
  activityFiles?: string[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export const requestLabel = (kind: UserRequest["kind"]) =>
  kind === "worker"
    ? "Worker needs input"
    : kind === "planner"
      ? "Planner needs a decision"
      : kind === "ready"
        ? "Ready for your approval"
        : kind === "failed"
          ? "Failed — needs you"
          : kind === "retro"
            ? "Retro ready to review"
            : kind === "candidate"
              ? "Retro point — accept or remove"
              : "Blocked — needs you";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
function RequestCard({
  r,
  projectName,
  first,
  onOpen,
  refresh,
  onSnooze,
}: {
  r: UserRequest;
  projectName: string;
  first: boolean;
  onOpen: (taskId: string) => void;
  refresh: () => void;
  onSnooze: (key: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (
    fn: () => Promise<{
      r: Response;
      d: Record<string, unknown>;
    }>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const { r: res, d } = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(String(d.error ?? "action failed"));
      return;
    }
    setText("");
    refresh();
  };
  const removeFeature = () => {
    if (
      !window.confirm(
        `Remove "${r.title}" permanently?\n\nIts factory record, dialogue and unsent drafts are deleted. Its git worktree and branch are kept.`,
      )
    )
      return;
    void act(() =>
      api(`/api/tasks/${encodeURIComponent(r.taskId)}`, {
        method: "DELETE",
      }),
    );
  };
  const needsText = r.kind === "worker" || r.kind === "planner";
  return (
    <Surface surface="elevated" className="block w-full text-left border p-4 my-2 shadow-sm">
      <div className="flex gap-2 flex-wrap items-center">
        <span
          className={`px-2 py-0.5 text-sm ${r.kind === "worker" ? "bg-warning text-on-warning" : r.kind === "planner" || r.kind === "retro" || r.kind === "candidate" ? "bg-accent text-on-accent" : r.kind === "ready" ? "bg-success text-on-success" : "bg-danger text-on-danger"}`}
        >
          {requestLabel(r.kind)}
        </span>
        <span
          className="px-2 py-0.5 text-sm bg-surface-sink"
          title="Where this feature is in its lifecycle"
        >
          Stage {r.stageIndex} of 5 · {r.stage}
        </span>
        <b>{projectName}</b>
        <span className="text-muted text-sm">waiting {agoText(r.updatedAt)}</span>
      </div>
      <b className="block mt-2">{r.title}</b>
      <span className="text-muted block">{r.prompt}</span>
      <span className="block mt-2 whitespace-pre-wrap">
        <b>The agent asks:</b> {r.question}
      </span>
      {!!r.context?.length && (
        <Surface surface="sink" className="border p-2 mt-2">
          <b className="text-sm">
            {r.kind === "retro" ? "Findings" : "Context — latest from the worker"}
          </b>
          {r.context.map((c, i) => (
            <p key={i} className="text-sm my-1">
              <i>{c.kind}</i>{" "}
              <span className="text-muted">{new Date(c.at).toLocaleTimeString()}</span>
              <br />
              <span className="whitespace-pre-wrap" title={c.text}>
                {c.text.length > (r.kind === "retro" ? 520 : 220)
                  ? `${c.text.slice(0, r.kind === "retro" ? 520 : 220)}…`
                  : c.text}
              </span>
            </p>
          ))}
          {!!r.activityFiles?.length && (
            <p className="text-sm my-1">
              <b>Files touched:</b> {r.activityFiles.join(" · ")}
            </p>
          )}
        </Surface>
      )}
      {error && <p className="text-danger font-bold">{error}</p>}
      {needsText && (
        <form
          className="flex flex-col gap-2 items-start mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim())
              void act(() =>
                api(
                  `/api/tasks/${encodeURIComponent(r.taskId)}/${r.kind === "planner" ? "answer" : "prompts"}`,
                  post({
                    text,
                  }),
                ),
              );
          }}
        >
          <textarea
            autoFocus={first}
            className={`${inputCls} w-full`}
            rows={3}
            placeholder={
              r.kind === "planner"
                ? "Answer each point (1., 2., …)"
                : "Answer the agent — sending resumes its work"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          <div className="flex gap-4 flex-wrap">
            <button className={btnCls} disabled={busy || !text.trim()}>
              <Send size={14} />{" "}
              {busy
                ? "Sending…"
                : r.kind === "planner"
                  ? "Send answers & update plan"
                  : "Send reply & resume"}
            </button>
            <button type="button" className={btnGhostCls} onClick={() => onOpen(r.taskId)}>
              Open task
            </button>
            <button type="button" className={btnGhostCls} onClick={() => onSnooze(r.key)}>
              Snooze 1h
            </button>
            <button type="button" className={btnDangerCls} onClick={removeFeature}>
              Remove feature
            </button>
          </div>
        </form>
      )}
      {!needsText && (
        <div className="flex gap-4 flex-wrap mt-2">
          {r.kind === "ready" && (
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/tasks/${encodeURIComponent(r.taskId)}/approve`, {
                    method: "POST",
                  }),
                )
              }
            >
              {busy ? "Approving…" : "Approve plan & queue"}
            </button>
          )}
          {r.kind === "retro" && (
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/tasks/${encodeURIComponent(r.taskId)}/retro-reviewed`, {
                    method: "POST",
                  }),
                )
              }
            >
              {busy ? "Closing…" : "Mark reviewed & close feature"}
            </button>
          )}
          {r.kind === "candidate" && (
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(`/api/tasks/${encodeURIComponent(r.taskId)}/generate-plan`, {
                    method: "POST",
                  }),
                )
              }
            >
              {busy ? "Accepting…" : "Accept — start planning"}
            </button>
          )}
          {(r.kind === "blocked" || r.kind === "failed") && (
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api(
                    `/api/tasks/${encodeURIComponent(r.taskId)}/transition`,
                    post({
                      to: "planned",
                    }),
                  ),
                )
              }
            >
              {busy ? "Sending…" : "Send back to Planned"}
            </button>
          )}
          <button className={btnGhostCls} onClick={() => onOpen(r.taskId)}>
            Open task
          </button>
          <button className={btnGhostCls} onClick={() => onSnooze(r.key)}>
            Snooze 1h
          </button>
          <button className={btnDangerCls} onClick={removeFeature}>
            Remove feature
          </button>
        </div>
      )}
    </Surface>
  );
}

interface DeferredPoint {
  id: string;
  projectId: string;
  sourceTaskId: string;
  sourceTitle: string;
  text: string;
  at: string;
  status: string;
  includedInTaskId: string;
}

// Deferred minor red-team points: not tasks, not blockers. They wait
// here (dismissible) and resurface as a plan question on the next
// related task — include folds them into that plan, skip keeps them.
function DeferredPanel({ refreshSignal }: { refreshSignal: unknown }) {
  const [points, setPoints] = useState<DeferredPoint[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const { d } = await api("/api/deferred");
    setPoints(((d.deferred as DeferredPoint[]) ?? []).filter((x) => x.status === "open"));
  }, []);
  useEffect(() => {
    void load();
  }, [
    load,
    refreshSignal,
  ]);
  if (!points.length) return null;
  return (
    <Surface surface="elevated" className="border p-3 my-2">
      <h3 className="m-0">Deferred minor points ({points.length})</h3>
      <p className="text-muted text-sm">
        Minor red-team points that did not bounce their plan. Each will be offered as a plan
        question on the next related task; dismiss the ones that should never come back.
      </p>
      {error && <p className="text-danger font-bold">{error}</p>}
      {points.map((d) => (
        <div
          key={d.id}
          className="border-t border-surface-elevated-border py-2 flex items-center gap-2 flex-wrap"
        >
          <span className="flex-1 min-w-[240px]">
            {d.text}{" "}
            <span className="text-muted text-sm">
              — from “{d.sourceTitle || d.sourceTaskId}” · {agoText(d.at)}
            </span>
          </span>
          <button
            className={btnGhostCls}
            onClick={async () => {
              const { r, d: res } = await api(
                `/api/deferred/${encodeURIComponent(d.id)}/dismiss`,
                post({
                  projectId: d.projectId,
                }),
              );
              if (!r.ok) {
                setError((res.error as string) || "dismiss failed");
                return;
              }
              void load();
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </Surface>
  );
}

// The human's home: every question from every feature in one queue.
// All the rest — blocked, failed, pauses — arrives here too; a feature's
// lifecycle stage is shown on the card, not as a separate board column.
export function RequestsView({
  requests,
  projects,
  tasks,
  onOpen,
  refresh,
}: {
  requests: UserRequest[];
  projects: Project[];
  tasks: Task[];
  onOpen: (taskId: string) => void;
  refresh: () => void;
}) {
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("af-snoozed") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  const [showSnoozed, setShowSnoozed] = useState(false);
  const now = Date.now();
  const visible = requests.filter((r) => (snoozed[r.key] ?? 0) <= now);
  const hidden = requests.length - visible.length;
  const moving = tasks.filter(
    (t) => t.state === "running" || t.state === "in-review" || t.planning,
  ).length;
  const snooze = (key: string) => {
    const next = {
      ...snoozed,
      [key]: Date.now() + 3600000,
    };
    setSnoozed(next);
    try {
      localStorage.setItem("af-snoozed", JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const shown = showSnoozed ? requests : visible;
  return (
    <div>
      <h2>Requests for your input</h2>
      {requests.length === 0 ? (
        <p className="text-muted">
          Nothing waiting on you — {moving} feature(s) moving on their own. When a planner or worker
          needs you, it appears here and as a short toast.
        </p>
      ) : (
        <>
          <p className="text-muted">
            {visible.length} waiting on you, oldest first. Answer one and the next is ready — its
            input is already focused.
            {hidden > 0 && (
              <>
                {" "}
                {hidden} snoozed.{" "}
                <button className={btnGhostCls} onClick={() => setShowSnoozed((v) => !v)}>
                  {showSnoozed ? "Hide snoozed" : "Show snoozed"}
                </button>
              </>
            )}
          </p>
          {shown.map((r, i) => (
            <RequestCard
              key={r.key}
              r={r}
              projectName={nameOf(r.projectId)}
              first={i === 0}
              onOpen={onOpen}
              refresh={refresh}
              onSnooze={snooze}
            />
          ))}
        </>
      )}
      <DeferredPanel refreshSignal={requests} />
    </div>
  );
}

// Factory configuration as the server actually runs it. These come from
// environment variables at startup; changing one means restarting with
// the new value (the dashboard restarts freely — work resumes itself).
export function PushSettings() {
  const [pushState, setPushState] = useState<"unknown" | "on" | "off" | "denied" | "unsupported">(
    "unknown",
  );
  useEffect(() => {
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
    void navigator.serviceWorker.ready
      .then(async (reg) => {
        const sub = await reg.pushManager.getSubscription().catch(() => null);
        setPushState(sub ? "on" : "off");
      })
      .catch(() => {});
  }, []);
  const enablePush = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { d } = await api("/api/push/vapid-key");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: d.publicKey as string,
      });
      await api("/api/push/subscribe", post(sub.toJSON()));
      setPushState("on");
    } catch {
      setPushState("off");
    }
  };
  const disablePush = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription().catch(() => null);
      if (sub) {
        await api("/api/push/subscribe", {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            endpoint: sub.endpoint,
          }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setPushState("off");
    } catch {
      /* keep current state */
    }
  };
  return (
    <Surface surface="elevated" className="border p-4 my-3">
      <h3 className="mt-0">Push notifications</h3>
      <p className="text-muted">
        Get pinged on any tab — or with no tab open — when a planner or worker needs your input. The
        server pushes to this browser only.
      </p>
      {pushState === "on" && (
        <div className="flex gap-4 items-center flex-wrap">
          <span className="text-success font-bold">On for this browser</span>
          <button className={btnGhostCls} onClick={disablePush}>
            Disable push notifications
          </button>
        </div>
      )}
      {pushState === "off" && (
        <div className="flex gap-4">
          <button className={btnCls} onClick={enablePush}>
            🔔 Enable push notifications
          </button>
        </div>
      )}
      {pushState === "denied" && (
        <p className="text-warning">
          Push notifications are blocked in this browser — allow them in the browser's site settings
          for this page, then reload.
        </p>
      )}
      {pushState === "unsupported" && (
        <p className="text-warning">
          This browser does not support Web Push (needs HTTPS or localhost, and a
          service-worker-capable browser).
        </p>
      )}
      {pushState === "unknown" && <p className="text-muted">Checking…</p>}
    </Surface>
  );
}

const ROLES = [
  "planner",
  "redteam",
  "sme",
  "coder",
  "outsider",
  "builder",
  "qc",
  "fixer",
] as const;
const EFFORTS = [
  "low",
  "medium",
  "high",
];

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export function SettingsView() {
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  const [cap, setCap] = useState<Record<string, unknown> | null>(null);
  const [msg, setMsg] = useState("");
  type PresetT = {
    id: string;
    name: string;
    routes: Record<
      string,
      {
        provider: string;
        model: string;
        effort: string;
      }
    >;
    critical: {
      onQuota: boolean;
      failureRatePercent: number;
      errorRatePercent: number;
      minSamples: number;
    };
  };
  const [presets, setPresetsState] = useState<PresetT[]>([]);
  const [activePresetId, setActivePresetIdState] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  const load = async () => {
    const { d } = await api("/api/settings");
    setS(d as Record<string, unknown>);
    const c = await api("/api/capacity").catch(() => ({
      d: {},
    }));
    setCap(c.d as Record<string, unknown>);
  };
  useEffect(() => {
    void load().catch(() => setS({}));
  }, []);
  useEffect(() => {
    if (!s) return;
    const list = ((s.presets as PresetT[]) ?? []).map((x) => ({
      ...x,
      critical: x.critical ?? {
        onQuota: true,
        failureRatePercent: 0,
        errorRatePercent: 0,
        minSamples: 5,
      },
      routes: {
        ...x.routes,
      },
    }));
    setPresetsState(list);
    setActivePresetIdState(String(s.activePresetId ?? list[0]?.id ?? ""));
    setEditingPresetId((cur) => cur || String(s.activePresetId ?? list[0]?.id ?? ""));
  }, [
    s,
  ]);
  if (!s) return <p>Loading settings…</p>;
  const providers = (s.providers ?? []) as {
    id: string;
    label: string;
    binary: string;
    installed: boolean;
    suggestedModels: string[];
    supportsEffort: boolean;
    supportsResume: boolean;
  }[];
  const editingPreset = presets.find((x) => x.id === editingPresetId) ?? presets[0];
  const suggested = (s.suggestedPresets ?? []) as PresetT[];
  const healthByProvider = (s.providerHealth ?? {}) as Record<
    string,
    {
      samples: number;
      failureRatePercent: number;
      errorRatePercent: number;
    } | null
  >;
  const patchPresetCritical = (
    id: string,
    field: keyof PresetT["critical"],
    value: boolean | number,
  ) => {
    setPresetsState((list) =>
      list.map((x) =>
        x.id === id
          ? {
              ...x,
              critical: {
                ...x.critical,
                [field]: value,
              },
            }
          : x,
      ),
    );
  };
  const presetSummary = (preset: PresetT): string => {
    const group = (roleNames: string[]) => {
      const seen = new Map<string, string>();
      for (const r of roleNames) {
        const route = preset.routes[r];
        if (route) seen.set(`${route.provider}:${route.model}`, `${route.provider} ${route.model}`);
      }
      return (
        [
          ...seen.values(),
        ].join(", ") || "—"
      );
    };
    return `Build: ${group([
      "builder",
      "coder",
      "qc",
      "fixer",
    ])} · Check: ${group([
      "planner",
      "redteam",
      "sme",
    ])}`;
  };
  const patchPresetRoute = (
    role: string,
    field: "provider" | "model" | "effort",
    value: string,
  ) => {
    if (!editingPreset) return;
    setPresetsState((list) =>
      list.map((x) =>
        x.id === editingPreset.id
          ? {
              ...x,
              routes: {
                ...x.routes,
                [role]: {
                  ...(x.routes[role] ?? {
                    provider: "muse",
                    model: "",
                    effort: "medium",
                  }),
                  [field]: value,
                },
              },
            }
          : x,
      ),
    );
  };
  const save = async (patch: Record<string, unknown>, label: string) => {
    const { r, d } = await api("/api/settings", post(patch));
    if (!r.ok) {
      setMsg(`Not saved: ${String(d.error ?? r.status)}`);
      return;
    }
    setMsg(`${label} saved — applies live, no restart needed.`);
    await load();
  };
  const rows: [
    string,
    string,
    string,
  ][] = [
    [
      "Dashboard port",
      String(s.port ?? "—"),
      "DASHBOARD_PORT",
    ],
    [
      "Data folder",
      String(s.dataDir ?? "—"),
      "FACTORY_DATA",
    ],
    [
      "Agent command",
      s.agentCommand ? String(s.agentCommand) : "built-in Muse station command",
      "DASHBOARD_AGENT_COMMAND",
    ],
    [
      "Login gate",
      s.authConfigured ? "configured (DASHBOARD_USER / DASHBOARD_PASS set)" : "NOT CONFIGURED",
      "DASHBOARD_USER + DASHBOARD_PASS",
    ],
  ];
  const advice = cap?.ramAdvice as
    | {
        action: string;
        suggested: number;
        reason: string;
      }
    | null
    | undefined;
  return (
    <div>
      <h2>Settings</h2>
      <p className="text-muted">
        Editable values apply live and persist across restarts. Deployment facts at the bottom are
        set by environment at server start.
      </p>
      <PushSettings />
      {msg && <p className="font-bold">{msg}</p>}

      <Surface surface="elevated" className="border p-4 my-3">
        <h3 className="mt-0">Capacity &amp; dispatcher</h3>
        <div className="flex flex-col gap-3">
          <label className="flex gap-4 items-center flex-wrap">
            Parallel tasks (max)
            <input
              type="number"
              min={1}
              max={32}
              className={`${inputCls} w-24`}
              defaultValue={String(s.maxParallelTasks ?? 15)}
              id="set-cap"
            />
            <button
              className={btnCls}
              onClick={() =>
                void save(
                  {
                    maxParallelTasks: Number(
                      (document.getElementById("set-cap") as HTMLInputElement)?.value,
                    ),
                  },
                  "Parallel tasks",
                )
              }
            >
              Save
            </button>
            {advice && (
              <span className="text-warning font-bold">
                RAM advice: {advice.action} to {advice.suggested} — {advice.reason}
              </span>
            )}
          </label>
          <label className="flex gap-4 items-center flex-wrap">
            RAM floor (MB) — dispatch pauses below this
            <input
              type="number"
              min={0}
              max={65536}
              className={`${inputCls} w-28`}
              defaultValue={String(s.ramFloorMb ?? 1024)}
              id="set-ram"
            />
            <button
              className={btnCls}
              onClick={() =>
                void save(
                  {
                    ramFloorMb: Number(
                      (document.getElementById("set-ram") as HTMLInputElement)?.value,
                    ),
                  },
                  "RAM floor",
                )
              }
            >
              Save
            </button>
          </label>
          <div className="flex gap-4 items-center flex-wrap">
            <span>
              Dispatcher:{" "}
              <b>
                {s.dispatchEnabled
                  ? "on — queued tasks start automatically"
                  : "PAUSED — nothing new launches"}
              </b>
            </span>
            <button
              className={s.dispatchEnabled ? btnDangerCls : btnCls}
              onClick={() =>
                void save(
                  {
                    dispatchEnabled: !s.dispatchEnabled,
                  },
                  "Dispatcher",
                )
              }
            >
              {s.dispatchEnabled ? "Pause dispatcher" : "Resume dispatcher"}
            </button>
          </div>
        </div>
      </Surface>

      <Surface surface="elevated" className="border p-4 my-3">
        <h3 className="mt-0">Model presets — who builds, who checks</h3>
        <p className="text-muted text-sm">
          A preset is a complete routing set: which CLI runner (each is a different subscription
          with its own quota), model and effort every station uses. Keep as many presets as you
          like, in swap order: when the active preset's provider runs out of quota, the whole
          factory swaps to the next preset and the station retries there. A good default with a
          second subscription is cross-family — one family writes the code, a different one checks
          it.
        </p>
        {providers.map((prov) => (
          <datalist key={prov.id} id={`models-${prov.id}`}>
            {prov.suggestedModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        ))}
        <div className="flex gap-3 items-center flex-wrap my-2">
          <label className="font-bold" htmlFor="preset-active-select">
            Active preset
          </label>
          <select
            id="preset-active-select"
            data-testid="preset-active-select"
            className={inputCls}
            value={activePresetId}
            onChange={(e) => setActivePresetIdState(e.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <span className="text-muted text-sm">
            Auto-selects the next preset when a switch rule below fires. Order is the chain.
          </span>
        </div>
        <div className="flex flex-col gap-2" data-testid="presets-list">
          {presets.map((preset, i) => (
            <div
              key={preset.id}
              data-testid={`preset-card-${preset.id}`}
              className="flex gap-3 items-center flex-wrap border border-surface-elevated-border p-3"
            >
              <b className="min-w-[220px]">
                {i + 1}. {preset.name}
                {preset.id === activePresetId ? " — active" : ""}
              </b>
              <button
                className={btnGhostCls}
                data-testid={`preset-edit-${preset.id}`}
                onClick={() => setEditingPresetId(preset.id)}
              >
                Edit
              </button>
              <button
                className={btnGhostCls}
                data-testid={`preset-activate-${preset.id}`}
                disabled={preset.id === activePresetId}
                onClick={() => setActivePresetIdState(preset.id)}
              >
                Set active
              </button>
              <button
                className={btnGhostCls}
                disabled={i === 0}
                onClick={() =>
                  setPresetsState((list) => {
                    const n = [
                      ...list,
                    ];
                    [n[i - 1], n[i]] = [
                      n[i] as PresetT,
                      n[i - 1] as PresetT,
                    ];
                    return n;
                  })
                }
              >
                ↑
              </button>
              <button
                className={btnGhostCls}
                disabled={i === presets.length - 1}
                onClick={() =>
                  setPresetsState((list) => {
                    const n = [
                      ...list,
                    ];
                    [n[i + 1], n[i]] = [
                      n[i] as PresetT,
                      n[i + 1] as PresetT,
                    ];
                    return n;
                  })
                }
              >
                ↓
              </button>
              <button
                className={btnGhostCls}
                onClick={() =>
                  setPresetsState((list) => [
                    ...list,
                    {
                      ...preset,
                      id: `preset-${Date.now()}`,
                      name: `${preset.name} (copy)`,
                      routes: {
                        ...preset.routes,
                      },
                    },
                  ])
                }
              >
                Duplicate
              </button>
              <button
                className={btnGhostCls}
                disabled={presets.length <= 1}
                onClick={() => setPresetsState((list) => list.filter((x) => x.id !== preset.id))}
              >
                Delete
              </button>
              <div className="basis-full border-t border-surface-elevated-border pt-2 text-sm">
                <div className="text-muted">{presetSummary(preset)}</div>
                <div className="flex gap-4 items-center flex-wrap mt-1">
                  <span className="font-bold">Switch to next preset when:</span>
                  <label className="flex gap-1 items-center">
                    <input
                      type="checkbox"
                      checked={preset.critical?.onQuota ?? true}
                      onChange={(e) => patchPresetCritical(preset.id, "onQuota", e.target.checked)}
                    />{" "}
                    quota exhausted
                  </label>
                  <label className="flex gap-1 items-center">
                    failure rate ≥{" "}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={`${inputCls} w-16`}
                      data-testid={`preset-critical-failure-${preset.id}`}
                      value={preset.critical?.failureRatePercent ?? 0}
                      onChange={(e) =>
                        patchPresetCritical(preset.id, "failureRatePercent", Number(e.target.value))
                      }
                    />
                    %
                  </label>
                  <label className="flex gap-1 items-center">
                    provider errors ≥{" "}
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={`${inputCls} w-16`}
                      data-testid={`preset-critical-error-${preset.id}`}
                      value={preset.critical?.errorRatePercent ?? 0}
                      onChange={(e) =>
                        patchPresetCritical(preset.id, "errorRatePercent", Number(e.target.value))
                      }
                    />
                    %
                  </label>
                  <label className="flex gap-1 items-center">
                    after{" "}
                    <input
                      type="number"
                      min={1}
                      max={100}
                      className={`${inputCls} w-16`}
                      value={preset.critical?.minSamples ?? 5}
                      onChange={(e) =>
                        patchPresetCritical(preset.id, "minSamples", Number(e.target.value))
                      }
                    />{" "}
                    stations (0% = rule off)
                  </label>
                </div>
                <div className="text-muted mt-1">
                  Recent health:{" "}
                  {[
                    ...new Set(Object.values(preset.routes).map((r) => r.provider)),
                  ]
                    .map((provider) => {
                      const h = healthByProvider[provider];
                      return h
                        ? `${provider} ${h.failureRatePercent}% failed / ${h.errorRatePercent}% errors (${h.samples})`
                        : `${provider} no samples yet`;
                    })
                    .join(" · ")}
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="flex gap-3 flex-wrap">
          <button
            className={btnGhostCls}
            data-testid="preset-add"
            onClick={() => {
              const copy = editingPreset ?? presets[0];
              if (copy) {
                const np: PresetT = {
                  ...copy,
                  id: `preset-${Date.now()}`,
                  name: "New preset",
                  routes: {
                    ...copy.routes,
                  },
                };
                setPresetsState((list) => [
                  ...list,
                  np,
                ]);
                setEditingPresetId(np.id);
              }
            }}
          >
            + Add preset
          </button>
          <button
            className={btnCls}
            data-testid="preset-save"
            onClick={() =>
              void save(
                {
                  presets,
                  activePresetId,
                },
                "Model presets",
              )
            }
          >
            Save presets
          </button>
        </p>
        {suggested.length > 0 && (
          <>
            <h4>Suggested for your installed agents</h4>
            <p className="flex gap-3 flex-wrap">
              {suggested
                .filter((sp) => !presets.some((x) => x.id === sp.id))
                .map((sp) => (
                  <button
                    key={sp.id}
                    className={btnGhostCls}
                    data-testid={`preset-suggested-${sp.id}`}
                    onClick={() =>
                      setPresetsState((list) => [
                        ...list,
                        sp,
                      ])
                    }
                  >
                    + {sp.name}
                  </button>
                ))}
            </p>
          </>
        )}
        {editingPreset && (
          <>
            <h4>Editing: {editingPreset.name}</h4>
            <div className="flex flex-col gap-2">
              {ROLES.map((role) => (
                <div key={role} className="flex gap-4 items-center flex-wrap">
                  <b className="w-24 shrink-0">{role}</b>
                  <select
                    className={inputCls}
                    data-testid={`route-provider-${role}`}
                    value={editingPreset.routes[role]?.provider ?? "muse"}
                    onChange={(e) => patchPresetRoute(role, "provider", e.target.value)}
                  >
                    {providers.map((prov) => (
                      <option key={prov.id} value={prov.id} disabled={!prov.installed}>
                        {prov.label}
                        {prov.installed ? "" : " — not installed"}
                      </option>
                    ))}
                  </select>
                  <input
                    className={`${inputCls} w-56`}
                    data-testid={`route-model-${role}`}
                    list={`models-${editingPreset.routes[role]?.provider ?? "muse"}`}
                    placeholder="model name"
                    value={editingPreset.routes[role]?.model ?? ""}
                    onChange={(e) => patchPresetRoute(role, "model", e.target.value)}
                  />
                  <select
                    className={inputCls}
                    data-testid={`route-effort-${role}`}
                    value={editingPreset.routes[role]?.effort ?? "medium"}
                    onChange={(e) => patchPresetRoute(role, "effort", e.target.value)}
                  >
                    {EFFORTS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}
      </Surface>

      <Surface surface="elevated" className="border p-4 my-3">
        <h3 className="mt-0">Defaults for new tasks</h3>
        <label className="flex gap-4 items-center flex-wrap">
          Default lane
          <select className={inputCls} defaultValue={String(s.defaultLane ?? "")} id="set-lane">
            <option value="">Auto — triage decides per task</option>
            <option value="fast">Fast</option>
            <option value="standard">Standard</option>
            <option value="careful">Careful</option>
          </select>
          <button
            className={btnCls}
            onClick={() =>
              void save(
                {
                  defaultLane:
                    (document.getElementById("set-lane") as HTMLSelectElement)?.value ?? "",
                },
                "Default lane",
              )
            }
          >
            Save
          </button>
        </label>
        <p className="text-muted text-sm">
          Applies to tasks stated after the save; a lane chosen on the State-a-task form or in Task
          details still wins.
        </p>
        <label className="flex gap-4 items-center flex-wrap mt-3">
          Plan approval
          <select
            className={inputCls}
            defaultValue={String(s.approvalMode ?? "auto")}
            id="set-approval"
          >
            <option value="auto">Move forward automatically — no click needed</option>
            <option value="click">Wait for my click to approve each plan</option>
          </select>
          <button
            className={btnCls}
            onClick={() =>
              void save(
                {
                  approvalMode:
                    (document.getElementById("set-approval") as HTMLSelectElement)?.value ?? "auto",
                },
                "Plan approval",
              )
            }
          >
            Save
          </button>
        </label>
        <p className="text-muted text-sm">
          Automatic applies to plans with no open questions, in every lane. Open planner questions
          always wait for you either way.
        </p>
      </Surface>

      <Surface surface="elevated" className="border p-4 my-3">
        <h3 className="mt-0">Global souls</h3>
        <p className="text-muted text-sm">
          Used by the SME and coder reviewers when a project has no soul of its own. A project's own
          soul always wins. Empty means the built-in composed default.
        </p>
        <label className="block font-bold mb-1" htmlFor="set-sme-soul">
          Global SME soul
        </label>
        <textarea
          id="set-sme-soul"
          className={`${inputCls} w-full`}
          rows={4}
          defaultValue={String(s.smeSoul ?? "")}
          placeholder="Built-in default in use"
        />
        <label className="block font-bold mb-1 mt-3" htmlFor="set-coder-soul">
          Global coder soul
        </label>
        <textarea
          id="set-coder-soul"
          className={`${inputCls} w-full`}
          rows={4}
          defaultValue={String(s.coderSoul ?? "")}
          placeholder="Built-in default in use"
        />
        <p>
          <button
            className={btnCls}
            onClick={() =>
              void save(
                {
                  smeSoul:
                    (document.getElementById("set-sme-soul") as HTMLTextAreaElement)?.value ?? "",
                  coderSoul:
                    (document.getElementById("set-coder-soul") as HTMLTextAreaElement)?.value ?? "",
                },
                "Global souls",
              )
            }
          >
            Save global souls
          </button>
        </p>
      </Surface>

      <Surface surface="elevated" className="border p-4 my-3">
        <h3 className="mt-0">Deployment (read-only)</h3>
        {rows.map(([label, value, env]) => (
          <div
            key={label}
            className="flex gap-4 py-2 border-b border-surface-elevated-border last:border-b-0 max-md:flex-col max-md:gap-1"
          >
            <b className="w-56 shrink-0">{label}</b>
            <span
              className={`flex-1 ${label === "Login gate" && value === "NOT CONFIGURED" ? "text-danger font-bold" : ""}`}
            >
              {value}
              {label === "Login gate" && value === "NOT CONFIGURED"
                ? " — anyone who can reach this page can drive the factory"
                : ""}
            </span>
            <code className="bg-surface-sink px-1 text-sm">{env}</code>
          </div>
        ))}
      </Surface>
      <p className="text-muted">
        Per-project settings (description, rules, souls, test mode) live on each project's own page.
        Per-task settings (verify command, lane, plan) live on the task page.
      </p>
    </div>
  );
}

// One div per source line; a line's comment field appears only when
// clicked. Empty lines are not clickable. Drafts live in parent state,
// so the 5s refresh never eats typing. Plan lines render their markdown
// (headings, lists, code fences, bold/code) instead of raw source text.
function inlineMd(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={i} className="bg-surface-sink px-1">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <i key={i}>{part.slice(1, -1)}</i>;
    return part;
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
function mdLine(
  ln: string,
  state: {
    inCode: boolean;
  },
): ReactNode {
  const trimmed = ln.trim();
  if (trimmed.startsWith("```")) {
    state.inCode = !state.inCode;
    return <span className="font-mono text-muted">{ln}</span>;
  }
  if (state.inCode) return <span className="font-mono whitespace-pre">{ln}</span>;
  const h = ln.match(/^(#{1,6})\s+(.*)/);
  if (h) {
    const lvl = h[1]?.length ?? 3;
    const cls =
      lvl === 1 ? "text-2xl" : lvl === 2 ? "text-xl" : lvl === 3 ? "text-lg" : "text-base";
    return <span className={`${cls} font-bold text-primary`}>{inlineMd(h[2] ?? "")}</span>;
  }
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln))
    return <span className="block border-t border-surface-base-border my-1">&nbsp;</span>;
  if (trimmed.startsWith(">"))
    return (
      <span className="italic text-muted border-l-2 border-surface-base-border pl-2">
        {inlineMd(trimmed.slice(1).trim())}
      </span>
    );
  const li = ln.match(/^(\s*)[-*]\s+(.*)/);
  if (li) {
    let text = li[2] ?? "";
    let bullet = "•";
    if (text.startsWith("[ ] ")) {
      bullet = "☐";
      text = text.slice(4);
    } else if (text.startsWith("[x] ")) {
      bullet = "☑";
      text = text.slice(4);
    }
    return (
      <span
        style={{
          paddingLeft: `${(li[1]?.length ?? 0) / 2 + 1}rem`,
        }}
      >
        {bullet} {inlineMd(text)}
      </span>
    );
  }
  const num = ln.match(/^(\s*)(\d+)[.)]\s+(.*)/);
  if (num)
    return (
      <span
        style={{
          paddingLeft: `${(num[1]?.length ?? 0) / 2 + 1}rem`,
        }}
      >
        {num[2]}. {inlineMd(num[3] ?? "")}
      </span>
    );
  return <>{inlineMd(ln)}</>;
}

function LineRows({
  lines,
  section,
  comments,
  openLines,
  onToggle,
  onComment,
  readOnly = false,
}: {
  lines: string[];
  section: string;
  comments: Record<string, string>;
  openLines: Set<string>;
  onToggle: (key: string) => void;
  onComment: (key: string, value: string) => void;
  readOnly?: boolean;
}) {
  const mdState = {
    inCode: false,
  };
  return (
    <div>
      {lines.map((ln, i) => {
        if (!ln.trim())
          return (
            <div key={i} className="border-b border-surface-base-border py-1">
              <span className="text-muted text-xs">{i + 1}</span> <span>&nbsp;</span>
            </div>
          );
        const key = `${section}:${i}`;
        const open = openLines.has(key) || !!comments[key]?.trim();
        return (
          <div
            key={i}
            className={`border-b border-surface-base-border py-1 ${readOnly ? "" : "cursor-pointer hover:bg-surface-sink"}`}
            title={readOnly ? undefined : "Click to comment on this line"}
            onClick={readOnly ? undefined : () => onToggle(key)}
          >
            <span className="text-muted text-xs">{i + 1}</span>{" "}
            <span className="whitespace-pre-wrap break-words">
              {section === "plan" ? mdLine(ln, mdState) : ln}
            </span>
            {open && (
              <input
                className="block w-[95%] mt-1 p-1 bg-surface-elevated text-on-surface-elevated border border-surface-elevated-border disabled:bg-surface-sink disabled:text-muted"
                placeholder="comment on this line"
                value={comments[key] ?? ""}
                disabled={readOnly}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onComment(key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Material-Tailwind-style accordion: bordered item, full-width header,
// chevron rotates on open, body animates via grid rows.
function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-surface-elevated-border rounded-md mb-2 bg-surface-elevated">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left font-bold cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          size={18}
          className={`shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`grid transition-all duration-300 ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "px-2 py-1.5 rounded-md bg-surface-elevated text-on-surface-elevated border border-surface-elevated-border focus:outline-none focus:ring-2 focus:ring-accent";
const btnCls =
  "px-4 py-2 rounded-md bg-primary text-on-primary border border-primary font-bold shadow-sm cursor-pointer inline-flex items-center justify-center gap-1.5 hover:opacity-90 active:translate-y-px disabled:opacity-50 disabled:cursor-default";
const btnGhostCls =
  "px-4 py-2 rounded-md bg-surface-elevated text-on-surface-elevated border-2 border-primary font-bold shadow-sm cursor-pointer inline-flex items-center justify-center gap-1.5 hover:bg-surface-sink active:translate-y-px disabled:opacity-50 disabled:cursor-default";
const btnDangerCls =
  "px-4 py-2 rounded-md bg-danger text-on-danger border border-danger font-bold shadow-sm cursor-pointer inline-flex items-center justify-center gap-1.5 hover:opacity-90 active:translate-y-px disabled:opacity-50 disabled:cursor-default";
const labelCls = "block font-bold mb-1";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
function ProjectDetail({
  p,
  tasks,
  requests,
  onOpen,
  onStateTask,
  refresh,
}: {
  p: Project;
  tasks: Task[];
  requests: UserRequest[];
  onOpen: (taskId: string) => void;
  onStateTask: () => void;
  refresh: () => void;
}) {
  const [ctx, setCtx] = useState({
    description: p.description,
    businessPlan: p.businessPlan,
    goals: p.goals.join("\n"),
    moat: p.moat,
    rules: p.rules,
    smeSoul: p.smeSoul,
    coderSoul: p.coderSoul,
  });
  const [devCfg, setDevCfg] = useState({
    devCommand: p.devCommand,
    devPort: String(p.devPort || ""),
    testMode: p.testMode,
  });
  const [devLog, setDevLog] = useState<string[]>([]);
  useEffect(() => {
    if (!p.dev.running) return;
    api(`/api/projects/${encodeURIComponent(p.id)}/dev`)
      .then(({ d }) => setDevLog((d.log as string[]) ?? []))
      .catch(() => {});
  }, [
    p.id,
    p.dev.running,
  ]);
  const mine = tasks.filter((t) => t.projectId === p.id);
  const byRecent = (a: Task, b: Task) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  const waiting = requests.filter((r) => r.projectId === p.id);
  const doing = mine.filter((t) => t.state === "running" || t.state === "in-review").sort(byRecent);
  const done = mine.filter((t) => t.state === "done").sort(byRecent);
  const planned = mine.filter((t) => t.state === "planned").sort(byRecent);
  const taskLine = (t: Task) => (
    <li key={t.id} className="my-1">
      <button className="text-left cursor-pointer hover:text-primary" onClick={() => onOpen(t.id)}>
        {t.title}
      </button>{" "}
      <span className="text-muted text-sm">
        · {ageText(t.updatedAt)} ago{t.liveActor ? ` · ${t.liveActor}` : ""}
        {t.liveLast ? ` · ${t.liveLast.slice(0, 80)}` : ""}
      </span>
    </li>
  );
  const saveDev = () =>
    api(
      `/api/projects/${encodeURIComponent(p.id)}/dev-config`,
      post({
        devCommand: devCfg.devCommand,
        devPort: Number(devCfg.devPort || 0),
        testMode: devCfg.testMode,
      }),
    );
  const devUrl = `http://${location.hostname}:${p.devPort || 3000}/`;
  const suggestions = p.scoutSuggestions ?? null;
  const suggestionRow = (label: string, key: "description" | "rules" | "smeSoul" | "coderSoul") => {
    const text = suggestions?.[key];
    if (!text) return null;
    return (
      <Surface surface="sink" className="border p-2 my-1">
        <b>Scout suggestion — {label}:</b>
        <p className="whitespace-pre-wrap">{text}</p>
        <button
          type="button"
          className={btnCls}
          onClick={() =>
            setCtx((c) => ({
              ...c,
              [key]: text,
            }))
          }
        >
          Use suggestion
        </button>
      </Surface>
    );
  };
  return (
    <div>
      <h2>{p.name}</h2>
      <p className="text-muted">
        {p.repoPath || "(folder offline)"} ·{" "}
        {p.online ? (
          <span className="text-up">online</span>
        ) : (
          <span className="text-muted">offline</span>
        )}
        {p.online && ` · data at commit ${short(p.lastCommit)}`}
        {p.stale && (
          <>
            {" "}
            ·{" "}
            <span className="text-danger font-bold">
              STALE — folder now at {short(p.currentCommit)}
            </span>{" "}
            <button
              className={btnCls}
              onClick={async () => {
                await api(`/api/projects/${encodeURIComponent(p.id)}/sync`, {
                  method: "POST",
                });
                refresh();
              }}
            >
              Sync to current commit
            </button>
          </>
        )}
        {` · dev ${p.dev.running ? `running on :${p.dev.port}` : "stopped"}`}
        {p.ci?.suggestedVerify && ` · verified by ${p.ci.suggestedVerify}`}
      </p>
      <Surface surface="elevated" className="border p-4 my-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3>Work on this project</h3>
          <button className={btnCls} onClick={onStateTask}>
            State a task
          </button>
        </div>
        <p className="flex gap-4 flex-wrap">
          <span>
            <b>{done.length}</b> done
          </span>
          <span>
            <b>{doing.length}</b> doing
          </span>
          <span className={waiting.length ? "text-danger font-bold" : ""}>
            <b>{waiting.length}</b> waiting on you
          </span>
          <span>
            <b>{planned.length}</b> planned
          </span>
        </p>
        <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
          <div>
            <b>Waiting on you</b>
            {waiting.length ? (
              <ul>
                {waiting.slice(0, 6).map((r) => (
                  <li key={r.key} className="my-1">
                    <button
                      className="text-left cursor-pointer hover:text-primary"
                      onClick={() => onOpen(r.taskId)}
                    >
                      {r.title}
                    </button>{" "}
                    <span className="text-muted text-sm">· {requestLabel(r.kind)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Nothing waiting.</p>
            )}
          </div>
          <div>
            <b>Doing</b>
            {doing.length ? (
              <ul>{doing.slice(0, 6).map(taskLine)}</ul>
            ) : (
              <p className="text-muted">Nothing running.</p>
            )}
          </div>
          <div>
            <b>Done (recent)</b>
            {done.length ? (
              <ul>{done.slice(0, 6).map(taskLine)}</ul>
            ) : (
              <p className="text-muted">Nothing finished yet.</p>
            )}
          </div>
        </div>
        {(waiting.length > 6 || doing.length > 6 || done.length > 6 || planned.length > 0) && (
          <p className="text-muted text-sm">
            Full flow, including all {planned.length} planned, is in Features.
          </p>
        )}
      </Surface>
      <h3>Project settings</h3>
      <Surface surface="elevated" className="border p-4 my-3">
        <h3>Project context — sets the SME soul</h3>
        <p className="text-muted">
          {p.scouting ? (
            "Scout is checking this project again… suggestions will appear below."
          ) : (
            <>
              Context stale?{" "}
              <button
                type="button"
                className="cursor-pointer underline hover:text-primary"
                onClick={async () => {
                  await api(`/api/projects/${encodeURIComponent(p.id)}/scout`, {
                    method: "POST",
                  });
                  refresh();
                }}
              >
                Re-check with scout
              </button>{" "}
              — suggestions land next to each field.
            </>
          )}
          {suggestions?.error && (
            <span className="text-danger font-bold"> Scout failed: {suggestions.error}</span>
          )}
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await api(`/api/projects/${encodeURIComponent(p.id)}/context`, post(ctx));
            refresh();
          }}
        >
          <div>
            {suggestionRow("Description", "description")}
            <label className={labelCls}>Description</label>
            <textarea
              className={`${inputCls} w-full`}
              rows={2}
              placeholder="Description"
              value={ctx.description}
              onChange={(e) =>
                setCtx({
                  ...ctx,
                  description: e.target.value,
                })
              }
            />
          </div>
          <div>
            <label className={labelCls}>Business plan</label>
            <textarea
              className={`${inputCls} w-full`}
              rows={3}
              placeholder="Business plan: what, who for, where going"
              value={ctx.businessPlan}
              onChange={(e) =>
                setCtx({
                  ...ctx,
                  businessPlan: e.target.value,
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div>
              <label className={labelCls}>Goals (one per line)</label>
              <textarea
                className={`${inputCls} w-full`}
                rows={3}
                placeholder="Goals, one per line"
                value={ctx.goals}
                onChange={(e) =>
                  setCtx({
                    ...ctx,
                    goals: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <label className={labelCls}>Moat</label>
              <textarea
                className={`${inputCls} w-full`}
                rows={3}
                placeholder="Moat: what makes this defensible"
                value={ctx.moat}
                onChange={(e) =>
                  setCtx({
                    ...ctx,
                    moat: e.target.value,
                  })
                }
              />
            </div>
          </div>
          <div>
            {suggestionRow("General rules", "rules")}
            <label className={labelCls}>General rules</label>
            <textarea
              className={`${inputCls} w-full`}
              rows={3}
              placeholder="General rules every agent must respect"
              value={ctx.rules}
              onChange={(e) =>
                setCtx({
                  ...ctx,
                  rules: e.target.value,
                })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div>
              {suggestionRow("SME soul", "smeSoul")}
              <label className={labelCls}>SME soul</label>
              <textarea
                className={`${inputCls} w-full`}
                rows={4}
                placeholder="SME soul (optional, overrides derivation)"
                value={ctx.smeSoul}
                onChange={(e) =>
                  setCtx({
                    ...ctx,
                    smeSoul: e.target.value,
                  })
                }
              />
            </div>
            <div>
              {suggestionRow("Developer soul", "coderSoul")}
              <label className={labelCls}>Developer soul</label>
              <textarea
                className={`${inputCls} w-full`}
                rows={4}
                placeholder="Coder reviewer soul (optional, overrides derivation)"
                value={ctx.coderSoul}
                onChange={(e) =>
                  setCtx({
                    ...ctx,
                    coderSoul: e.target.value,
                  })
                }
              />
            </div>
          </div>
          <div>
            <button className={btnCls}>Save project context</button>
          </div>
        </form>
        <Accordion title="Effective SME soul">
          <pre className="bg-surface-sink p-2 whitespace-pre-wrap">
            {p.smePersona || "(not set)"}
          </pre>
        </Accordion>
        <Accordion title="Effective coder reviewer soul">
          <pre className="bg-surface-sink p-2 whitespace-pre-wrap">
            {p.coderPersona || "(not set)"}
          </pre>
        </Accordion>
      </Surface>
      <Surface surface="elevated" className="border p-4 my-3">
        <h3>Dev mode</h3>
        {p.dev.running ? (
          <p>
            <span className="text-up">running</span> since {p.dev.since ?? ""} on port {p.dev.port}{" "}
            —{" "}
            <a href={devUrl} target="_blank" rel="noopener noreferrer">
              Open dev app
            </a>{" "}
            <button
              className={btnDangerCls}
              onClick={async () => {
                await api(`/api/projects/${encodeURIComponent(p.id)}/dev/stop`, {
                  method: "POST",
                });
                refresh();
              }}
            >
              <Square size={14} /> Stop dev
            </button>
          </p>
        ) : (
          <p className="text-muted">stopped</p>
        )}
        {p.dev.running && (
          <pre className="bg-surface-sink p-2 whitespace-pre-wrap max-h-96 overflow-auto">
            {devLog.join("\n") || "(no output yet)"}
          </pre>
        )}
        {p.testMode === "dev" && !p.devCommand && (
          <p className="text-danger font-bold">
            Test mode is “run it” but no dev command is configured yet — add one below, or change
            how this project is tested.
          </p>
        )}
        {p.testMode === "push-only" && (
          <p>
            No local test run for this project: agents present diffs, and you test and push
            yourself.
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await saveDev();
            refresh();
          }}
        >
          <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
            <div>
              <label className={labelCls}>Tested by</label>
              <select
                className={`${inputCls} w-full`}
                value={devCfg.testMode}
                onChange={(e) =>
                  setDevCfg({
                    ...devCfg,
                    testMode: e.target.value,
                  })
                }
              >
                <option value="dev">Run it — dev mode</option>
                <option value="checks">Automated checks only</option>
                <option value="push-only">Changes only — I test &amp; push</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Dev command</label>
              <input
                className={`${inputCls} w-full`}
                placeholder="dev command, e.g. bun run dev"
                value={devCfg.devCommand}
                onChange={(e) =>
                  setDevCfg({
                    ...devCfg,
                    devCommand: e.target.value,
                  })
                }
              />
            </div>
            <div>
              <label className={labelCls}>Dev port</label>
              <input
                className={`${inputCls} w-full`}
                type="number"
                placeholder="port"
                value={devCfg.devPort}
                onChange={(e) =>
                  setDevCfg({
                    ...devCfg,
                    devPort: e.target.value,
                  })
                }
              />
            </div>
          </div>
          <div className="flex gap-4 mt-4">
            <button className={btnCls}>Save dev config</button>
            {!p.dev.running && (
              <button
                type="button"
                className={btnGhostCls}
                onClick={async () => {
                  await saveDev();
                  const { r, d } = await api(
                    `/api/projects/${encodeURIComponent(p.id)}/dev/start`,
                    {
                      method: "POST",
                    },
                  );
                  if (!r.ok) alert((d.error as string) || "dev failed to start");
                  refresh();
                }}
              >
                <Play size={14} /> Run dev
              </button>
            )}
          </div>
        </form>
      </Surface>
      <Surface surface="elevated" className="border p-4 my-3">
        <h3>CI — what gates this project</h3>
        {p.ci && p.ci.workflows.length ? (
          <>
            {p.ci.workflows.map((w) => (
              <p key={w.file} className="my-2">
                <b>{w.name}</b>{" "}
                <span className="text-muted text-sm">
                  {w.file}
                  {w.runsOn ? ` · runs on ${w.runsOn}` : ""}
                  {w.triggers.length ? ` · on ${w.triggers.join(", ")}` : ""}
                </span>
                {w.heavy && (
                  <span className="bg-warning text-on-warning px-2 py-0.5 text-sm ml-2">
                    heavy — not a per-task check
                  </span>
                )}
                <br />
                <span className="text-muted text-sm">
                  {w.runs.length ? `runs: ${w.runs.join(" · ")}` : "no run commands found"}
                </span>
              </p>
            ))}
            {p.ci.notInCi.length > 0 && (
              <p className="text-warning font-bold">
                Not in any workflow: {p.ci.notInCi.join(", ")} — CI never runs these checks.
              </p>
            )}
            {p.ci.suggestedVerify ? (
              <p>
                Tasks stated without a verify command inherit:{" "}
                <code className="bg-surface-sink px-1">{p.ci.suggestedVerify}</code>
              </p>
            ) : (
              <p className="text-muted">
                No test/typecheck/lint script found, so tasks get no inherited verify command.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted">
            No CI workflows found in <code className="bg-surface-sink px-1">.gitea/workflows</code>,{" "}
            <code className="bg-surface-sink px-1">.github/workflows</code> or{" "}
            <code className="bg-surface-sink px-1">.gitlab-ci.yml</code>.
            {p.ci?.suggestedVerify && (
              <>
                {" "}
                Tasks still inherit{" "}
                <code className="bg-surface-sink px-1">{p.ci.suggestedVerify}</code> from package
                scripts.
              </>
            )}
          </p>
        )}
      </Surface>
    </div>
  );
}

// Visual Review panel: Argos-style screenshot diffs (Before = base
// commit, After = feature branch, Diff = changed pixels in red).
// Screenshots are served from the factory data dir — never from git.
// Approve lands the work; Request changes sends per-shot comments to
// the builder and Visual Review re-captures after the rework.

function VisualStatusBadge({
  state,
  status,
  pending,
}: {
  state?: string;
  status?: string;
  pending: boolean;
}) {
  if (state === "approved" || status === "approved")
    return <span className="text-success font-bold">Approved — landing</span>;
  if (state === "passed" || status === "passed")
    return <span className="text-success font-bold">Passed — no visual changes</span>;
  if (state === "changes-requested")
    return <span className="text-warning font-bold">Changes requested — builder reworking</span>;
  if (pending)
    return (
      <span className="text-warning font-bold">
        Waiting for your approval — work will not land yet
      </span>
    );
  return null;
}

type VisualShot = NonNullable<TaskDetailData["visual"]>["shots"][number];
function VisualShotRow({
  s,
  taskId,
  pending,
  commentable,
  comment,
  onComment,
}: {
  s: VisualShot;
  taskId: string;
  pending: boolean;
  commentable: boolean;
  comment: string;
  onComment: (v: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const img = (rel: string) => {
    const [kind, name] = rel.split("/");
    return `/api/tasks/${encodeURIComponent(taskId)}/visual/${kind}/${encodeURIComponent(name ?? "")}`;
  };
  return (
    <div className="border-t border-surface-elevated-border py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <strong>{s.name}</strong>
        <span className="text-muted">
          {s.route} · {s.viewport}
        </span>
        <span className={s.status === "unchanged" ? "text-success" : "text-warning"}>
          {s.status}
          {s.status === "changed" ? ` — ${(s.diffRatio * 100).toFixed(2)}% pixels` : ""}
        </span>
        {s.error && <span className="text-danger text-sm">{s.error}</span>}
        {s.diff && (
          <button type="button" className={btnGhostCls} onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Show after" : "Show diff"}
          </button>
        )}
      </div>
      <div className="flex gap-2 flex-wrap mt-1">
        {s.baseline ? (
          <figure className="m-0">
            <img src={img(s.baseline)} alt={`${s.name} before`} className="max-w-[320px] border" />
            <figcaption className="text-muted text-sm">Before</figcaption>
          </figure>
        ) : (
          <p className="text-muted text-sm">New page — no Before</p>
        )}
        {s.after && (
          <figure className="m-0">
            <img
              src={img(showDiff && s.diff ? s.diff : s.after)}
              alt={`${s.name} after`}
              className="max-w-[320px] border"
            />
            <figcaption className="text-muted text-sm">
              {showDiff && s.diff ? "Diff" : "After"}
            </figcaption>
          </figure>
        )}
      </div>
      {pending && commentable && (
        <input
          className={`${inputCls} w-full mt-1`}
          placeholder={`What must change on ${s.name}? (only sent with Request changes)`}
          value={comment}
          onChange={(e) => onComment(e.target.value)}
        />
      )}
    </div>
  );
}

function VisualReviewPanel({ d, refresh }: { d: TaskDetailData; refresh: () => void }) {
  const t = d.task;
  const visual = d.visual;
  const [comments, setComments] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!visual && (!t.visualState || t.visualState === "none" || t.visualState === "skipped"))
    return null;
  const pending =
    visual?.status === "pending" || t.visualState === "pending" || t.visualState === "error";
  const changed = (visual?.shots ?? []).filter(
    (s) =>
      s.status === "changed" ||
      s.status === "new" ||
      s.status === "missing-after" ||
      s.status === "error",
  );
  const act = async (action: "visual-approve" | "visual-request-changes") => {
    setError("");
    const collected = Object.entries(comments)
      .map(([shot, comment]) => ({
        shot,
        comment: comment.trim(),
      }))
      .filter((c) => c.comment);
    if (action === "visual-request-changes" && !collected.length && !general.trim()) {
      setError("Write what must change — on a screenshot or for the whole review");
      return;
    }
    setBusy(true);
    const { r, d: res } = await api(
      `/api/tasks/${encodeURIComponent(t.id)}/${action}`,
      post({
        comments: collected,
        comment: general.trim(),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      setError((res.error as string) || "visual review action failed");
      return;
    }
    setComments({});
    setGeneral("");
    refresh();
  };
  return (
    <Surface surface="elevated" className="border p-3 my-2 shrink-0 max-h-[70%] overflow-y-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="m-0">Visual Review — screenshot diffs</h3>
        {visual && (
          <span className="text-muted text-sm">
            vs base {(visual.baseCommit ?? "").slice(0, 7) || "HEAD"} ·{" "}
            {new Date(visual.at).toLocaleString()}
          </span>
        )}
        <VisualStatusBadge state={t.visualState} status={visual?.status} pending={pending} />
      </div>
      <p className="text-muted text-sm">
        Before = base commit, After = this feature, Diff = changed pixels in red. Screenshots are
        stored outside git history (factory data only).
      </p>
      {visual?.reason && <p className="text-danger font-bold">{visual.reason}</p>}
      {error && <p className="text-danger font-bold">{error}</p>}
      {(visual?.shots ?? []).map((s) => (
        <VisualShotRow
          key={s.name}
          s={s}
          taskId={t.id}
          pending={pending}
          commentable={changed.some((c) => c.name === s.name)}
          comment={comments[s.name] ?? ""}
          onComment={(v) =>
            setComments((c) => ({
              ...c,
              [s.name]: v,
            }))
          }
        />
      ))}
      {visual?.comments?.length ? (
        <div className="border-t border-surface-elevated-border py-2">
          {visual.comments.map((c, i) => (
            <p key={i} className="m-0 text-sm">
              <i>owner{c.shot ? ` [${c.shot}]` : ""}:</i> {c.comment}
            </p>
          ))}
        </div>
      ) : null}
      {pending && (
        <div className="mt-2">
          <input
            className={`${inputCls} w-full`}
            placeholder="General comment for Request changes (optional)"
            value={general}
            onChange={(e) => setGeneral(e.target.value)}
          />
          <div className="flex gap-4 flex-wrap items-center mt-2">
            <button className={btnCls} disabled={busy} onClick={() => void act("visual-approve")}>
              <Check size={14} /> Approve &amp; land
            </button>
            <button
              className={btnDangerCls}
              disabled={busy}
              onClick={() => void act("visual-request-changes")}
            >
              <Send size={14} /> Request changes
            </button>
            <span className="text-muted text-sm">
              Approve lands this work. Request changes sends your comments back to the builder;
              screenshots are re-captured and diffed again.
            </span>
          </div>
        </div>
      )}
    </Surface>
  );
}

// Retrospective panel: the retro agent's review of the whole run.
// Each finding is a point the owner can comment on, ask about, or turn
// into a task with one click; comments go back to the retro agent,
// which answers and revises the retro.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
function RetroPanel({
  d,
  refresh,
  onOpenTask,
}: {
  d: TaskDetailData;
  refresh: () => void;
  onOpenTask: (id: string) => void;
}) {
  const t = d.task;
  const retro = d.retro;
  const [comments, setComments] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [created, setCreated] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const terminal = t.state === "done" || t.state === "failed";
  if (!retro && !d.retroRunning && !terminal) return null;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const createTask = async (finding: string) => {
    setError("");
    const { r, d: res } = await api(
      "/api/tasks",
      post({
        projectId: t.projectId,
        prompt: `${finding}\n\n(This task comes from the retrospective of "${t.title}" — ${t.id}. Read that task's history for the evidence behind this finding.)`,
      }),
    );
    if (!r.ok) {
      setError(
        (res.error as string) ||
          (Array.isArray(res.reasons) ? (res.reasons as string[]).join("; ") : "") ||
          "creating the task failed",
      );
      return;
    }
    const id = (res.task as Task | undefined)?.id;
    if (id)
      setCreated((c) => ({
        ...c,
        [finding]: id,
      }));
    refresh();
  };
  const sendComments = async () => {
    const collected = Object.entries(comments)
      .map(([k, v]) => ({
        finding: k === "whole" ? "" : k,
        comment: v.trim(),
      }))
      .filter((c) => c.comment);
    if (!collected.length) {
      setError("Write a comment or question on a finding first");
      return;
    }
    setSending(true);
    const { r, d: res } = await api(
      `/api/tasks/${encodeURIComponent(t.id)}/retro-comments`,
      post({
        comments: collected,
      }),
    );
    setSending(false);
    if (!r.ok) {
      setError((res.error as string) || "sending retro comments failed");
      return;
    }
    setComments({});
    refresh();
  };
  return (
    <Surface surface="elevated" className="border p-3 my-2 shrink-0 max-h-[55%] overflow-y-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="m-0">Retrospective</h3>
        {retro && !d.retroRunning && (
          <button
            className={btnGhostCls}
            onClick={async () => {
              await api(`/api/tasks/${encodeURIComponent(t.id)}/retro`, {
                method: "POST",
              });
              refresh();
            }}
          >
            Re-run retro
          </button>
        )}
        {retro &&
          !retro.error &&
          (t.retroReviewedAt ? (
            <span className="text-success font-bold">
              Reviewed {agoText(t.retroReviewedAt)} — feature closed
            </span>
          ) : (
            <button
              className={btnCls}
              onClick={async () => {
                await api(`/api/tasks/${encodeURIComponent(t.id)}/retro-reviewed`, {
                  method: "POST",
                });
                refresh();
              }}
            >
              Mark reviewed &amp; close feature
            </button>
          ))}
      </div>
      {d.retroRunning ? (
        <p>
          <Loader2 size={14} className="animate-spin inline" /> Retro agent is reviewing every agent
          call and decision of this run…
        </p>
      ) : !retro ? (
        <p className="text-muted">
          Runs automatically when a task finishes or fails.{" "}
          <button
            className={btnGhostCls}
            onClick={async () => {
              await api(`/api/tasks/${encodeURIComponent(t.id)}/retro`, {
                method: "POST",
              });
              refresh();
            }}
          >
            Run retro now
          </button>
        </p>
      ) : retro.error ? (
        <p className="text-danger font-bold">Retro failed: {retro.error}</p>
      ) : (
        <>
          <Accordion title="Full retrospective" defaultOpen>
            <p className="whitespace-pre-wrap">{retro.text}</p>
          </Accordion>
          <h4>Findings — what to do better next time</h4>
          {retro.findings.length ? (
            retro.findings.map((f) => (
              <div key={f} className="border-t border-surface-elevated-border py-2">
                <p className="m-0" title={f}>
                  {f.length > 520 ? `${f.slice(0, 520)}…` : f}
                </p>
                <div className="flex gap-4 flex-wrap items-center mt-2">
                  {created[f] ? (
                    <button className={btnCls} onClick={() => onOpenTask(created[f] ?? "")}>
                      Open created task →
                    </button>
                  ) : (
                    <button className={btnCls} onClick={() => void createTask(f)}>
                      Create task from this finding
                    </button>
                  )}
                  <button className={btnGhostCls} onClick={() => toggle(f)}>
                    Comment / ask
                  </button>
                </div>
                {open.has(f) && (
                  <input
                    className={`${inputCls} w-full mt-2`}
                    placeholder="Comment or question on this finding"
                    value={comments[f] ?? ""}
                    onChange={(e) =>
                      setComments((c) => ({
                        ...c,
                        [f]: e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))
          ) : (
            <p className="text-muted">No findings — the retro agent judged this run clean.</p>
          )}
          <div className="border-t border-surface-elevated-border py-2">
            <button className={btnGhostCls} onClick={() => toggle("whole")}>
              Comment / ask about the whole retro
            </button>
            {open.has("whole") && (
              <input
                className={`${inputCls} w-full mt-2`}
                placeholder="Comment or question on the whole retrospective"
                value={comments["whole"] ?? ""}
                onChange={(e) =>
                  setComments((c) => ({
                    ...c,
                    whole: e.target.value,
                  }))
                }
              />
            )}
          </div>
          {error && <p className="text-danger font-bold">{error}</p>}
          <div className="flex gap-4 flex-wrap items-center mt-2">
            <button className={btnCls} disabled={sending} onClick={() => void sendComments()}>
              <Send size={14} /> {sending ? "Sending…" : "Send comments & questions to retro agent"}
            </button>
            <span className="text-muted text-sm">
              The retro agent answers questions and revises the findings.
            </span>
          </div>
        </>
      )}
    </Surface>
  );
}

/** Rollback control for a finished feature: reverts its landed merge on
 * main. Rendered only for done tasks; a rolled-back task shows a badge
 * instead. Board rows show the same badge, never the button. */
function RollbackButton({ t, refresh }: { t: Task; refresh: () => void }) {
  const [elig, setElig] = useState<{
    eligible: boolean;
    reason: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (t.state !== "done" || t.rolledBackAt) return;
    let live = true;
    api(`/api/tasks/${encodeURIComponent(t.id)}/rollback`)
      .then(({ d }) => {
        if (live)
          setElig({
            eligible: d.eligible === true,
            reason: String(d.reason ?? ""),
          });
      })
      .catch(() => {
        if (live) setElig(null);
      });
    return () => {
      live = false;
    };
  }, [
    t.id,
    t.state,
    t.rolledBackAt,
  ]);
  if (t.state !== "done") return null;
  if (t.rolledBackAt)
    return <span className="text-success font-bold">Rolled back {agoText(t.rolledBackAt)}</span>;
  const run = async () => {
    if (
      !window.confirm(
        `Roll back "${t.title}" (${t.id})? This reverts its landed merge on main with a new revert commit (history is never rewritten) and pushes when an origin exists. The task stays done, marked rolled back.`,
      )
    )
      return;
    setBusy(true);
    const { r, d } = await api(`/api/tasks/${encodeURIComponent(t.id)}/rollback`, {
      method: "POST",
    });
    setBusy(false);
    if (!r.ok) window.alert(String(d.error ?? "rollback failed"));
    refresh();
  };
  const disabled = busy || !elig || !elig.eligible;
  const title = busy
    ? "rolling back…"
    : !elig
      ? "checking…"
      : elig.reason || "revert the landed merge";
  return (
    <button className={btnDangerCls} disabled={disabled} title={title} onClick={() => void run()}>
      {busy ? "Rolling back…" : "Roll back"}
    </button>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
function TaskDetail({
  d,
  diff,
  refresh,
  onOpenTask,
  onDeleted,
}: {
  d: TaskDetailData;
  diff: string;
  refresh: () => void;
  onOpenTask: (id: string) => void;
  onDeleted: () => void;
}) {
  const t = d.task;
  const removeTask = async () => {
    if (await deleteTaskWithConfirm(t)) onDeleted();
    else refresh();
  };
  const [answer, setAnswer] = useState("");
  const [reply, setReply] = useState("");
  const [verify, setVerify] = useState(t.verifyCommand);
  const needsInput = t.state === "needs-input";
  // What the owner is actually being asked. An agent entry is a real
  // question; a merge/pickup pause is a decision; an interruption is not
  // a question at all — say so instead of quoting the system note as one.
  const waiting = (() => {
    const last = [
      ...d.prompts,
    ]
      .reverse()
      .find((p) => p.kind !== "user");
    if (!last)
      return {
        heading: "The agent is paused and needs your input to continue.",
        body: "",
      };
    if (last.kind === "agent")
      return {
        heading: "The agent asks:",
        body: last.text,
      };
    if (/^(merge paused|pickup paused)/.test(last.text))
      return {
        heading: "Decision needed:",
        body: last.text,
      };
    if (/^verification failed/.test(last.text))
      return {
        heading: "Verification itself is broken — it is not the worker's fault:",
        body: last.text,
      };
    if (/pipeline interrupted/.test(last.text))
      return {
        heading: "No open question — the worker was interrupted before it could ask anything.",
        body: `${last.text}\n\nReply "continue" (or add new instructions) and the worker resumes from where it stopped.`,
      };
    return {
      heading: "Latest note from the system:",
      body: last.text,
    };
  })();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (needsInput && !d.planning) {
      replyRef.current?.focus();
      replyRef.current?.scrollIntoView({
        block: "center",
      });
    }
  }, [
    needsInput,
    d.planning,
    t.id,
  ]);
  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    await api(
      `/api/tasks/${encodeURIComponent(t.id)}/prompts`,
      post({
        text: reply,
      }),
    );
    setReply("");
    refresh();
  };
  const [comments, setComments] = useState<Record<string, string>>({});
  const [openLines, setOpenLines] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [submittedFrozen, setSubmittedFrozen] = useState(false);
  const wasPlanning = useRef(false);
  useEffect(() => {
    if (wasPlanning.current && !d.planning && submittedFrozen) {
      setSubmittedFrozen(false);
      setAnswer("");
      setComments({});
    }
    wasPlanning.current = d.planning;
  }, [
    d.planning,
    submittedFrozen,
  ]);
  // A failure counts as "last attempt" only until a newer attempt makes
  // progress past it (agent output or a planning-stage note).
  const failIdx =
    d.prompts
      .map((p, i) => ({
        p,
        i,
      }))
      .reverse()
      .find(({ p }) => p.kind === "system" && /failed/i.test(p.text))?.i ?? -1;
  const lastFailure =
    failIdx >= 0 &&
    !d.prompts
      .slice(failIdx + 1)
      .some((p) => p.kind === "agent" || (p.kind === "system" && p.text.startsWith("planning:")))
      ? d.prompts[failIdx]
      : undefined;
  // Unsent input is stored server-side (SQLite) as typed and restored
  // on open, so a crash never loses an answer, reply or comment.
  const draftsLoaded = useRef(false);
  const saveDraft = useCallback(
    (field: string, text: string) => {
      if (!draftsLoaded.current) return;
      void api(
        `/api/tasks/${encodeURIComponent(t.id)}/drafts`,
        post({
          field,
          text,
        }),
      ).catch(() => {});
    },
    [
      t.id,
    ],
  );
  useEffect(() => {
    draftsLoaded.current = false;
    api(`/api/tasks/${encodeURIComponent(t.id)}/drafts`)
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
      .then(({ d }) => {
        const drafts = (d.drafts ?? {}) as Record<string, string>;
        if (drafts.answer) setAnswer(drafts.answer);
        if (drafts.reply) setReply(drafts.reply);
        const restored: Record<string, string> = {};
        for (const [k, v] of Object.entries(drafts))
          if (k.startsWith("comment:")) restored[k.slice("comment:".length)] = v;
        if (Object.keys(restored).length)
          setComments((c) => ({
            ...restored,
            ...c,
          }));
        draftsLoaded.current = true;
      })
      .catch(() => {
        draftsLoaded.current = true;
      });
  }, [
    t.id,
  ]);
  useEffect(() => {
    const h = setTimeout(() => saveDraft("answer", answer), 400);
    return () => clearTimeout(h);
  }, [
    answer,
    saveDraft,
  ]);
  useEffect(() => {
    const h = setTimeout(() => saveDraft("reply", reply), 400);
    return () => clearTimeout(h);
  }, [
    reply,
    saveDraft,
  ]);
  useEffect(() => {
    const h = setTimeout(() => {
      for (const [k, v] of Object.entries(comments)) saveDraft(`comment:${k}`, v);
    }, 400);
    return () => clearTimeout(h);
  }, [
    comments,
    saveDraft,
  ]);
  const planLines = String(t.plan || "").split("\n");
  const promptLines = String(t.prompt || "").split("\n");
  const hasPlan = !!(t.plan && t.plan.trim());
  const isRunning = t.state === "running" || t.state === "in-review";
  // A worker waiting for input keeps its worker view: the question came
  // from the work, not the plan, so its feed and files are the context.
  const showWorker = isRunning || needsInput;
  const activity = d.activity ?? [];
  const feed = d.prompts.slice(-12);
  const toggle = (key: string) =>
    setOpenLines((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const stateCls =
    t.state === "done"
      ? "bg-success text-on-success"
      : t.state === "failed" || t.state === "blocked"
        ? "bg-danger text-on-danger"
        : t.state === "needs-input"
          ? "bg-warning text-on-warning"
          : t.state === "running" || t.state === "in-review"
            ? "bg-accent text-on-accent"
            : "bg-special text-on-special";
  const inputsLocked = d.planning || submittedFrozen;
  // Approving only exists in the plan stage: a drafted plan on a planned
  // task. On every other stage the button is meaningless, so it is hidden.
  const inPlanStage = t.state === "planned" && t.planState === "draft";
  const questionsOpen = (t.planQuestions?.length ?? 0) > 0;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  const sendComments = async () => {
    const collected: {
      line: number;
      text: string;
      comment: string;
    }[] = [];
    for (const [key, value] of Object.entries(comments)) {
      const v = value.trim();
      if (!v) continue;
      if (key === "whole:0") {
        collected.push({
          line: planLines.length,
          text: "[whole plan]",
          comment: v,
        });
        continue;
      }
      const [section, idxRaw] = key.split(":");
      const idx = Number(idxRaw);
      const src = section === "prompt" ? promptLines : planLines;
      collected.push({
        line: idx + 1,
        text: (section === "prompt" ? "[prompt] " : "") + (src[idx] ?? ""),
        comment: v,
      });
    }
    if (!collected.length) {
      setCommentError("Write a comment on at least one line first");
      return;
    }
    setSending(true);
    setCommentError("");
    const { r, d: res } = await api(
      `/api/tasks/${encodeURIComponent(t.id)}/plan-comments`,
      post({
        comments: collected,
      }),
    );
    setSending(false);
    if (!r.ok) setCommentError((res.error as string) || "sending comments failed");
    else {
      for (const k of Object.keys(comments)) saveDraft(`comment:${k}`, "");
      setSubmittedFrozen(true);
    }
    refresh();
  };
  return (
    <div className="flex gap-4 h-full items-stretch max-md:flex-col max-md:h-auto">
      <div
        id="task-active"
        className="flex-1 min-w-0 h-full overflow-hidden max-md:h-auto max-md:overflow-visible"
      >
        <Surface
          surface="elevated"
          className="border p-3 h-full flex flex-col overflow-y-auto max-md:overflow-visible"
        >
          <div className="flex gap-4 flex-wrap items-start justify-between">
            <h2>{t.title}</h2>
            <div className="flex gap-2 flex-wrap items-center">
              <RollbackButton t={t} refresh={refresh} />
            </div>
          </div>
          <p className="text-muted">
            {t.projectId} · <span className={`px-2 py-0.5 ${stateCls}`}>{t.state}</span> · Plan:{" "}
            {d.planning && !hasPlan ? "drafting…" : t.planState}
            {d.planning ? " · planning…" : ""}
          </p>
          {(() => {
            const stage = lifecycleStage({
              ...t,
              planning: d.planning,
            });
            return (
              <div
                className="flex items-center gap-1 my-2 flex-wrap"
                aria-label={`Stage ${stage.index} of 5: ${stage.label}`}
              >
                {LIFECYCLE.map((label, i) => {
                  const n = i + 1;
                  const doneStage = n < stage.index;
                  const current = n === stage.index;
                  return (
                    <span key={label} className="flex items-center gap-1">
                      {i > 0 && <span className="text-muted">→</span>}
                      <span
                        className={
                          current
                            ? "text-primary font-bold"
                            : doneStage
                              ? "text-success"
                              : "text-muted"
                        }
                      >
                        {doneStage ? "●" : current ? "◉" : "○"} {label}
                      </span>
                    </span>
                  );
                })}
                <span className="text-muted text-sm ml-2">
                  {stage.index > 5 ? "Closed" : `Stage ${stage.index} of 5`}
                </span>
              </div>
            );
          })()}
          {questionsOpen ? (
            <p className="border-2 border-warning p-2 font-bold">
              Needs you: the planner has question(s) below — answer them to settle the plan.
            </p>
          ) : needsInput ? (
            <p className="border-2 border-warning p-2 font-bold">
              Needs you: the worker is waiting for your answer below.
            </p>
          ) : inPlanStage ? (
            <p className="border-2 border-success p-2 font-bold">
              Needs you: the plan is ready — Approve plan &amp; queue below starts implementation.
            </p>
          ) : t.state === "blocked" || t.state === "failed" ? (
            <p className="border-2 border-danger p-2 font-bold">
              Needs you: this feature is {t.state} — send it back to Planned below, or remove it
              from the Inbox.
            </p>
          ) : t.state === "done" ? (
            <p className="text-muted my-2">
              Finished — review the retro below; nothing else is needed from you.
            </p>
          ) : (
            <p className="text-muted my-2">Nothing needed from you — agents are working.</p>
          )}
          <NowBar d={d} refresh={refresh} />
          <Accordion title="Task details">
            <p>
              Type: {t.taskType} · Tags: {t.tags.join(", ") || "—"} · Attempts: {t.attempts}
              <br />
              Worktree: {t.worktree || "—"} · Base commit: {short(t.baseCommit)}
            </p>
            <p>
              Lane: <b>{t.lane ? `${t.lane} lane` : "not triaged yet"}</b>
              {t.triage ? <span className="text-muted"> — {t.triage}</span> : null}
              <br />
              <span className="flex gap-4 flex-wrap mt-1">
                {(
                  [
                    "fast",
                    "standard",
                    "careful",
                  ] as const
                )
                  .filter((l) => l !== t.lane)
                  .map((l) => (
                    <button
                      key={l}
                      className={btnGhostCls}
                      onClick={async () => {
                        await api(
                          `/api/tasks/${encodeURIComponent(t.id)}/lane`,
                          post({
                            lane: l,
                          }),
                        );
                        refresh();
                      }}
                    >
                      Set {l} lane
                    </button>
                  ))}
              </span>
              <span className="text-muted text-sm">
                Fast skips red-teams and auto-approves the plan; gates always apply, and a diff that
                outgrows the estimate escalates back to standard.
              </span>
            </p>
            {/** biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md) */}
            {(() => {
              const bySession = new Map<
                string,
                {
                  model: string;
                  input: number;
                  output: number;
                }
              >();
              for (const s of d.stations) {
                const del = s.delivery;
                if (!del) continue;
                const key = del.sessionId ?? s.card.id;
                const prev = bySession.get(key);
                const input = del.inputTokens ?? 0;
                const output = del.outputTokens ?? 0;
                if (!prev || input + output > prev.input + prev.output)
                  bySession.set(key, {
                    model: del.model ?? "",
                    input,
                    output,
                  });
              }
              const rows = [
                ...bySession.values(),
              ];
              if (!rows.length) return null;
              const models =
                [
                  ...new Set(rows.map((x) => x.model).filter(Boolean)),
                ].join(", ") || "—";
              const input = rows.reduce((a, x) => a + x.input, 0);
              const output = rows.reduce((a, x) => a + x.output, 0);
              return (
                <p>
                  Consumption: models {models} ·{" "}
                  {input + output === 0
                    ? "tokens not counted yet — counts land when a station finishes"
                    : `tokens ${input.toLocaleString()} in / ${output.toLocaleString()} out`}
                </p>
              );
            })()}
            {!d.planning && (
              <p>
                Verify command:{" "}
                <input
                  className={`${inputCls} w-[50%]`}
                  value={verify}
                  onChange={(e) => setVerify(e.target.value)}
                  placeholder="e.g. bun test (empty = no verification)"
                />{" "}
                <button
                  className={btnGhostCls}
                  onClick={async () => {
                    await api(
                      `/api/tasks/${encodeURIComponent(t.id)}/verify-command`,
                      post({
                        verifyCommand: verify,
                      }),
                    );
                    refresh();
                  }}
                >
                  Save
                </button>
              </p>
            )}
          </Accordion>
          {d.planning ? (
            <PlanProgress d={d} />
          ) : (
            !hasPlan &&
            !d.planArtifact &&
            ((t.tags ?? []).includes("retro-point") ? (
              <p className="text-muted">
                This is a retro point filed as its own candidate task. Accept or remove it in the
                Inbox — planning starts on accept, with no other click.
              </p>
            ) : d.prompts.some((p) => p.text.startsWith("planning failed:")) ? (
              <p className="text-muted">
                The last planning attempt failed — this task automatically re-enters the planning
                queue (with a short backoff, so a broken planner cannot hot-loop). No click needed.
              </p>
            ) : (
              <p className="text-muted">
                In queue to start planning whenever a slot frees — triage, the planner and however
                many red-teams triage decides on start automatically. No click needed.
              </p>
            ))
          )}
          {showWorker ? (
            <>
              <h3>Worker output{needsInput ? " — paused, waiting for you" : ""}</h3>
              <p>
                {activity[0] ? (
                  <>
                    Most recently edited:{" "}
                    <code className="bg-surface-sink px-1">{activity[0].file}</code>
                    {activity[0].modifiedAt
                      ? ` at ${new Date(activity[0].modifiedAt).toLocaleTimeString()}`
                      : ""}{" "}
                    · {activity.length} file(s) changed so far
                  </>
                ) : (
                  "No files edited yet — the worker is still reading and thinking."
                )}
              </p>
              <div className="flex-1 min-h-0 overflow-y-auto border border-surface-elevated-border p-2 max-md:max-h-[60vh]">
                <h4>Edited files</h4>
                {activity.length ? (
                  <ul>
                    {activity.map((a) => (
                      <li key={a.file}>
                        <code className="bg-surface-sink px-1">{a.status}</code> {a.file}
                        {a.modifiedAt ? (
                          <span className="text-muted">
                            {" "}
                            · {new Date(a.modifiedAt).toLocaleTimeString()}
                          </span>
                        ) : (
                          ""
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>none yet</p>
                )}
                <h4>Agent feed — prompts, responses, station notes</h4>
                {feed.length ? (
                  feed.map((p, i) => (
                    <p key={i}>
                      <i>{p.kind}</i>{" "}
                      <span className="text-muted">{new Date(p.at).toLocaleTimeString()}</span>
                      <br />
                      {p.text}
                    </p>
                  ))
                ) : (
                  <p>none yet</p>
                )}
              </div>
              {hasPlan && (
                <Accordion title="Plan (read-only while the worker has the task)">
                  <LineRows
                    lines={planLines}
                    section="plan"
                    comments={{}}
                    openLines={new Set()}
                    onToggle={() => {}}
                    onComment={() => {}}
                    readOnly
                  />
                </Accordion>
              )}
            </>
          ) : (
            <>
              <h3>Prompt — comment on any line</h3>
              <LineRows
                lines={promptLines}
                section="prompt"
                comments={comments}
                openLines={openLines}
                onToggle={toggle}
                onComment={(k, v) =>
                  setComments((c) => ({
                    ...c,
                    [k]: v,
                  }))
                }
                readOnly={inputsLocked}
              />
              {hasPlan ? (
                <>
                  <h3>Plan — comment on any line</h3>
                  {d.planning && (
                    <p className="text-warning font-bold">
                      Planner is reviewing the full plan with both red-teams — this page updates
                      automatically when the revised plan lands.
                    </p>
                  )}
                  {lastFailure && !d.planning && (
                    <p className="text-danger font-bold">Last review failed: {lastFailure.text}</p>
                  )}
                  <div className="flex-1 min-h-0 overflow-y-auto border border-surface-elevated-border p-2 max-md:max-h-[60vh]">
                    <LineRows
                      lines={planLines}
                      section="plan"
                      comments={comments}
                      openLines={openLines}
                      onToggle={toggle}
                      onComment={(k, v) =>
                        setComments((c) => ({
                          ...c,
                          [k]: v,
                        }))
                      }
                      readOnly={inputsLocked}
                    />
                    <div
                      className={`border-t-2 border-surface-elevated-border py-2 ${inputsLocked ? "" : "cursor-pointer hover:bg-surface-sink"}`}
                      title={inputsLocked ? undefined : "Click to comment on the whole plan"}
                      onClick={inputsLocked ? undefined : () => toggle("whole:0")}
                    >
                      <span className="text-muted text-xs">✎</span>{" "}
                      <span className="font-bold">Comment on the whole plan</span>
                      {(openLines.has("whole:0") || !!comments["whole:0"]?.trim()) && (
                        <input
                          className="block w-[95%] mt-1 p-1 bg-surface-elevated text-on-surface-elevated border border-surface-elevated-border disabled:bg-surface-sink disabled:text-muted"
                          placeholder="comment on the whole plan"
                          value={comments["whole:0"] ?? ""}
                          disabled={inputsLocked}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setComments((c) => ({
                              ...c,
                              "whole:0": e.target.value,
                            }))
                          }
                        />
                      )}
                    </div>
                  </div>
                  {commentError && <p className="text-danger font-bold">{commentError}</p>}
                </>
              ) : (
                <>
                  <h3>Plan</h3>
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {d.planning ? (
                      <p>
                        Draft plan is written — both red-teams are reviewing it. The settled plan
                        appears here when the revision lands; this page updates automatically.
                      </p>
                    ) : (
                      <p>No plan yet.</p>
                    )}
                    {d.planArtifact && (
                      <Accordion title="Plan draft & red-team artifact (so far)">
                        <pre id="tour-plan" className="bg-surface-sink p-2 whitespace-pre-wrap">
                          {d.planArtifact}
                        </pre>
                      </Accordion>
                    )}
                  </div>
                </>
              )}
              {(t.planQuestions?.length ?? 0) > 0 && (
                <Surface surface="sink" className="border-2 border-warning p-3 my-2">
                  <b>The planner needs your decision before this plan can be approved</b>
                  {d.planning && (
                    <p className="text-warning font-bold">
                      Review in progress — the updated plan is being red-teamed. You can answer as
                      soon as it lands.
                    </p>
                  )}
                  {t.planQuestions.map((q, i) => (
                    <p key={i}>
                      {i + 1}. {q}
                    </p>
                  ))}
                  {lastFailure && (
                    <p className="text-danger font-bold">Last attempt failed: {lastFailure.text}</p>
                  )}
                  <form
                    className="flex flex-col gap-2 items-start"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!answer.trim() || answering) return;
                      setAnswering(true);
                      setAnswerError("");
                      const { r, d: res } = await api(
                        `/api/tasks/${encodeURIComponent(t.id)}/answer`,
                        post({
                          text: answer,
                        }),
                      );
                      setAnswering(false);
                      if (!r.ok) {
                        setAnswerError((res.error as string) || "sending answers failed");
                        return;
                      }
                      saveDraft("answer", "");
                      setSubmittedFrozen(true);
                      refresh();
                    }}
                  >
                    <textarea
                      className={`${inputCls} w-full`}
                      rows={3}
                      placeholder="Answer each point (1., 2., …)"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      disabled={inputsLocked}
                    />
                    {answerError && <p className="text-danger font-bold">{answerError}</p>}
                    <button className={btnCls} disabled={answering || inputsLocked}>
                      <Send size={14} />{" "}
                      {submittedFrozen
                        ? "Sent — review in progress…"
                        : d.planning
                          ? "Review in progress…"
                          : answering
                            ? "Sending… planner is updating the plan"
                            : "Send answers & update plan"}
                    </button>
                    <span className="text-muted text-sm">
                      Sending re-runs the full review: planner applies your answers, both red-teams
                      re-check the plan, planner decides again.
                    </span>
                  </form>
                </Surface>
              )}
              {(inPlanStage ||
                t.state === "planned" ||
                t.state === "blocked" ||
                t.state === "failed") && (
                <div className="flex gap-4 flex-wrap items-center mt-2">
                  {inPlanStage && (
                    <button
                      className={btnCls}
                      disabled={sending || inputsLocked}
                      onClick={sendComments}
                    >
                      <Send size={14} />{" "}
                      {submittedFrozen
                        ? "Sent — review in progress…"
                        : d.planning
                          ? "Planner is reviewing…"
                          : sending
                            ? "Sending…"
                            : "Send comments to agent"}
                    </button>
                  )}
                  {inPlanStage && (
                    <button
                      className={btnCls}
                      disabled={inputsLocked || questionsOpen}
                      title={
                        inputsLocked
                          ? "Wait for the review to finish"
                          : questionsOpen
                            ? "Answer the planner's questions first"
                            : undefined
                      }
                      onClick={async () => {
                        const { r, d: res } = await api(
                          `/api/tasks/${encodeURIComponent(t.id)}/approve`,
                          {
                            method: "POST",
                          },
                        );
                        if (!r.ok) alert((res.error as string) || "approve failed");
                        refresh();
                      }}
                    >
                      Approve plan &amp; queue
                    </button>
                  )}
                  {(t.state === "blocked" || t.state === "failed") && (
                    <button
                      className={btnCls}
                      disabled={inputsLocked}
                      onClick={async () => {
                        await api(
                          `/api/tasks/${encodeURIComponent(t.id)}/transition`,
                          post({
                            to: "planned",
                          }),
                        );
                        refresh();
                      }}
                    >
                      Send back to Planned
                    </button>
                  )}
                  {t.state === "planned" && !d.planning && (
                    <button
                      className={btnDangerCls}
                      disabled={inputsLocked}
                      onClick={async () => {
                        await api(
                          `/api/tasks/${encodeURIComponent(t.id)}/transition`,
                          post({
                            to: "blocked",
                          }),
                        );
                        refresh();
                      }}
                    >
                      Block
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {needsInput && (
            <Surface surface="sink" className="border-2 border-warning p-3 my-2">
              <b>Input needed — the agent is waiting for your answer</b>
              <p className="font-bold mt-2">{waiting.heading}</p>
              {waiting.body && <p className="whitespace-pre-wrap">{waiting.body}</p>}
              <form className="flex flex-col gap-2 items-start" onSubmit={sendReply}>
                <textarea
                  ref={replyRef}
                  className={`${inputCls} w-full`}
                  rows={3}
                  placeholder="Answer the agent — sending resumes its work"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  disabled={d.planning}
                />
                <button className={btnCls} disabled={d.planning}>
                  <Send size={14} /> Send reply &amp; resume
                </button>
              </form>
            </Surface>
          )}
          <VisualReviewPanel d={d} refresh={refresh} />
          <RetroPanel d={d} refresh={refresh} onOpenTask={onOpenTask} />
          <div className="border-t border-surface-elevated-border mt-4 pt-3 flex items-center gap-3 flex-wrap">
            <span className="text-muted text-sm">Danger zone — this cannot be undone:</span>
            <button
              className={btnDangerCls}
              data-testid="delete-task"
              onClick={() => void removeTask()}
            >
              Delete task permanently
            </button>
          </div>
        </Surface>
      </div>
      <div
        id="task-history"
        className="flex-1 min-w-0 h-full overflow-y-auto max-md:h-auto max-md:overflow-visible"
      >
        <Surface surface="elevated" className="border p-3">
          <h3>History &amp; state</h3>
          <Accordion title="History" defaultOpen>
            {d.prompts.length ? (
              d.prompts.map((p, i) => (
                <p key={i}>
                  <i>{p.kind}</i> <span className="text-muted">{agoText(p.at)}</span>
                  <br />
                  {p.text}
                </p>
              ))
            ) : (
              <p>none yet</p>
            )}
          </Accordion>
          {d.similar?.length > 0 && (
            <Accordion title="Similar finished work">
              {d.similar.map((s, i) => (
                <p key={i}>
                  {s.title} [{s.tags.join(", ")}] — {s.outcome}
                </p>
              ))}
            </Accordion>
          )}
          <Accordion title="Stations">
            {d.stations.length ? (
              d.stations.map((s) => (
                <Accordion
                  key={s.card.id}
                  title={`${s.card.id} (${s.card.role}): ${s.delivery ? `${s.delivery.status} — ${verdictText(s.delivery.summary).slice(0, 120)}` : "pending"}`}
                >
                  {s.delivery?.detail ? (
                    <pre className="bg-surface-sink p-2 whitespace-pre-wrap">
                      {verdictText(s.delivery.detail)}
                    </pre>
                  ) : (
                    <p>no delivery yet</p>
                  )}
                </Accordion>
              ))
            ) : (
              <p>none yet</p>
            )}
          </Accordion>
          {d.artifacts?.length > 0 && (
            <Accordion title="Verification artifacts">
              {d.artifacts.map((a) =>
                a.endsWith(".webm") || a.endsWith(".mp4") ? (
                  <div key={a}>
                    <video
                      controls
                      width={480}
                      src={`/api/tasks/${encodeURIComponent(t.id)}/artifacts/${encodeURIComponent(a)}`}
                    />
                    <p>{a}</p>
                  </div>
                ) : (
                  <p key={a}>{a}</p>
                ),
              )}
            </Accordion>
          )}
          <Accordion title="Latest diff">
            <pre id="tour-diff" className="bg-surface-sink p-2 whitespace-pre-wrap">
              {diff || "(no worktree yet, or no changes)"}
            </pre>
          </Accordion>
        </Surface>
      </div>
    </div>
  );
}

// Register flow: minimal intake (id, folder, name, test mode), then a
// scout agent inspects the codebase and proposes description, rules,
// SME soul and developer soul — accepted field by field, never applied
// automatically.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
function RegisterView({
  projects,
  refresh,
  onDone,
}: {
  projects: Project[];
  refresh: () => void;
  onDone: (id: string) => void;
}) {
  const [form, setForm] = useState({
    id: "",
    folderPath: "",
    name: "",
    testMode: "checks",
  });
  const [registeredId, setRegisteredId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [fields, setFields] = useState({
    description: "",
    rules: "",
    smeSoul: "",
    coderSoul: "",
  });
  const initFor = useRef<string>("");
  const project = projects.find((p) => p.id === registeredId);
  const suggestions = project?.scoutSuggestions ?? null;

  useEffect(() => {
    if (project && initFor.current !== project.id) {
      initFor.current = project.id;
      setFields({
        description: project.description,
        rules: project.rules,
        smeSoul: project.smeSoul,
        coderSoul: project.coderSoul,
      });
    }
  }, [
    project,
  ]);

  const suggestionRow = (label: string, key: keyof typeof fields) => {
    const text = suggestions?.[key];
    if (!text) return null;
    return (
      <Surface surface="sink" className="border p-2 my-1">
        <b>Scout suggestion — {label}:</b>
        <p className="whitespace-pre-wrap">{text}</p>
        <button
          type="button"
          className={btnCls}
          onClick={() =>
            setFields((f) => ({
              ...f,
              [key]: text,
            }))
          }
        >
          Use suggestion
        </button>
      </Surface>
    );
  };

  return (
    <div>
      <h2>Register project folder</h2>
      <p className="text-muted">
        Adopt a folder on this machine as a project. The factory links to it, keeps its history in{" "}
        <code>&lt;project&gt;/data/</code>, and never copies it. After registering, a scout agent
        inspects the codebase and suggests a description, general rules, an SME soul and a developer
        soul for you to accept.
      </p>
      {!registeredId ? (
        <Surface surface="elevated" className="border p-6">
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const { r, d } = await api("/api/projects", post(form));
              if (!r.ok) {
                setMsg(`Register failed: ${(d.error as string) || r.status}`);
                return;
              }
              const id = (d.project as Project).id;
              setRegisteredId(id);
              setMsg(`Registered ${id} — scout is gathering info about the codebase…`);
              await api(`/api/projects/${encodeURIComponent(id)}/scout`, {
                method: "POST",
              });
              refresh();
            }}
          >
            <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
              <div>
                <label className={labelCls}>Project id</label>
                <input
                  className={`${inputCls} w-full`}
                  placeholder="project-id"
                  required
                  value={form.id}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      id: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className={labelCls}>Folder on this machine</label>
                <input
                  className={`${inputCls} w-full`}
                  placeholder="/home/you/code/my-app"
                  required
                  value={form.folderPath}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      folderPath: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className={labelCls}>Display name (optional)</label>
                <input
                  className={`${inputCls} w-full`}
                  placeholder="Display name (optional)"
                  value={form.name}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      name: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>How do you test it?</label>
              <select
                className={`${inputCls} w-full`}
                value={form.testMode}
                onChange={(e) =>
                  setForm({
                    ...form,
                    testMode: e.target.value,
                  })
                }
              >
                <option value="dev">Run it — interactive dev mode</option>
                <option value="checks">Automated checks only (tests/build)</option>
                <option value="push-only">
                  No way to run it — just make changes, I test &amp; push
                </option>
              </select>
            </div>
            <div>
              <button className={btnCls}>Register project folder</button>
            </div>
          </form>
        </Surface>
      ) : (
        <div>
          <p>
            {project?.scouting
              ? "Scout is gathering info about this codebase… (this view updates automatically)"
              : suggestions
                ? "Scout finished — review its suggestions, edit anything, then save."
                : "Scout is starting…"}
          </p>
          {suggestions?.error && (
            <p className="text-danger font-bold">Scout failed: {suggestions.error}</p>
          )}
          {!project?.scouting && (
            <div className="my-3">
              <button
                className={btnCls}
                onClick={async () => {
                  await api(`/api/projects/${encodeURIComponent(registeredId)}/scout`, {
                    method: "POST",
                  });
                  refresh();
                }}
              >
                Run scout again
              </button>
            </div>
          )}
          <Surface surface="elevated" className="border p-6">
            <form
              className="flex flex-col gap-4"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!project) return;
                await api(
                  `/api/projects/${encodeURIComponent(project.id)}/context`,
                  post({
                    description: fields.description,
                    businessPlan: project.businessPlan,
                    goals: project.goals.join("\n"),
                    moat: project.moat,
                    rules: fields.rules,
                    smeSoul: fields.smeSoul,
                    coderSoul: fields.coderSoul,
                  }),
                );
                refresh();
                onDone(project.id);
              }}
            >
              <div>
                {suggestionRow("Description", "description")}
                <label className={labelCls}>Description</label>
                <textarea
                  className={`${inputCls} w-full`}
                  rows={3}
                  placeholder="Description: what is this, who is it for, where is it going?"
                  value={fields.description}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      description: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                {suggestionRow("General rules", "rules")}
                <label className={labelCls}>General rules</label>
                <textarea
                  className={`${inputCls} w-full`}
                  rows={3}
                  placeholder="General rules agents must respect"
                  value={fields.rules}
                  onChange={(e) =>
                    setFields({
                      ...fields,
                      rules: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
                <div>
                  {suggestionRow("SME soul", "smeSoul")}
                  <label className={labelCls}>SME soul</label>
                  <textarea
                    className={`${inputCls} w-full`}
                    rows={4}
                    placeholder="SME soul: who should the subject-matter expert be?"
                    value={fields.smeSoul}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        smeSoul: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  {suggestionRow("Developer soul", "coderSoul")}
                  <label className={labelCls}>Developer soul</label>
                  <textarea
                    className={`${inputCls} w-full`}
                    rows={4}
                    placeholder="Developer soul: who should implement and code-review here?"
                    value={fields.coderSoul}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        coderSoul: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div>
                <button className={btnCls}>Save project info</button>
              </div>
            </form>
          </Surface>
        </div>
      )}
      <p>{msg}</p>
    </div>
  );
}

// State-a-task flow: its own view, like Register. Submitting creates the
// task and opens it.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
function NewTaskView({
  projects,
  refresh,
  onDone,
}: {
  projects: Project[];
  refresh: () => void;
  onDone: (id: string) => void;
}) {
  // One required field. Everything else is either inferred (type, tags),
  // dangerous to guess (verify command), or an explicit choice (lane).
  const [form, setForm] = useState({
    projectId: "",
    prompt: "",
    taskType: "auto",
    tags: "",
    verifyCommand: "",
  });
  const [lane, setLane] = useState("");
  const [msg, setMsg] = useState("");
  const [duplicateOf, setDuplicateOf] = useState("");
  useEffect(() => {
    if (!form.projectId && projects[0]) {
      let wanted = "";
      try {
        wanted = localStorage.getItem("af-newtask-project") ?? "";
        localStorage.removeItem("af-newtask-project");
      } catch {
        /* ignore */
      }
      const pick = projects.some((p) => p.id === wanted) ? wanted : (projects[0]?.id ?? "");
      setForm((f) => ({
        ...f,
        projectId: pick,
      }));
    }
  }, [
    projects,
    form.projectId,
  ]);
  // A half-written statement survives a crash or an accidental navigation.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("af-newtask-draft");
      if (saved)
        setForm((f) =>
          f.prompt
            ? f
            : {
                ...f,
                prompt: saved,
              },
        );
    } catch {
      /* private mode */
    }
  }, []);
  useEffect(() => {
    try {
      if (form.prompt) localStorage.setItem("af-newtask-draft", form.prompt);
    } catch {
      /* ignore */
    }
  }, [
    form.prompt,
  ]);
  const selected = projects.find((p) => p.id === form.projectId);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  const submitTask = async (allowDuplicate: boolean) => {
    const body = {
      projectId: form.projectId,
      prompt: form.prompt,
      tags: form.tags,
      verifyCommand: form.verifyCommand,
      allowDuplicate,
      ...(form.taskType === "auto"
        ? {}
        : {
            taskType: form.taskType,
          }),
    };
    const { r, d } = await api("/api/tasks", post(body));
    if (r.ok) {
      const id = (d.task as Task).id;
      if (lane)
        await api(
          `/api/tasks/${encodeURIComponent(id)}/lane`,
          post({
            lane,
          }),
        ).catch(() => {});
      try {
        localStorage.removeItem("af-newtask-draft");
      } catch {
        /* ignore */
      }
      refresh();
      onDone(id);
    } else if (r.status === 409 && d.duplicateOf) {
      setDuplicateOf(String(d.duplicateOf));
      setMsg(
        `Already active: ${String(d.error ?? "duplicate task")}. Open the existing task, or state it anyway if it really is separate work.`,
      );
    } else
      setMsg(
        `Not stated: ${((d.reasons as string[]) ?? []).join("; ") || (d.error as string) || r.status}`,
      );
  };
  const laneBtn = (value: string, label: string) => (
    <button
      type="button"
      className={lane === value ? btnCls : btnGhostCls}
      onClick={() => setLane(value)}
    >
      {label}
    </button>
  );
  return (
    <div>
      <h2>State a task</h2>
      <p className="text-muted">
        Describe what to build or change. Triage estimates the effort and picks the process lane;
        planning starts on its own, and you are only asked questions that matter.
      </p>
      <Surface surface="elevated" className="border p-6">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await submitTask(false);
          }}
        >
          {projects.length > 1 ? (
            <div>
              <label className="block font-bold mb-1" htmlFor="nt-project">
                Project
              </label>
              <select
                id="nt-project"
                className={`${inputCls} w-full`}
                required
                value={form.projectId}
                onChange={(e) =>
                  setForm({
                    ...form,
                    projectId: e.target.value,
                  })
                }
              >
                <option value="" disabled>
                  select project
                </option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ) : selected ? (
            <p className="text-muted m-0">
              Project: <b className="text-on-surface-elevated">{selected.name}</b> ·{" "}
              {selected.repoPath}
            </p>
          ) : null}
          {selected && (
            <p className="text-muted text-sm mt-1">
              {selected.online ? "online" : "offline"}
              {selected.stale && (
                <>
                  {" "}
                  · <span className="text-danger font-bold">STALE</span>{" "}
                  <button
                    type="button"
                    className={btnGhostCls}
                    onClick={async () => {
                      await api(`/api/projects/${encodeURIComponent(selected.id)}/sync`, {
                        method: "POST",
                      });
                      refresh();
                    }}
                  >
                    Sync to current commit
                  </button>
                </>
              )}
            </p>
          )}
          <div>
            <label className="block font-bold mb-1" htmlFor="nt-prompt">
              What should be done?
            </label>
            <textarea
              autoFocus
              id="nt-prompt"
              data-testid="nt-prompt"
              className={`${inputCls} w-full`}
              rows={6}
              placeholder="add hello service and expose it at /hello"
              required
              value={form.prompt}
              onChange={(e) =>
                setForm({
                  ...form,
                  prompt: e.target.value,
                })
              }
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                  e.currentTarget.form?.requestSubmit();
              }}
            />
            <p className="text-muted text-sm mt-1">
              Name the deliverable concretely — a service, route, page, file or behavior. Vague
              orders come back as questions. Cmd/Ctrl+Enter states the task.
            </p>
          </div>
          <div>
            <span className="block font-bold mb-1">Process lane</span>
            <div className="flex gap-4 flex-wrap">
              {laneBtn("", "Auto — triage decides")}
              {laneBtn("fast", "Fast")}
              {laneBtn("standard", "Standard")}
              {laneBtn("careful", "Careful")}
            </div>
            <p className="text-muted text-sm mt-1">
              {lane === "fast"
                ? "Small and safe: no red-teams, plan auto-approves, single review. Gates still apply."
                : lane === "standard"
                  ? "Full process: plan, both red-teams, dual review."
                  : lane === "careful"
                    ? "Full process plus extra scrutiny on expensive paths and decisions."
                    : "One cheap triage station estimates size and risk, then picks the lane. You can change it later in Task details."}
            </p>
          </div>
          <Accordion title="Advanced — type, tags, verify command (all optional)">
            <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
              <div>
                <label className="block font-bold mb-1" htmlFor="nt-type">
                  Type
                </label>
                <select
                  id="nt-type"
                  className={`${inputCls} w-full`}
                  value={form.taskType}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      taskType: e.target.value,
                    })
                  }
                >
                  <option value="auto">Auto — infer from the statement</option>
                  {[
                    "general",
                    "security",
                    "ui",
                    "css",
                    "backend",
                    "docs",
                  ].map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-bold mb-1" htmlFor="nt-tags">
                  Tags
                </label>
                <input
                  id="nt-tags"
                  className={`${inputCls} w-full`}
                  placeholder="inferred when empty"
                  value={form.tags}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      tags: e.target.value,
                    })
                  }
                />
              </div>
              <div>
                <label className="block font-bold mb-1" htmlFor="nt-verify">
                  Verify command
                </label>
                <input
                  id="nt-verify"
                  className={`${inputCls} w-full`}
                  placeholder="leave empty — factory works it out"
                  value={form.verifyCommand}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      verifyCommand: e.target.value,
                    })
                  }
                />
              </div>
            </div>
            <p className="text-muted text-sm mt-2">
              Leave the verify command empty unless you know the exact command: a guessed sentence
              here causes failed verifications, and the builder can name the project's real check
              when asked.
            </p>
          </Accordion>
          {msg && <p className="text-danger font-bold">{msg}</p>}
          {duplicateOf && (
            <div className="flex gap-4 flex-wrap">
              <button type="button" className={btnCls} onClick={() => onDone(duplicateOf)}>
                Open existing task
              </button>
              <button type="button" className={btnGhostCls} onClick={() => void submitTask(true)}>
                State anyway — it is separate work
              </button>
            </div>
          )}
          <div className="flex items-center gap-4">
            <button className={btnCls} data-testid="state-task-submit">
              State task
            </button>
            <span className="text-muted text-sm">
              Next: it lands in Created, triage and planning start automatically.
            </span>
          </div>
        </form>
      </Surface>
    </div>
  );
}

// The pipeline as actors, left to right: who holds the task at each point.
// A card's sequence across these actors is the task's story — the kanban
// columns alone hide which agent is actually working right now.
export const ACTORS = [
  {
    id: "owner",
    label: "Owner",
    hint: "waiting on you",
  },
  {
    id: "planner",
    label: "Planner",
    hint: "drafting the plan",
  },
  {
    id: "redteam",
    label: "Red-team SME",
    hint: "attacking the plan",
  },
  {
    id: "outsider",
    label: "Outsider",
    hint: "attacking the plan",
  },
  {
    id: "builder",
    label: "Builder",
    hint: "implementing",
  },
  {
    id: "fixer",
    label: "Fixer",
    hint: "resolving a conflict",
  },
  {
    id: "sme",
    label: "SME review",
    hint: "reviewing the work",
  },
  {
    id: "coder",
    label: "Coder review",
    hint: "reviewing the work",
  },
  {
    id: "retro",
    label: "Retro",
    hint: "reviewing the run",
  },
] as const;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function currentActor(t: Task): {
  id: string;
  label: string;
  busy: boolean;
} {
  if (t.state === "needs-input" || (t.planQuestions?.length ?? 0) > 0)
    return {
      id: "owner",
      label: "Owner",
      busy: false,
    };
  if (t.planning) {
    const live = (t.liveActor ?? "").toLowerCase();
    if (live.includes("outsider"))
      return {
        id: "outsider",
        label: "Outsider",
        busy: true,
      };
    if (live.includes("redteam") || live.includes("sme"))
      return {
        id: "redteam",
        label: "Red-team SME",
        busy: true,
      };
    return {
      id: "planner",
      label: "Planner",
      busy: true,
    };
  }
  if (t.state === "planned")
    return {
      id: t.planState === "draft" ? "owner" : "planner",
      label: t.planState === "draft" ? "Owner (approve)" : "Planner (queued)",
      busy: false,
    };
  if (t.state === "in-review") {
    const live = (t.liveActor ?? "").toLowerCase();
    if (live.includes("coder"))
      return {
        id: "coder",
        label: "Coder review",
        busy: true,
      };
    return {
      id: "sme",
      label: "SME review",
      busy: true,
    };
  }
  if (t.state === "running") {
    const live = (t.liveActor ?? "").toLowerCase();
    if (live.includes("fixer") || live.includes("rebase"))
      return {
        id: "fixer",
        label: "Fixer",
        busy: true,
      };
    if (live.includes("builder"))
      return {
        id: "builder",
        label: "Builder",
        busy: true,
      };
    if (live.includes("retro"))
      return {
        id: "retro",
        label: "Retro",
        busy: true,
      };
    return {
      id: "builder",
      label: "Builder",
      busy: false,
    };
  }
  if (t.state === "done")
    return {
      id: "retro",
      label: "Retro",
      busy: false,
    };
  // Blocked and failed are not agent states — both wait on the human to
  // decide (send back to Planned, fix the cause, or erase).
  if (t.state === "blocked" || t.state === "failed")
    return {
      id: "owner",
      label: t.state === "failed" ? "Owner (failed)" : "Owner (blocked)",
      busy: false,
    };
  return {
    id: "owner",
    label: "Owner",
    busy: false,
  };
}

export function ageText(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 90) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 90) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

// A feature's life, in order. Everything that is not one of these —
// blocked, failed, needs-input, a decision pause — is not a stage; it is
// a question waiting in the owner's inbox, interrupting the stage below.
export const LIFECYCLE = [
  "Created",
  "Plan settling",
  "Implementation",
  "Review",
  "Retro review",
] as const;

export function lifecycleStage(t: Task): {
  index: number;
  label: string;
} {
  if ((t.state === "done" || t.state === "failed") && t.retroReviewedAt)
    return {
      index: 6,
      label: "Closed",
    };
  if (t.state === "done" || t.state === "failed")
    return {
      index: 5,
      label: LIFECYCLE[4],
    };
  if (t.state === "in-review")
    return {
      index: 4,
      label: LIFECYCLE[3],
    };
  if (t.state === "running" || t.state === "needs-input")
    return {
      index: 3,
      label: LIFECYCLE[2],
    };
  if (t.planning || t.plan || t.planState === "draft" || t.planRequested)
    return {
      index: 2,
      label: LIFECYCLE[1],
    };
  return {
    index: 1,
    label: LIFECYCLE[0],
  };
}

interface SavedFeatureFilters {
  query: string;
  projectId: string;
  state: string;
}

function loadSavedFeatureFilters(): SavedFeatureFilters {
  const empty = {
    query: "",
    projectId: "",
    state: "",
  };
  try {
    const raw = localStorage.getItem("af-features-filters");
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SavedFeatureFilters>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      state: typeof parsed.state === "string" ? parsed.state : "",
    };
  } catch {
    return empty;
  }
}

function buildFeatureBoard(
  allRows: Task[],
  waitingByTask: Map<string, UserRequest>,
  filters: {
    query: string;
    projectId: string;
    state: string;
    stageFilter: number;
    waitingOnly: boolean;
  },
  nameOf: (id: string) => string,
) {
  const projectCounts = countByProject(
    filterWorkOrders(
      allRows,
      {
        query: filters.query,
        state: filters.state || undefined,
      },
      nameOf,
    ),
  );
  const stateCounts = countByState(
    filterWorkOrders(
      allRows,
      {
        query: filters.query,
        projectId: filters.projectId || undefined,
      },
      nameOf,
    ),
  );
  const baseRows = filterWorkOrders(
    allRows,
    {
      query: filters.query,
      projectId: filters.projectId || undefined,
      state: filters.state || undefined,
    },
    nameOf,
  );
  const rows = baseRows.filter(
    (t) =>
      (filters.stageFilter === 0 || lifecycleStage(t).index === filters.stageFilter) &&
      (!filters.waitingOnly || waitingByTask.has(t.id)),
  );
  return {
    projectCounts,
    stateCounts,
    baseRows,
    rows,
    waitingCount: baseRows.filter((t) => waitingByTask.has(t.id)).length,
    hasActiveFilters:
      hasActiveWorkOrderFilters({
        query: filters.query,
        projectId: filters.projectId || undefined,
        state: filters.state || undefined,
      }) ||
      filters.stageFilter !== 0 ||
      filters.waitingOnly,
  };
}

function FeaturesFilterBar({
  query,
  onQuery,
  projectFilter,
  onProject,
  stateFilter,
  onState,
  projects,
  projectCounts,
  stateCounts,
  total,
  matched,
  hasActiveFilters,
  onClear,
}: {
  query: string;
  onQuery: (value: string) => void;
  projectFilter: string;
  onProject: (value: string) => void;
  stateFilter: string;
  onState: (value: string) => void;
  projects: Project[];
  projectCounts: Map<string, number>;
  stateCounts: Map<string, number>;
  total: number;
  matched: number;
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div
      className="flex gap-3 flex-wrap mb-3 items-end"
      role="search"
      aria-label="Search and filter features"
    >
      <label className="flex-1 min-w-[220px]">
        <span className={labelCls}>Search features</span>
        <span className="relative block">
          <Search
            size={16}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            className={`${inputCls} w-full pl-9 pr-9`}
            type="search"
            value={query}
            placeholder="Title, prompt, tag, project, lane…"
            aria-label="Search features by title, prompt, tag, project or lane"
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onQuery("");
            }}
          />
          {query && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted cursor-pointer hover:text-danger"
              aria-label="Clear search"
              onClick={() => onQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </span>
      </label>
      <label>
        <span className={labelCls}>Project</span>
        <select
          className={inputCls}
          value={projectFilter}
          aria-label="Filter features by project"
          onChange={(e) => onProject(e.target.value)}
        >
          <option value="">All projects ({total})</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({projectCounts.get(p.id) ?? 0})
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={labelCls}>State</span>
        <select
          className={inputCls}
          value={stateFilter}
          aria-label="Filter features by state"
          onChange={(e) => onState(e.target.value)}
        >
          <option value="">All states ({matched})</option>
          {[
            ...stateCounts.keys(),
          ]
            .sort()
            .map((state) => (
              <option key={state} value={state}>
                {state} ({stateCounts.get(state) ?? 0})
              </option>
            ))}
        </select>
      </label>
      {hasActiveFilters && (
        <button type="button" className={btnGhostCls} onClick={onClear}>
          Clear filters
        </button>
      )}
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing length, split when next edited (see REVIEW.md)
export function FeaturesView({
  tasks,
  requests,
  projects,
  onOpen,
  refresh,
}: {
  tasks: Task[];
  requests: UserRequest[];
  projects: Project[];
  onOpen: (taskId: string) => void;
  refresh: () => void;
}) {
  // Quiet by design: the confirm dialog carries the danger warning, so
  // the button itself stays a small muted x until hovered.
  const btnRemoveCls =
    "p-1.5 rounded-md text-muted cursor-pointer hover:text-danger hover:bg-surface-sink active:translate-y-px";
  const removeFeature = async (t: Task) => {
    if (await deleteTaskWithConfirm(t)) refresh();
  };
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const [stageFilter, setStageFilter] = useState(0);
  const [waitingOnly, setWaitingOnly] = useState(false);
  const [savedFilters] = useState(loadSavedFeatureFilters);
  const [query, setQuery] = useState(savedFilters.query);
  const [projectFilter, setProjectFilter] = useState(savedFilters.projectId);
  const [stateFilter, setStateFilter] = useState(savedFilters.state);
  useEffect(() => {
    try {
      localStorage.setItem(
        "af-features-filters",
        JSON.stringify({
          query,
          projectId: projectFilter,
          state: stateFilter,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    query,
    projectFilter,
    stateFilter,
  ]);
  const clearFilters = () => {
    setQuery("");
    setProjectFilter("");
    setStateFilter("");
    setStageFilter(0);
    setWaitingOnly(false);
  };
  const [viewMode, setViewMode] = useState<"list" | "columns">(() => {
    try {
      return localStorage.getItem("af-features-view") === "columns" ? "columns" : "list";
    } catch {
      return "list";
    }
  });
  const switchView = (v: "list" | "columns") => {
    setViewMode(v);
    try {
      localStorage.setItem("af-features-view", v);
    } catch {
      /* ignore */
    }
  };
  const waitingByTask = new Map<string, UserRequest>();
  for (const r of requests) if (!waitingByTask.has(r.taskId)) waitingByTask.set(r.taskId, r);
  const stageCount = (n: number) => baseRows.filter((t) => lifecycleStage(t).index === n).length;
  const allRows = [
    ...tasks,
  ].sort((a, b) => {
    const wa = waitingByTask.has(a.id) ? 0 : 1;
    const wb = waitingByTask.has(b.id) ? 0 : 1;
    if (wa !== wb) return wa - wb;
    const sa = lifecycleStage(a).index;
    const sb = lifecycleStage(b).index;
    if (sa !== sb) return sa - sb;
    return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  });
  const { projectCounts, stateCounts, baseRows, rows, waitingCount, hasActiveFilters } =
    buildFeatureBoard(
      allRows,
      waitingByTask,
      {
        query,
        projectId: projectFilter,
        state: stateFilter,
        stageFilter,
        waitingOnly,
      },
      nameOf,
    );
  const filterBtn = (active: boolean) => (active ? btnCls : btnGhostCls);
  const renderRow = (t: Task) => {
    const stage = lifecycleStage(t);
    const actor = currentActor(t);
    const waiting = waitingByTask.get(t.id);
    return (
      <Surface
        key={t.id}
        surface="elevated"
        className="relative block w-full text-left border p-3 my-2 shadow-sm"
      >
        <button
          type="button"
          className={`${btnRemoveCls} absolute top-2 right-2`}
          aria-label="Remove feature permanently"
          title="Remove feature permanently"
          onClick={() => void removeFeature(t)}
        >
          <X size={14} />
        </button>
        <div className="flex gap-4 flex-wrap items-start justify-between pr-8">
          <div className="min-w-[220px] flex-1">
            <button
              className="font-bold text-left cursor-pointer hover:text-primary"
              onClick={() => onOpen(t.id)}
            >
              {t.title}
            </button>
            <span className="text-muted block text-sm">
              {nameOf(t.projectId)} · {t.taskType} · {t.state}
              {t.lane ? ` · ${t.lane} lane` : ""}
              {t.tags?.length ? ` · ${t.tags.map((tag) => `#${tag}`).join(" ")}` : ""} ·{" "}
              {actor.busy ? "◌ " : "● "}
              {actor.label} · {ageText(t.updatedAt)} ago{t.liveActor ? ` · ${t.liveActor}` : ""}
              {t.liveLast ? ` · ${t.liveLast.slice(0, 80)}` : ""}
            </span>
          </div>
          {waiting && (
            <button
              className="bg-danger text-on-danger px-2 py-1 font-bold cursor-pointer"
              onClick={() => onOpen(t.id)}
              title={waiting.question}
            >
              waiting on you: {requestLabel(waiting.kind)}
            </button>
          )}
        </div>
        <div
          className="flex items-center gap-1 mt-2 flex-wrap"
          aria-label={`Stage ${stage.index} of 5: ${stage.label}`}
        >
          {LIFECYCLE.map((label, i) => {
            const n = i + 1;
            const done = n < stage.index;
            const current = n === stage.index;
            return (
              <span key={label} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted">→</span>}
                <span
                  className={
                    current ? "text-primary font-bold" : done ? "text-success" : "text-muted"
                  }
                  title={label}
                >
                  {done ? "●" : current ? "◉" : "○"} <span className="max-md:hidden">{label}</span>
                </span>
              </span>
            );
          })}
          <span className="text-muted text-sm ml-2">
            {stage.index > 5 ? "Closed" : `Stage ${stage.index} of 5 · ${stage.label}`}
          </span>
          {t.rolledBackAt ? (
            <span
              className="text-success text-sm font-bold"
              title={`Rolled back ${t.rolledBackAt}`}
            >
              · rolled back
            </span>
          ) : null}
        </div>
      </Surface>
    );
  };
  const renderColumns = () => {
    const cols: {
      label: string;
      index: number;
    }[] = [
      ...LIFECYCLE.map((label, i) => ({
        label,
        index: i + 1,
      })),
      {
        label: "Closed",
        index: 6,
      },
    ];
    const visibleCols = stageFilter === 0 ? cols : cols.filter((c) => c.index === stageFilter);
    return (
      <div className="flex gap-3 overflow-x-auto items-stretch">
        {visibleCols.map(({ label, index }) => {
          const cards = rows.filter((t) => lifecycleStage(t).index === index);
          return (
            <div
              key={label}
              className="min-w-[240px] flex-1 border-l border-dotted border-surface-base-border pl-3 first:border-l-0 first:pl-0"
            >
              <div className="flex items-center justify-between p-1">
                <b>{label}</b>
                <span className="bg-primary text-on-primary px-2">{cards.length}</span>
              </div>
              {cards.length ? (
                // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
                cards.map((t) => {
                  const actor = currentActor(t);
                  const waiting = waitingByTask.get(t.id);
                  return (
                    <Surface
                      key={t.id}
                      surface="elevated"
                      className="relative block w-full text-left border p-3 my-2 shadow-sm"
                    >
                      <button
                        type="button"
                        className={`${btnRemoveCls} absolute top-2 right-2`}
                        aria-label="Remove feature permanently"
                        title="Remove feature permanently"
                        onClick={() => void removeFeature(t)}
                      >
                        <X size={14} />
                      </button>
                      <button
                        className="font-bold text-left cursor-pointer hover:text-primary block pr-8"
                        onClick={() => onOpen(t.id)}
                      >
                        {t.title}
                      </button>
                      <span className="text-muted block text-sm mt-1">
                        {nameOf(t.projectId)} · {t.taskType}
                        {t.lane ? ` · ${t.lane} lane` : ""}
                      </span>
                      <span className="block text-sm mt-1">
                        {actor.busy ? "◌ " : "● "}
                        {actor.label} · {ageText(t.updatedAt)} ago
                        {t.liveActor ? ` · ${t.liveActor}` : ""}
                        {t.liveLast ? ` · ${t.liveLast.slice(0, 80)}` : ""}
                        {t.rolledBackAt ? " · rolled back" : ""}
                      </span>
                      {waiting && (
                        <button
                          className="bg-danger text-on-danger px-2 py-1 font-bold cursor-pointer mt-2"
                          onClick={() => onOpen(t.id)}
                          title={waiting.question}
                        >
                          waiting on you: {requestLabel(waiting.kind)}
                        </button>
                      )}
                    </Surface>
                  );
                })
              ) : (
                <p className="text-muted p-1">—</p>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  return (
    <div>
      <h2>Features</h2>
      <p className="text-muted">
        Every feature in its lifecycle stage. A waiting badge means it is paused on a question in
        your inbox — stage has not moved.
      </p>
      <FeaturesFilterBar
        query={query}
        onQuery={setQuery}
        projectFilter={projectFilter}
        onProject={setProjectFilter}
        stateFilter={stateFilter}
        onState={setStateFilter}
        projects={projects}
        projectCounts={projectCounts}
        stateCounts={stateCounts}
        total={tasks.length}
        matched={baseRows.length}
        hasActiveFilters={hasActiveFilters}
        onClear={clearFilters}
      />
      <p className="text-muted text-sm mb-3" aria-live="polite">
        Showing {rows.length} of {tasks.length} features
        {hasActiveFilters ? " — filters active" : ""}
      </p>
      <div
        className="flex gap-4 flex-wrap mb-3"
        role="group"
        aria-label="Filter features by lifecycle stage"
      >
        <button
          className={filterBtn(stageFilter === 0 && !waitingOnly)}
          onClick={() => {
            setStageFilter(0);
            setWaitingOnly(false);
          }}
        >
          All stages ({baseRows.length})
        </button>
        {LIFECYCLE.map((label, i) => (
          <button
            key={label}
            className={filterBtn(stageFilter === i + 1 && !waitingOnly)}
            onClick={() => {
              setStageFilter(i + 1);
              setWaitingOnly(false);
            }}
          >
            {label} ({stageCount(i + 1)})
          </button>
        ))}
        <button className={filterBtn(waitingOnly)} onClick={() => setWaitingOnly((v) => !v)}>
          Waiting on you ({waitingCount})
        </button>
      </div>
      <div className="flex gap-4 flex-wrap mb-3" role="group" aria-label="Features view mode">
        <button className={filterBtn(viewMode === "list")} onClick={() => switchView("list")}>
          List view
        </button>
        <button className={filterBtn(viewMode === "columns")} onClick={() => switchView("columns")}>
          Column view
        </button>
      </div>
      {tasks.length === 0 ? (
        <p className="text-muted">
          No features yet — use <b>State a task</b>.
        </p>
      ) : rows.length === 0 ? (
        <Surface surface="elevated" className="border p-4 my-2">
          <p className="font-bold m-0">No features match these filters.</p>
          <p className="text-muted">
            {hasActiveFilters
              ? "Try a shorter search, or clear the filters to see every feature again."
              : "No features in this stage right now."}
          </p>
          {hasActiveFilters && (
            <button type="button" className={btnCls} onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </Surface>
      ) : viewMode === "columns" ? (
        renderColumns()
      ) : (
        rows.map(renderRow)
      )}
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const taskMatch = useMatch("/tasks/:taskId");
  const projectMatch = useMatch("/projects/:projectId");
  const taskId = taskMatch?.params.taskId ?? null;
  const routeProjectId = projectMatch?.params.projectId ?? null;
  const isRegister = location.pathname === "/register";
  const isNewTask = location.pathname === "/state-task";
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<TaskDetailData | null>(null);
  const [diff, setDiff] = useState("");
  const [dark, setDark] = useState(true);
  const selectedTaskRef = useRef<string | null>(null);
  selectedTaskRef.current = taskId;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [
    dark,
  ]);

  const refresh = useCallback(async () => {
    try {
      const [cap, proj, tsk] = await Promise.all([
        api("/api/capacity"),
        api("/api/projects"),
        api("/api/tasks"),
      ]);
      setCapacity(cap.d as Capacity);
      setProjects((proj.d.projects as Project[]) ?? []);
      setTasks((tsk.d.tasks as Task[]) ?? []);
      const sel = selectedTaskRef.current;
      if (sel) {
        const det = await api(`/api/tasks/${encodeURIComponent(sel)}`);
        if (det.d.task) {
          setDetail(det.d as TaskDetailData);
          const df = await api(`/api/tasks/${encodeURIComponent(sel)}/diff`);
          setDiff((df.d.diff as string) ?? "");
        }
      }
    } catch {
      /* server restarting; next tick retries */
    }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [
    refresh,
  ]);

  useEffect(() => {
    if (taskId) refresh();
    else {
      setDetail(null);
      setDiff("");
    }
  }, [
    taskId,
    refresh,
  ]);

  const selProject = projects.find((p) => p.id === routeProjectId);
  // Open requests: a worker parked in needs-input, or a planner decision
  // waiting (not while a re-review is still running and may replace it).
  const requests: UserRequest[] = tasks
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
    .flatMap((t) => {
      const stage = lifecycleStage(t);
      const base = {
        taskId: t.id,
        projectId: t.projectId,
        title: t.title,
        prompt: t.prompt,
        stage: stage.label,
        stageIndex: stage.index,
        updatedAt: t.updatedAt,
        state: t.state,
        context: t.waitingContext ?? [],
        activityFiles: (t.activity ?? []).map((a) => `${a.status} ${a.file}`),
      };
      const out: UserRequest[] = [];
      if (t.state === "needs-input")
        out.push({
          ...base,
          key: `${t.id}:worker`,
          kind: "worker",
          question:
            t.waitingQuestion ??
            "The worker is waiting for your answer, but it left no note — reply here to resume it.",
        });
      if (!t.planning && (t.planQuestions?.length ?? 0) > 0)
        out.push({
          ...base,
          key: `${t.id}:planner:${t.planQuestions.length}`,
          kind: "planner",
          question: t.planQuestions.join("\n"),
        });
      // All answered and only the owner's click is missing: plan drafted,
      // nothing open, next stage starts with Approve & queue.
      if (
        t.state === "planned" &&
        t.planState === "draft" &&
        !t.planning &&
        !(t.planQuestions?.length ?? 0)
      )
        out.push({
          ...base,
          key: `${t.id}:ready`,
          kind: "ready",
          question:
            "All questions are answered — this plan only needs your click: Approve plan & queue starts the next stage.",
        });
      // Blocked and failed are not stages: they are this same queue, with
      // the lifecycle stage above showing where the feature paused.
      if (t.state === "blocked")
        out.push({
          ...base,
          key: `${t.id}:blocked`,
          kind: "blocked",
          question: `${t.waitingQuestion ?? "No reason was recorded."}\n\nBlocked after ${t.attempts} attempt(s) — send it back to Planned to re-plan.`,
        });
      if (t.state === "failed" && !t.retroReviewedAt)
        out.push({
          ...base,
          key: `${t.id}:failed`,
          kind: "failed",
          question: `${t.waitingQuestion ?? "No failure note was recorded."}\n\nFailed after ${t.attempts} attempt(s) — its retro runs automatically; send it back to Planned to try again.`,
        });
      // A retro point filed as its own candidate task: the finished
      // feature is already closed; this point waits for its own accept
      // (planning starts) or remove decision.
      if (
        t.state === "planned" &&
        t.planState === "none" &&
        !t.planRequested &&
        (t.tags ?? []).includes("retro-point")
      )
        out.push({
          ...base,
          key: `${t.id}:candidate`,
          kind: "candidate",
          question: t.prompt,
        });
      return out;
    })
    .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  // Small transient note when a task moves between board columns.
  const [moves, setMoves] = useState<
    {
      key: string;
      taskId: string;
      title: string;
      from: string;
      to: string;
    }[]
  >([]);
  const prevStates = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const cur = new Map(
      tasks.map((t) => [
        t.id,
        t.state,
      ]),
    );
    if (prevStates.current === null) {
      prevStates.current = cur;
      return;
    }
    const fresh: typeof moves = [];
    for (const t of tasks) {
      const prev = prevStates.current.get(t.id);
      // needs-input already gets the big request toast; don't double up.
      if (prev && prev !== t.state && t.state !== "needs-input")
        fresh.push({
          key: `${t.id}:${prev}->${t.state}:${Date.now()}`,
          taskId: t.id,
          title: t.title,
          from: prev,
          to: t.state,
        });
    }
    prevStates.current = cur;
    if (!fresh.length) return;
    setMoves((p) =>
      [
        ...fresh,
        ...p,
      ].slice(0, 4),
    );
    for (const f of fresh)
      setTimeout(() => setMoves((p) => p.filter((x) => x.key !== f.key)), 4000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on a derived task-state signature, not raw array identity
  }, [
    tasks.map((t) => `${t.id}:${t.state}`).join("|"),
  ]);
  const [toasts, setToasts] = useState<UserRequest[]>([]);
  const seenRequests = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(requests.map((r) => r.key));
    if (seenRequests.current === null) {
      seenRequests.current = keys;
      return;
    }
    const fresh = requests.filter((r) => !seenRequests.current!.has(r.key));
    seenRequests.current = keys;
    if (!fresh.length) return;
    setToasts((prev) =>
      [
        ...fresh,
        ...prev,
      ].slice(0, 4),
    );
    for (const f of fresh)
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.key !== f.key)), 5000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on a derived request-key signature, not raw array identity
  }, [
    requests.map((r) => r.key).join("|"),
  ]);
  // Background-tab notifications (PWA): the service worker carries push
  // to the owner even when no dashboard tab is focused. Registration lives
  // here; the owner enables push from the Settings view, which owns the
  // subscription state.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  // A fresh request also fires a browser notification while any tab is
  // alive (the push path above covers the no-tab case).
  const notifiedKeys = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(requests.map((r) => r.key));
    if (notifiedKeys.current === null) {
      notifiedKeys.current = keys;
      return;
    }
    const fresh = requests.filter((r) => !notifiedKeys.current!.has(r.key));
    notifiedKeys.current = keys;
    if (!fresh.length || !("Notification" in window) || Notification.permission !== "granted")
      return;
    for (const r of fresh.slice(0, 2)) {
      try {
        const n = new Notification(`Agent Factory — ${requestLabel(r.kind)}`, {
          body: `${r.title}\n${r.question}`.slice(0, 200),
          tag: `af-${r.taskId}`,
        });
        n.onclick = () => {
          window.focus();
          navigate(`/tasks/${encodeURIComponent(r.taskId)}`);
          n.close();
        };
      } catch {
        /* notifications unavailable in this context */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on a derived request-key signature, not raw array identity
  }, [
    requests.map((r) => r.key).join("|"),
  ]);
  const goHome = () => navigate("/");
  const goView = (v: "register" | "task") =>
    navigate(v === "register" ? "/register" : "/state-task");
  const startTour = useCallback(() => {
    const d = driver({
      showProgress: true,
      allowClose: true,
      skipMissingElement: true,
      steps: [
        {
          element: "#tour-nav-inbox",
          popover: {
            title: "Inbox",
            description:
              "Requests needing your input: worker questions, plan approvals, blocked/failed tasks, candidate retro points.",
          },
        },
        {
          element: "#tour-nav-features",
          popover: {
            title: "Features",
            description: "All tasks across projects, grouped by lifecycle state.",
          },
        },
        {
          element: "#tour-nav-state",
          popover: {
            title: "State a task",
            description: "Submit a new feature request to the factory.",
          },
        },
        {
          element: "#tour-nav-register",
          popover: {
            title: "Register project",
            description: "Adopt a local repo folder into the factory.",
          },
        },
        {
          element: "#tour-nav-settings",
          popover: {
            title: "Settings",
            description: "Parallelism, RAM floor, models, souls, dispatcher toggle.",
          },
        },
        {
          element: "#tour-nav-wizard",
          popover: {
            title: "Wizard demo",
            description: "Generate a reproducible NixOS configuration for the factory.",
          },
        },
        {
          element: "#tour-projects",
          popover: {
            title: "Projects",
            description: "Registered project folders and their running/idle status.",
          },
        },
        {
          element: "#tour-capacity",
          popover: {
            title: "Capacity",
            description: "Running/queued counts, free RAM, and dispatcher advice.",
          },
        },
        {
          element: "#tour-main",
          popover: {
            title: "Main panel",
            description: "Inbox, features, task detail, plans, diffs, and settings live here.",
          },
        },
      ],
    });
    d.drive();
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("tour") !== "1") return;
    const t = setTimeout(startTour, 800);
    return () => clearTimeout(t);
  }, [
    location.search,
    startTour,
  ]);
  const viewHome = location.pathname === "/";
  // Navigation is flat menu items with a left active bar — never raised
  // like action buttons (btnCls), so the two read differently at a glance.
  const navCls = (active: boolean) =>
    `block w-full px-3 py-2 text-left cursor-pointer border-l-4 ${active ? "bg-surface-sink text-primary border-primary font-bold" : "border-transparent text-on-surface-base hover:bg-surface-sink"}`;

  return (
    <Surface
      surface="base"
      className="flex h-screen max-md:flex-col max-md:h-auto max-md:min-h-screen"
    >
      <aside
        id="tour-sidebar"
        className="w-[260px] shrink-0 border-r border-surface-base-border p-4 overflow-y-auto flex flex-col max-md:w-auto max-md:border-b"
      >
        <nav className="flex flex-col">
          <button
            id="tour-nav-inbox"
            data-testid="nav-inbox"
            className={`${navCls(viewHome || location.pathname === "/requests")} flex items-center gap-2`}
            aria-label="Requests for your input"
            title={requests.length === 0 ? "No open requests right now" : undefined}
            onClick={goHome}
          >
            Inbox
            {requests.length > 0 && (
              <span className="bg-danger text-on-danger px-1.5 text-xs font-bold">
                {requests.length}
              </span>
            )}
          </button>
          <button
            id="tour-nav-features"
            data-testid="nav-features"
            className={navCls(location.pathname === "/features")}
            onClick={() => navigate("/features")}
          >
            Features
          </button>
          <button
            id="tour-nav-state"
            data-testid="nav-state"
            className={navCls(isNewTask)}
            onClick={() => goView("task")}
          >
            State a task
          </button>
          <button
            id="tour-nav-register"
            data-testid="nav-register"
            className={navCls(isRegister)}
            onClick={() => goView("register")}
          >
            Register project folder
          </button>
          <button
            id="tour-nav-settings"
            data-testid="nav-settings"
            className={navCls(location.pathname === "/settings")}
            onClick={() => navigate("/settings")}
          >
            Settings
          </button>
          <button
            id="tour-nav-wizard"
            data-testid="nav-wizard"
            className={navCls(location.pathname === "/wizard")}
            onClick={() => navigate("/wizard")}
          >
            Wizard demo
          </button>
          <button
            className={navCls(false)}
            onClick={() => startTour()}
            title="Guided tour of the control room"
          >
            Tour
          </button>
        </nav>
        <h3>Projects</h3>
        <div id="tour-projects" className="flex flex-col gap-1">
          {projects.length ? (
            projects.map((p) => {
              const waiting = requests.filter((r) => r.projectId === p.id).length;
              const running = tasks.filter(
                (t) => t.projectId === p.id && (t.state === "running" || t.state === "in-review"),
              ).length;
              return (
                <button
                  key={p.id}
                  className={navCls(!taskId && routeProjectId === p.id)}
                  onClick={() => navigate(`/projects/${encodeURIComponent(p.id)}`)}
                >
                  <span className="block">
                    {p.name}
                    {p.stale ? " — STALE" : ""}
                    {p.online ? "" : " (offline)"}
                  </span>
                  <span className="block text-xs mt-0.5">
                    {waiting > 0 && (
                      <span className="bg-danger text-on-danger px-1.5 font-bold mr-2">
                        {waiting} waiting on you
                      </span>
                    )}
                    <span className="text-muted">
                      {running > 0 ? `${running} running` : "idle"}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <p>none yet</p>
          )}
        </div>
        <div className="mt-auto border-t border-surface-base-border pt-3">
          {capacity ? (
            <div id="tour-capacity" className="text-sm mb-3">
              <div>
                <span className="text-success">●</span> server ok
              </div>
              <div>
                Running: {capacity.running}/{capacity.maxParallelTasks} · Queued: {capacity.queued}
              </div>
              <div>
                Free RAM: {capacity.freeRamMb} MB (floor {capacity.ramFloorMb} MB)
              </div>
              {capacity.ramAdvice && (
                <div className="mt-2">
                  <div className="text-warning font-bold">{capacity.ramAdvice.reason}</div>
                  <div className="flex gap-4 mt-1">
                    <button
                      className={btnGhostCls}
                      onClick={async () => {
                        await api(
                          "/api/settings",
                          post({
                            maxParallelTasks: capacity.ramAdvice?.suggested,
                          }),
                        );
                        refresh();
                      }}
                    >
                      Set parallel tasks to {capacity.ramAdvice.suggested}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p>capacity: …</p>
          )}
          <button
            className={btnGhostCls}
            title={dark ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() => setDark((v) => !v)}
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
      </aside>
      <main
        id="tour-main"
        data-testid="main"
        className="flex-1 min-w-0 overflow-y-auto p-4 max-md:overflow-visible"
      >
        {(toasts.length > 0 || moves.length > 0) && (
          <div className="fixed top-4 right-4 w-80 max-w-[90vw] z-10 flex flex-col gap-2">
            {moves.map((m) => (
              <Surface
                key={m.key}
                as="button"
                surface="elevated"
                className="block w-full text-left border p-2 cursor-pointer shadow-sm text-sm"
                onClick={() => {
                  setMoves((p) => p.filter((x) => x.key !== m.key));
                  navigate(`/tasks/${encodeURIComponent(m.taskId)}`);
                }}
              >
                <b>{m.title}</b> <span className="text-muted">{m.from} →</span> <b>{m.to}</b>
              </Surface>
            ))}
            {toasts.map((r) => (
              <Surface
                key={r.key}
                as="button"
                surface="elevated"
                className="block w-full text-left border-2 border-warning p-3 cursor-pointer shadow"
                onClick={() => {
                  setToasts((prev) => prev.filter((x) => x.key !== r.key));
                  navigate(`/tasks/${encodeURIComponent(r.taskId)}`);
                }}
              >
                <b>
                  {projects.find((p) => p.id === r.projectId)?.name ?? r.projectId} —{" "}
                  {requestLabel(r.kind)}
                </b>
                <span className="block">{r.title}</span>
                <span className="text-muted block">{r.question}</span>
              </Surface>
            ))}
          </div>
        )}
        {!taskId ? (
          viewHome || location.pathname === "/requests" ? (
            <RequestsView
              requests={requests}
              projects={projects}
              tasks={tasks}
              onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
              refresh={refresh}
            />
          ) : location.pathname === "/features" ? (
            <FeaturesView
              tasks={tasks}
              requests={requests}
              projects={projects}
              onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
              refresh={refresh}
            />
          ) : location.pathname === "/settings" ? (
            <SettingsView />
          ) : isRegister ? (
            <RegisterView
              projects={projects}
              refresh={refresh}
              onDone={(id) => navigate(`/projects/${encodeURIComponent(id)}`)}
            />
          ) : isNewTask ? (
            <NewTaskView
              projects={projects}
              refresh={refresh}
              onDone={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
            />
          ) : location.pathname === "/wizard" ? (
            <WizardDemo />
          ) : selProject ? (
            <ProjectDetail
              key={selProject.id}
              p={selProject}
              tasks={tasks}
              requests={requests}
              onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
              onStateTask={() => {
                try {
                  localStorage.setItem("af-newtask-project", selProject.id);
                } catch {
                  /* ignore */
                }
                navigate("/state-task");
              }}
              refresh={refresh}
            />
          ) : routeProjectId ? (
            <p>Project not found or still loading…</p>
          ) : (
            <FeaturesView
              tasks={tasks}
              requests={requests}
              projects={projects}
              onOpen={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
              refresh={refresh}
            />
          )
        ) : (
          <div className="h-full flex flex-col">
            <div className="flex-1 min-h-0">
              {detail ? (
                <TaskDetail
                  key={detail.task.id}
                  d={detail}
                  diff={diff}
                  refresh={refresh}
                  onOpenTask={(id) => navigate(`/tasks/${encodeURIComponent(id)}`)}
                  onDeleted={() => {
                    setDetail(null);
                    navigate("/features");
                    void refresh();
                  }}
                />
              ) : (
                "Select a task card."
              )}
            </div>
          </div>
        )}
      </main>
    </Surface>
  );
}
