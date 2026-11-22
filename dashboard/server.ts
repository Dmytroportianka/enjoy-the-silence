import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCi } from "../src/crew/ci";
import {
  answerPlanQuestions,
  commentOnPlan,
  dispatchTick,
  ensureWarmWorktrees,
  fileRetroPoints,
  freeRamMb,
  notifyNeedsInput,
  ramAdvice,
  runningCount,
  runPlanPipeline,
  runRetro,
  runRetroFollowup,
  runTaskPipeline,
  scoutProject,
  taskDiff,
  WorktreePoolFullError,
  worktreeActivity,
} from "../src/crew/dispatch";
import {
  activeStationFor,
  getActivePresetId,
  getPresets,
  getStationRoutes,
  killStation,
  lastStationLine,
  setActivePreset,
  setPresets,
  setStationRoutes,
  stationOutput,
} from "../src/crew/orchestrator";
import {
  PROVIDER_IDS,
  providerCatalogue,
  providerInstalled,
  suggestedPresets,
} from "../src/crew/providers";
import { rollbackEligibility, rollbackTask } from "../src/crew/rollback";
import { FactoryStore } from "../src/crew/store";
import {
  approvePlan,
  coderPersona,
  deriveTitle,
  draftPlan,
  findDuplicateTask,
  getGlobalSouls,
  newTask,
  queuedTasks,
  setGlobalSouls,
  smePersona,
  type TaskState,
} from "../src/crew/task";
import { changedShots } from "../src/crew/visual";
import { clarificationGate } from "../src/governance/gates";

// Control room. Owns no state: reads/writes the same factory-data job cards
// the orchestrator reconciles from, so it can restart freely and the factory
// runs headless without it. Local-only; put basic-auth in front (see README).
// FACTORY_DATA overrides the location (production sets /data via factory.nix).
const dataDir = process.env.FACTORY_DATA ?? join(import.meta.dir, "..", "factory-data");
const store = new FactoryStore(dataDir);
const port = Number(process.env.DASHBOARD_PORT ?? 4319);
// React SPA built by Vite (bun run build:ui); dist/ is served statically.
const ui = join(import.meta.dir, "dist", "index.html");

// Dispatcher: queued tasks auto-dispatch in priority order while the
// parallel-task cap and RAM floor allow; the rest stay queued in the
// store. DASHBOARD_MAX_PARALLEL_TASKS caps tasks running in parallel —
// it is not a count of agents: one task runs its stations sequentially.
// (The old DASHBOARD_MAX_AGENTS name still works as a fallback.)
// DASHBOARD_AGENT_COMMAND overrides the agent binary (space-separated)
// — used by tests with a stub agent.
// The cap is owner-adjustable at runtime (sidebar RAM advice / Settings);
// the choice persists in <dataDir>/settings.json across restarts and
// wins over the env default.
const settingsPath = join(dataDir, "settings.json");
interface FactorySettings {
  maxParallelTasks?: number;
  ramFloorMb?: number;
  dispatchEnabled?: boolean;
  defaultLane?: string;
  approvalMode?: string; // "auto" (default: plans move forward) or "click" (wait for the owner)
  stationRoutes?: Partial<
    Record<
      string,
      {
        provider?: string;
        model: string;
        effort: string;
      }
    >
  >;
  presets?: unknown;
  activePresetId?: string;
  smeSoul?: string;
  coderSoul?: string;
}
function readSettings(): FactorySettings {
  try {
    return existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as FactorySettings)
      : {};
  } catch {
    return {};
  }
}
function writeSettings(next: FactorySettings): void {
  try {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          ...readSettings(),
          ...next,
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort; runtime values already changed */
  }
}
const initialSettings = readSettings();
let maxParallelTasks = Number(
  initialSettings.maxParallelTasks ??
    process.env.DASHBOARD_MAX_PARALLEL_TASKS ??
    process.env.DASHBOARD_MAX_AGENTS ??
    15,
);
let ramFloorMb = Number(initialSettings.ramFloorMb ?? process.env.DASHBOARD_RAM_FLOOR_MB ?? 1024);
let dispatchEnabled = initialSettings.dispatchEnabled ?? process.env.DASHBOARD_DISPATCH !== "off";
let defaultLane = [
  "fast",
  "standard",
  "careful",
].includes(String(initialSettings.defaultLane))
  ? String(initialSettings.defaultLane)
  : "";
let approvalMode = initialSettings.approvalMode === "click" ? "click" : "auto";
if (initialSettings.stationRoutes)
  setStationRoutes(initialSettings.stationRoutes as Parameters<typeof setStationRoutes>[0]);
if (initialSettings.presets) setPresets(initialSettings.presets, initialSettings.activePresetId);
// Suggested presets for the Settings picker: computed once from the CLIs
// actually installed on this machine.
const installedProviders = PROVIDER_IDS.filter((id) => providerInstalled(id));
setGlobalSouls({
  sme: initialSettings.smeSoul ?? "",
  coder: initialSettings.coderSoul ?? "",
});

// Web Push (PWA notifications): VAPID keys are generated once into the
// data dir; browser subscriptions accumulate next to them. The push
// sender lives in dispatch.ts (pushToOwner) and reads the same files.
const vapidPath = join(dataDir, "vapid.json");
const pushSubsPath = join(dataDir, "push-subscriptions.json");
interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}
function ensureVapidKeys(): VapidKeys {
  try {
    if (existsSync(vapidPath)) return JSON.parse(readFileSync(vapidPath, "utf8")) as VapidKeys;
  } catch {
    /* regenerate below */
  }
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
  const pair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pub = pair.publicKey.export({
    format: "jwk",
  });
  const uncompressed = Buffer.concat([
    Buffer.from([
      4,
    ]),
    Buffer.from(pub.x ?? "", "base64url"),
    Buffer.from(pub.y ?? "", "base64url"),
  ]);
  const keys: VapidKeys = {
    publicKey: uncompressed.toString("base64url"),
    privateKey: Buffer.from(
      JSON.stringify(
        pair.privateKey.export({
          format: "jwk",
        }),
      ),
    ).toString("base64url"),
    subject: process.env.DASHBOARD_VAPID_SUBJECT ?? "mailto:owner@localhost",
  };
  writeFileSync(vapidPath, JSON.stringify(keys, null, 2));
  return keys;
}
function readPushSubs(): {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}[] {
  try {
    return existsSync(pushSubsPath)
      ? (JSON.parse(readFileSync(pushSubsPath, "utf8")) as {
          endpoint: string;
          keys: {
            p256dh: string;
            auth: string;
          };
        }[])
      : [];
  } catch {
    return [];
  }
}
// Free-RAM samples (one per dispatch tick) feeding the capacity advice:
// the factory asks the owner to add or remove parallel slots, it never
// changes the cap on its own.
const ramSamples: number[] = [];
// (ramFloorMb is declared with the other runtime settings above, from settings.json first, env second.)
const agentCommand = process.env.DASHBOARD_AGENT_COMMAND?.split(" ").filter(Boolean);
const activePipelines = new Set<string>();
const scoutRuns = new Set<string>(); // projectIds with a scout gathering info now
const planRuns = new Map<string, string>(); // taskId -> ISO start, for live planning progress
const retroRuns = new Set<string>(); // taskIds with a retrospective station in flight
const deletingTasks = new Set<string>(); // taskIds with a DELETE in flight
const rollingBack = new Set<string>(); // taskIds with a rollback in flight
function launchPipeline(taskId: string): void {
  if (activePipelines.has(taskId)) return;
  activePipelines.add(taskId);
  void runTaskPipeline(taskId, {
    store,
    command: agentCommand,
    maxParallelTasks,
  })
    .catch(() => {})
    .finally(() => activePipelines.delete(taskId));
}
// Queued planning, launched by the dispatcher ahead of implementation
// (planning offloads the human). planRuns tracks it for live progress;
// dispatchTick owns the activePipelines slot while it runs.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function launchPlan(taskId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  planRuns.set(taskId, startedAt);
  try {
    // A failed planning run is a system event: retry once automatically
    // before it may sit as "last attempt failed" for the owner.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await runPlanPipeline(taskId, {
          store,
          command: agentCommand,
          maxParallelTasks,
          autoApprove: approvalMode === "auto",
        });
        return;
      } catch (err) {
        // No free worktree slot is not a failure: the task simply stays
        // queued for planning (planRequested kept, stage reads Planning)
        // and a later dispatch tick starts it when a slot frees. One
        // queue note, not a failure per attempt.
        if (err instanceof WorktreePoolFullError) {
          const prompts = await store.listPrompts(taskId).catch(() => []);
          if (!prompts[prompts.length - 1]?.text.startsWith("queued for planning")) {
            await store
              .appendPrompt(taskId, {
                at: new Date().toISOString(),
                kind: "system",
                text: "queued for planning — all worktree slots are in use; planning starts automatically when one frees, no owner input needed",
              })
              .catch(() => {});
          }
          return;
        }
        if (attempt === 1) {
          await store
            .appendPrompt(taskId, {
              at: new Date().toISOString(),
              kind: "system",
              text: `planning failed (${err instanceof Error ? err.message : String(err)}) — automatically retrying once; no owner input`,
            })
            .catch(() => {});
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    await store
      .appendPrompt(taskId, {
        at: new Date().toISOString(),
        kind: "system",
        text: `planning failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
    // Do not hot-loop a failing planner every dispatch tick: clear the
    // auto-plan request; sweepAutoPlan re-queues it after a backoff.
    const failed = await store.readTask(taskId).catch(() => null);
    if (failed?.planRequested)
      await store
        .writeTask({
          ...failed,
          planRequested: false,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {});
  } finally {
    planRuns.delete(taskId);
  }
}
function dispatchNow(): void {
  ramSamples.push(freeRamMb());
  if (ramSamples.length > 200) ramSamples.shift();
  // The Settings dispatcher toggle pauses all new launches and resumes;
  // already-running pipelines finish on their own either way.
  if (dispatchEnabled)
    void dispatchTick({
      store,
      command: agentCommand,
      maxParallelTasks,
      ramFloorMb,
      active: activePipelines,
      launchPlan,
      autoApprove: approvalMode === "auto",
    }).catch(() => {});
  void sweepRetros().catch(() => {});
  void sweepAttention().catch(() => {});
  void sweepAutoPlan().catch(() => {});
}

// A stated task starts planning on its own, wherever it was stated:
// the State-a-task form queues it at creation, and this sweep queues
// any other planned task that never got the request (stated before
// auto-planning existed, or written to disk directly). There is no
// Generate button: planning is automatic, full stop. Two behaviours
// keep that safe: retro-point candidates wait for the owner's accept
// click in the Inbox, and a task whose planning already failed only
// re-enters the queue after a 10-minute backoff (launchPlan already
// retried it once at failure time), so a broken planner cannot
// hot-loop every tick.
const PLAN_RETRY_BACKOFF_MS = 10 * 60_000;
async function sweepAutoPlan(): Promise<void> {
  const tasks = await store.listTasks().catch(() => []);
  for (const t of tasks) {
    if (t.state !== "planned" || t.planState !== "none" || t.planRequested) continue;
    if ((t.tags ?? []).includes("retro-point")) continue;
    const prompts = await store.listPrompts(t.id).catch(() => []);
    const failed = [
      ...prompts,
    ]
      .reverse()
      .find((p) => p.text.startsWith("planning failed:"));
    if (failed && Date.now() - Date.parse(failed.at) < PLAN_RETRY_BACKOFF_MS) continue;
    await store
      .writeTask({
        ...t,
        planRequested: true,
        updatedAt: new Date().toISOString(),
      })
      .catch(() => {});
  }
}

// Escalation: when a task parks in needs-input, fire the configured webhook
// once (until it leaves that state), so a task waiting for the owner at 2am
// is not silent. Optional — no DASHBOARD_WEBHOOK_URL means no-op, and the
// dashboard queue remains the always-on path.
const notifiedInput = new Set<string>();
async function sweepAttention(): Promise<void> {
  const tasks = await store.listTasks();
  for (const t of tasks) {
    if (t.state !== "needs-input") {
      notifiedInput.delete(t.id);
      continue;
    }
    if (notifiedInput.has(t.id)) continue;
    notifiedInput.add(t.id);
    const prompts = await store.listPrompts(t.id).catch(() => []);
    const last = prompts[prompts.length - 1]?.text ?? "";
    void notifyNeedsInput(t.id, last);
  }
}

// Every finished or failed task gets a retrospective automatically: a
// fresh station reviews the whole run once the dust settles (30s after
// the last write, so the pipeline's final records are in). A failed retro
// is a system event: the sweep retries it automatically (bounded, with
// backoff) instead of leaving an error retro for the owner to re-run.
const retroRetries = new Map<string, number>();
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
async function sweepRetros(): Promise<void> {
  const tasks = await store.listTasks();
  for (const t of tasks) {
    if (t.state !== "done" && t.state !== "failed") continue;
    if (retroRuns.has(t.id) || activePipelines.has(t.id)) continue;
    if (Date.now() - Date.parse(t.updatedAt) < 30_000) continue;
    const existing = await store.readRetro(t.id).catch(() => null);
    if (existing && !existing.error) {
      // A retro that exists but was never filed (written before this
      // flow, or by a manual re-run) still closes the feature and
      // files its points as candidate tasks, exactly once.
      if (!t.retroReviewedAt && !retroRuns.has(t.id)) {
        retroRuns.add(t.id);
        void fileRetroPoints(store, t)
          .catch(() => {})
          .finally(() => retroRuns.delete(t.id));
      }
      continue;
    }
    if (existing?.error) {
      const tries = retroRetries.get(t.id) ?? 0;
      if (tries >= 2) continue; // bounded: after two auto-retries the error retro stands
      if (Date.now() - Date.parse(existing.at) < 5 * 60_000) continue; // backoff between retries
      retroRetries.set(t.id, tries + 1);
      await store
        .appendPrompt(t.id, {
          at: new Date().toISOString(),
          kind: "system",
          text: `retro failed (${existing.error}) — automatically retrying (attempt ${tries + 2}); no owner input`,
        })
        .catch(() => {});
    }
    retroRuns.add(t.id);
    void runRetro(t.id, {
      store,
      command: agentCommand,
      maxParallelTasks,
    })
      // The feature closes itself; each point is filed as its own
      // candidate task for the owner to accept or remove separately.
      .then(async () => {
        const fresh = await store.readTask(t.id).catch(() => null);
        if (fresh) await fileRetroPoints(store, fresh).catch(() => {});
      })
      .catch(async (err) => {
        await store
          .writeRetro(t.id, {
            text: "",
            findings: [],
            at: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          })
          .catch(() => {});
      })
      .finally(() => retroRuns.delete(t.id));
  }
}
// Dev mode: one owner-configured dev server per project, spawned in the
// project folder, logs kept in a ring buffer. Started only by an explicit
// button click; killed only by its own Stop (scoped to that process).
interface DevProc {
  proc: ReturnType<typeof Bun.spawn>;
  since: string;
  port: number;
  log: string[];
  exited: boolean;
}
const devProcs = new Map<string, DevProc>();
function devStatus(id: string): {
  running: boolean;
  since: string | null;
  port: number;
} {
  const d = devProcs.get(id);
  return {
    running: !!d && !d.exited,
    since: d?.since ?? null,
    port: d?.port ?? 0,
  };
}
function pumpLog(d: DevProc, stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  void (async () => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (line) d.log.push(line);
        if (d.log.length > 200) d.log.shift();
      }
    }
  })().catch(() => {});
}

// The interval always runs; the Settings toggle gates launching inside dispatchNow.
setInterval(dispatchNow, 3000);
// Warm the worktree pools up front (exactly maxParallelTasks slots per
// project) so the first tasks do not pay worktree creation either.
void (async () => {
  for (const project of await store.listProjects()) {
    if (project.lastCommit)
      ensureWarmWorktrees(project.repoPath, project.id, maxParallelTasks, project.lastCommit);
  }
})().catch(() => {});

function basicAuthOk(req: Request): boolean {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return true; // local-only default; set both to gate
  const h = req.headers.get("authorization") ?? "";
  const [scheme, enc] = h.split(" ");
  if (scheme !== "Basic" || !enc) return false;
  return atob(enc) === `${user}:${pass}`;
}

// Bind IPv4 loopback by default: Bun's "localhost" binds only [::1] here,
// so 127.0.0.1 and every LAN address refuse the connection. `bun run dev`
// sets DASHBOARD_HOST=0.0.0.0 to reach this server from other machines.
const server = Bun.serve({
  port,
  hostname: process.env.DASHBOARD_HOST ?? "127.0.0.1",
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  async fetch(req) {
    if (!basicAuthOk(req))
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": "Basic",
        },
      });
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const file = Bun.file(ui);
      if (!(await file.exists()))
        return new Response("dashboard UI not built — run: bun run build:ui", {
          status: 503,
        });
      return new Response(file, {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    if (url.pathname.startsWith("/assets/")) {
      const file = Bun.file(join(import.meta.dir, "dist", url.pathname));
      if (!(await file.exists()))
        return new Response("not found", {
          status: 404,
        });
      return new Response(file);
    }
    // PWA: manifest, service worker, icons live in dashboard/public and
    // land in dist via Vite's publicDir. The service worker must never be
    // cached, or owners keep a stale notification bridge.
    if (
      [
        "/manifest.webmanifest",
        "/sw.js",
        "/icon.svg",
        "/icon-192.png",
        "/icon-512.png",
      ].includes(url.pathname)
    ) {
      const file = Bun.file(join(import.meta.dir, "dist", url.pathname.slice(1)));
      if (!(await file.exists()))
        return new Response("not found — run: bun run build:ui", {
          status: 404,
        });
      const type = url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".svg")
          ? "image/svg+xml"
          : url.pathname.endsWith(".png")
            ? "image/png"
            : "application/manifest+json";
      return new Response(file, {
        headers: {
          "content-type": type,
          "cache-control": "no-cache",
        },
      });
    }
    // Web Push: the browser fetches the VAPID public key, subscribes with
    // its push service, and posts the subscription here. Keys and
    // subscriptions live in the data dir, next to settings.json.
    if (url.pathname === "/api/push/vapid-key" && req.method === "GET") {
      const vapid = ensureVapidKeys();
      return Response.json({
        publicKey: vapid.publicKey,
      });
    }
    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        endpoint?: string;
        keys?: {
          p256dh?: string;
          auth?: string;
        };
      } | null;
      if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth)
        return Response.json(
          {
            error: "endpoint and keys required",
          },
          {
            status: 400,
          },
        );
      const subs = readPushSubs().filter((s) => s.endpoint !== body.endpoint);
      subs.push({
        endpoint: body.endpoint,
        keys: {
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
        },
      });
      writeFileSync(pushSubsPath, JSON.stringify(subs, null, 2));
      return Response.json({
        status: "subscribed",
        count: subs.length,
      });
    }
    if (url.pathname === "/api/push/subscribe" && req.method === "DELETE") {
      const body = (await req.json().catch(() => null)) as {
        endpoint?: string;
      } | null;
      const subs = readPushSubs().filter((s) => s.endpoint !== body?.endpoint);
      writeFileSync(pushSubsPath, JSON.stringify(subs, null, 2));
      return Response.json({
        status: "unsubscribed",
        count: subs.length,
      });
    }
    if (url.pathname === "/api/deferred" && req.method === "GET") {
      const all: unknown[] = [];
      for (const project of await store.listProjects()) {
        for (const d of await store.listDeferred(project.id)) all.push(d);
      }
      return Response.json({
        deferred: all,
      });
    }
    const deferredDismiss = url.pathname.match(/^\/api\/deferred\/([^/]+)\/dismiss$/);
    if (deferredDismiss && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        projectId?: string;
      };
      const projectId = String(body.projectId ?? "");
      const point = projectId
        ? await store
            .setDeferredStatus(projectId, deferredDismiss[1] ?? "", "dismissed")
            .catch(() => null)
        : null;
      if (!point)
        return Response.json(
          {
            error: "deferred point not found",
          },
          {
            status: 404,
          },
        );
      return Response.json({
        status: "dismissed",
        point,
      });
    }
    if (url.pathname === "/api/projects" && req.method === "GET") {
      const ids = await store.listProjectIds();
      const projects = await Promise.all(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
        ids.map(async (id) => {
          const online = store.isProjectOnline(id);
          const [project, staleness, scoutSuggestions] = online
            ? await Promise.all([
                store.readProject(id),
                store.projectStaleness(id),
                store.readScoutSuggestions(id),
              ])
            : [
                null,
                {
                  lastCommit: "",
                  currentCommit: "",
                  stale: false,
                },
                null,
              ];
          return {
            id,
            online,
            name: project?.name ?? id,
            repoPath: project?.repoPath ?? "",
            description: project?.description ?? "",
            goals: project?.goals ?? [],
            moat: project?.moat ?? "",
            features: project?.features ?? [],
            lastCommit: staleness.lastCommit,
            currentCommit: staleness.currentCommit,
            stale: staleness.stale,
            lastSyncAt: project?.lastSyncAt ?? "",
            devCommand: project?.devCommand ?? "",
            devPort: project?.devPort ?? 0,
            testMode: project?.testMode ?? "checks",
            businessPlan: project?.businessPlan ?? "",
            rules: project?.rules ?? "",
            smeSoul: project?.smeSoul ?? "",
            smePersona: project ? smePersona(project) : "",
            coderSoul: project?.coderSoul ?? "",
            coderPersona: project ? coderPersona(project) : "",
            scouting: scoutRuns.has(id),
            scoutSuggestions,
            ci: project?.repoPath ? analyzeCi(project.repoPath) : null,
            dev: devStatus(id),
          };
        }),
      );
      return Response.json({
        projects,
      });
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        id?: string;
        folderPath?: string;
        name?: string;
        testMode?: string;
        description?: string;
        businessPlan?: string;
        rules?: string;
        smeSoul?: string;
      };
      const id = String(body.id ?? "").trim();
      // A pasted file:// URL (file manager / browser on the operator's
      // laptop) names a path on this server once the scheme is stripped;
      // the http page itself may never load or link file://.
      let folderPath = String(body.folderPath ?? "").trim();
      if (folderPath.startsWith("file://")) {
        const raw = folderPath.replace(/^file:\/\/(localhost)?/i, "");
        try {
          folderPath = decodeURIComponent(raw);
        } catch {
          folderPath = raw;
        }
      }
      if (!id || !folderPath)
        return Response.json(
          {
            error: "id and folderPath required",
          },
          {
            status: 400,
          },
        );
      const testModes = [
        "dev",
        "checks",
        "push-only",
      ];
      try {
        const project = await store.registerProject(id, folderPath, {
          ...(body.name
            ? {
                name: String(body.name),
              }
            : {}),
          ...(testModes.includes(String(body.testMode))
            ? {
                testMode: String(body.testMode) as "dev" | "checks" | "push-only",
              }
            : {}),
          description: String(body.description ?? ""),
          businessPlan: String(body.businessPlan ?? ""),
          rules: String(body.rules ?? ""),
          smeSoul: String(body.smeSoul ?? ""),
        });
        return Response.json({
          status: "registered",
          project,
        });
      } catch (err) {
        return Response.json(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          {
            status: 400,
          },
        );
      }
    }
    const scoutAction = url.pathname.match(/^\/api\/projects\/([^/]+)\/scout$/);
    if (scoutAction && req.method === "POST") {
      const projectId = scoutAction[1] ?? "";
      const project = await store.readProject(projectId);
      if (!project)
        return Response.json(
          {
            error: "project not found or offline",
          },
          {
            status: 404,
          },
        );
      if (scoutRuns.has(projectId))
        return Response.json(
          {
            status: "scouting",
          },
          {
            status: 202,
          },
        );
      scoutRuns.add(projectId);
      void scoutProject(projectId, {
        store,
        command: agentCommand,
      })
        .catch(async (err) => {
          await store
            .writeScoutSuggestions(projectId, {
              description: "",
              rules: "",
              smeSoul: "",
              coderSoul: "",
              at: new Date().toISOString(),
              error: err instanceof Error ? err.message : String(err),
            })
            .catch(() => {});
        })
        .finally(() => scoutRuns.delete(projectId));
      return Response.json(
        {
          status: "scouting",
        },
        {
          status: 202,
        },
      );
    }
    const contextAction = url.pathname.match(/^\/api\/projects\/([^/]+)\/context$/);
    if (contextAction && req.method === "POST") {
      const project = await store.readProject(contextAction[1] ?? "");
      if (!project)
        return Response.json(
          {
            error: "project not found or offline",
          },
          {
            status: 404,
          },
        );
      const body = (await req.json().catch(() => ({}))) as {
        description?: string;
        businessPlan?: string;
        rules?: string;
        moat?: string;
        smeSoul?: string;
        coderSoul?: string;
        goals?: string;
      };
      project.description = String(body.description ?? project.description);
      project.businessPlan = String(body.businessPlan ?? project.businessPlan);
      project.rules = String(body.rules ?? project.rules);
      project.moat = String(body.moat ?? project.moat);
      project.smeSoul = String(body.smeSoul ?? project.smeSoul);
      project.coderSoul = String(body.coderSoul ?? project.coderSoul);
      if (typeof body.goals === "string")
        project.goals = body.goals
          .split("\n")
          .map((g) => g.trim())
          .filter(Boolean);
      await store.writeProject(project);
      return Response.json({
        project,
        smePersona: smePersona(project),
        coderPersona: coderPersona(project),
      });
    }
    const devConfig = url.pathname.match(/^\/api\/projects\/([^/]+)\/dev-config$/);
    if (devConfig && req.method === "POST") {
      const project = await store.readProject(devConfig[1] ?? "");
      if (!project)
        return Response.json(
          {
            error: "project not found or offline",
          },
          {
            status: 404,
          },
        );
      const body = (await req.json().catch(() => ({}))) as {
        devCommand?: string;
        devPort?: number;
        testMode?: string;
      };
      project.devCommand = String(body.devCommand ?? "").trim();
      project.devPort = Math.max(0, Math.min(65535, Number(body.devPort ?? 0) || 0));
      if (
        [
          "dev",
          "checks",
          "push-only",
        ].includes(String(body.testMode))
      )
        project.testMode = String(body.testMode) as typeof project.testMode;
      await store.writeProject(project);
      return Response.json({
        project,
      });
    }
    const devAction = url.pathname.match(/^\/api\/projects\/([^/]+)\/dev(?:\/(start|stop))?$/);
    if (devAction) {
      const id = devAction[1] ?? "";
      const project = await store.readProject(id);
      if (!project)
        return Response.json(
          {
            error: "project not found or offline",
          },
          {
            status: 404,
          },
        );
      if (req.method === "GET" && !devAction[2]) {
        const d = devProcs.get(id);
        return Response.json({
          ...devStatus(id),
          log: d?.log.slice(-80) ?? [],
        });
      }
      if (req.method === "POST" && devAction[2] === "start") {
        if (devStatus(id).running)
          return Response.json({
            status: "already-running",
            ...devStatus(id),
          });
        if (!project.devCommand)
          return Response.json(
            {
              error: "no dev command configured for this project",
            },
            {
              status: 400,
            },
          );
        const port = project.devPort || 3000;
        const proc = Bun.spawn(
          [
            "bash",
            "-lc",
            project.devCommand,
          ],
          {
            cwd: project.repoPath,
            env: {
              ...process.env,
              PORT: String(port),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const entry: DevProc = {
          proc,
          since: new Date().toISOString(),
          port,
          log: [
            `$ ${project.devCommand} (cwd ${project.repoPath}, PORT=${port})`,
          ],
          exited: false,
        };
        devProcs.set(id, entry);
        pumpLog(entry, proc.stdout as ReadableStream<Uint8Array>);
        pumpLog(entry, proc.stderr as ReadableStream<Uint8Array>);
        void proc.exited.then((code) => {
          entry.exited = true;
          entry.log.push(`[dev process exited with code ${code}]`);
        });
        return Response.json({
          status: "started",
          ...devStatus(id),
        });
      }
      if (req.method === "POST" && devAction[2] === "stop") {
        const d = devProcs.get(id);
        if (d && !d.exited) d.proc.kill();
        return Response.json({
          status: "stopped",
        });
      }
    }
    const sync = url.pathname.match(/^\/api\/projects\/([^/]+)\/sync$/);
    if (sync && req.method === "POST") {
      try {
        const project = await store.syncProjectCommit(sync[1] ?? "", new Date().toISOString());
        return Response.json({
          status: "synced",
          project,
        });
      } catch (err) {
        return Response.json(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          {
            status: 400,
          },
        );
      }
    }
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return Response.json({
        port,
        dataDir,
        maxParallelTasks,
        ramFloorMb,
        dispatchEnabled,
        defaultLane,
        approvalMode,
        stationRoutes: getStationRoutes(),
        presets: getPresets(),
        activePresetId: getActivePresetId(),
        providerHealth: Object.fromEntries(
          await Promise.all(
            PROVIDER_IDS.map(async (id) => [
              id,
              await store.providerHealth(id).catch(() => null),
            ]),
          ),
        ),
        suggestedPresets: suggestedPresets(installedProviders),
        providers: providerCatalogue(),
        smeSoul: getGlobalSouls().sme,
        coderSoul: getGlobalSouls().coder,
        agentCommand: agentCommand ?? null, // null = built-in Muse station command
        authConfigured: !!(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS),
        webhookUrl: process.env.DASHBOARD_WEBHOOK_URL ?? null, // null = no needs-input escalation
      });
    }
    if (url.pathname === "/api/capacity" && req.method === "GET") {
      const tasks = await store.listTasks();
      const running = runningCount(tasks, activePipelines);
      const queued = queuedTasks(tasks).length;
      return Response.json({
        running,
        maxParallelTasks,
        queued,
        planning: planRuns.size,
        freeRamMb: freeRamMb(),
        ramFloorMb,
        ramAdvice: ramAdvice(ramSamples, maxParallelTasks, {
          running,
          queued,
          planning: planRuns.size,
        }),
      });
    }
    if (url.pathname === "/api/settings" && req.method === "POST") {
      // Every field is optional and validated independently; valid ones
      // apply live and persist, the first invalid one names itself.
      const body = (await req.json().catch(() => ({}))) as FactorySettings;
      const patch: FactorySettings = {};
      if (body.maxParallelTasks !== undefined) {
        const next = Math.floor(Number(body.maxParallelTasks));
        if (!Number.isFinite(next) || next < 1 || next > 32)
          return Response.json(
            {
              error: "maxParallelTasks must be an integer between 1 and 32",
            },
            {
              status: 400,
            },
          );
        maxParallelTasks = next;
        patch.maxParallelTasks = next;
        const projects = await store.listProjects().catch(() => []);
        for (const project of projects) {
          if (project.lastCommit) {
            try {
              ensureWarmWorktrees(
                project.repoPath,
                project.id,
                maxParallelTasks,
                project.lastCommit,
              );
            } catch {
              /* pool grows on demand too */
            }
          }
        }
      }
      if (body.ramFloorMb !== undefined) {
        const next = Math.floor(Number(body.ramFloorMb));
        if (!Number.isFinite(next) || next < 0 || next > 65536)
          return Response.json(
            {
              error: "ramFloorMb must be an integer between 0 and 65536",
            },
            {
              status: 400,
            },
          );
        ramFloorMb = next;
        patch.ramFloorMb = next;
      }
      if (body.dispatchEnabled !== undefined) {
        dispatchEnabled = body.dispatchEnabled === true;
        patch.dispatchEnabled = dispatchEnabled;
      }
      if (body.defaultLane !== undefined) {
        const lane = String(body.defaultLane);
        if (
          ![
            "",
            "fast",
            "standard",
            "careful",
          ].includes(lane)
        )
          return Response.json(
            {
              error: "defaultLane must be fast, standard, careful or empty (triage decides)",
            },
            {
              status: 400,
            },
          );
        defaultLane = lane;
        patch.defaultLane = lane;
      }
      if (body.approvalMode !== undefined) {
        const mode = String(body.approvalMode);
        if (
          ![
            "auto",
            "click",
          ].includes(mode)
        )
          return Response.json(
            {
              error: "approvalMode must be auto or click",
            },
            {
              status: 400,
            },
          );
        approvalMode = mode;
        patch.approvalMode = mode;
      }
      if (body.stationRoutes !== undefined) {
        const before = JSON.stringify(getStationRoutes());
        setStationRoutes(body.stationRoutes as Parameters<typeof setStationRoutes>[0]);
        patch.stationRoutes = getStationRoutes();
        if (
          JSON.stringify(getStationRoutes()) === before &&
          JSON.stringify(body.stationRoutes) !== "{}"
        ) {
          // setStationRoutes silently drops unknown models/efforts; if
          // nothing changed at all, the owner sent something invalid.
          const sent = Object.values(body.stationRoutes)[0] as
            | {
                provider?: string;
                model?: string;
                effort?: string;
              }
            | undefined;
          if (
            sent &&
            sent.model &&
            (!sent.provider || sent.provider === "muse") &&
            ![
              "muse-wonder-1.0",
              "muse-spark-1.3",
            ].includes(sent.model)
          )
            return Response.json(
              {
                error: `unknown muse model ${sent.model} — use muse-wonder-1.0 or muse-spark-1.3`,
              },
              {
                status: 400,
              },
            );
        }
      }
      if (body.presets !== undefined) {
        setPresets(body.presets, body.activePresetId);
        patch.presets = getPresets();
        patch.activePresetId = getActivePresetId();
      } else if (body.activePresetId !== undefined) {
        if (!setActivePreset(String(body.activePresetId)))
          return Response.json(
            {
              error: "unknown preset",
            },
            {
              status: 400,
            },
          );
        patch.activePresetId = getActivePresetId();
      }
      if (body.smeSoul !== undefined || body.coderSoul !== undefined) {
        const souls = {
          sme: body.smeSoul !== undefined ? String(body.smeSoul) : getGlobalSouls().sme,
          coder: body.coderSoul !== undefined ? String(body.coderSoul) : getGlobalSouls().coder,
        };
        setGlobalSouls(souls);
        patch.smeSoul = souls.sme;
        patch.coderSoul = souls.coder;
      }
      writeSettings(patch);
      return Response.json({
        status: "saved",
        maxParallelTasks,
        ramFloorMb,
        dispatchEnabled,
        defaultLane,
        stationRoutes: getStationRoutes(),
        presets: getPresets(),
        activePresetId: getActivePresetId(),
      });
    }
    if (url.pathname === "/api/tasks" && req.method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const tasks = await store.listTasks(projectId);
      // The Inbox must show the actual question and its context without
      // opening the task: for anything that can wait on the owner, attach
      // the latest non-owner note, the last few feed entries, and the
      // files the worker has touched.
      const enriched = await Promise.all(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
        tasks.map(async (t) => {
          const live = activeStationFor(t.jobId);
          const base = {
            ...t,
            planning: planRuns.has(t.id),
            liveActor: live?.role ?? null,
            liveLast: live ? lastStationLine(live.stationId) : null,
          };
          const mayWait =
            t.state === "needs-input" ||
            t.state === "blocked" ||
            t.state === "failed" ||
            (t.planQuestions?.length ?? 0) > 0;
          const retroInfo =
            (t.state === "done" || t.state === "failed") && !t.retroReviewedAt
              ? await store.readRetro(t.id).catch(() => null)
              : null;
          const withRetro =
            retroInfo && !retroInfo.error
              ? {
                  ...base,
                  retroFindings: retroInfo.findings.slice(0, 6),
                  retroAt: retroInfo.at,
                  retroSummary: retroInfo.text.split(/\n\s*\n/)[0]?.slice(0, 900) ?? "",
                }
              : base;
          if (!mayWait) return withRetro;
          const prompts = await store.listPrompts(t.id).catch(() => []);
          const lastNote = [
            ...prompts,
          ]
            .reverse()
            .find((p) => p.kind !== "user");
          return {
            ...withRetro,
            waitingQuestion: lastNote ? lastNote.text.slice(0, 1500) : null,
            waitingContext: prompts.slice(-4).map((p) => ({
              kind: p.kind,
              at: p.at,
              text: p.text.slice(0, 500),
            })),
            activity: worktreeActivity(t).slice(0, 6),
          };
        }),
      );
      return Response.json({
        tasks: enriched,
      });
    }
    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        projectId?: string;
        prompt?: string;
        taskType?: string;
        tags?: string | string[];
        verifyCommand?: string;
        allowDuplicate?: boolean;
      };
      const prompt = String(body.prompt ?? "").trim();
      const projectId = String(body.projectId ?? "").trim();
      if (!projectId || !prompt)
        return Response.json(
          {
            error: "projectId and prompt required",
          },
          {
            status: 400,
          },
        );
      if (!body.allowDuplicate) {
        const existing = await store.listTasks(projectId).catch(() => []);
        const dup = findDuplicateTask(existing, projectId, prompt);
        if (dup)
          return Response.json(
            {
              error: `duplicate of an active task (${dup.id}): ${dup.title}`,
              duplicateOf: dup.id,
            },
            {
              status: 409,
            },
          );
      }
      const verdict = clarificationGate(prompt);
      if (verdict.decision === "ask")
        return Response.json(
          {
            status: "clarification-needed",
            reasons: verdict.reasons,
          },
          {
            status: 422,
          },
        );
      const now = new Date().toISOString();
      const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags ?? "").split(","))
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean);
      const taskTypes = [
        "general",
        "security",
        "ui",
        "css",
        "backend",
        "docs",
      ];
      const base = newTask(
        {
          id: `task-${Date.now()}`,
          projectId,
          title: deriveTitle(prompt),
          prompt,
        },
        now,
      );
      // Planning starts from the very beginning: a stated task queues its
      // plan automatically, no "generate plan" click needed. A failed
      // planning run clears the flag (see launchPlan); sweepAutoPlan
      // re-queues it after a backoff instead of looping endlessly.
      // No verify command stated: inherit the one derived from the
      // project's CI analysis instead of leaving the builder to
      // discover (and fail on) it later.
      const statedVerify = String(body.verifyCommand ?? "").trim();
      let inheritedVerify = "";
      if (!statedVerify) {
        const proj = await store.readProject(projectId).catch(() => null);
        if (proj?.repoPath) inheritedVerify = analyzeCi(proj.repoPath).suggestedVerify;
      }
      const task = {
        ...base,
        planRequested: true,
        tags,
        taskType: (taskTypes.includes(String(body.taskType))
          ? String(body.taskType)
          : "general") as typeof base.taskType,
        verifyCommand: statedVerify || inheritedVerify,
        ...(defaultLane
          ? {
              lane: defaultLane as typeof base.lane,
              triage: `default lane from Settings: ${defaultLane}`,
            }
          : {}),
      };
      await store.writeTask(task);
      await store
        .appendPrompt(task.id, {
          at: now,
          kind: "user",
          text: prompt,
        })
        .catch(() => {});
      return Response.json({
        status: "planned",
        task,
      });
    }
    const artifactFile = url.pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/(.+)$/);
    if (artifactFile && req.method === "GET") {
      const forTask = await store.readTask(artifactFile[1] ?? "");
      const name = decodeURIComponent(artifactFile[2] ?? "");
      if (!forTask || name.includes("/") || name.includes(".."))
        return new Response("not found", {
          status: 404,
        });
      const file = Bun.file(store.artifactPath(forTask, name));
      if (!(await file.exists()))
        return new Response("not found", {
          status: 404,
        });
      return new Response(file, {
        headers: {
          "content-type": name.endsWith(".webm") ? "video/webm" : "video/mp4",
        },
      });
    }
    const visualFile = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/visual\/(baseline|after|diff)\/(.+)$/,
    );
    if (visualFile && req.method === "GET") {
      const forTask = await store.readTask(visualFile[1] ?? "");
      const name = decodeURIComponent(visualFile[3] ?? "");
      if (!forTask || name.includes("/") || name.includes(".."))
        return new Response("not found", {
          status: 404,
        });
      const file = Bun.file(store.visualFilePath(forTask.id, visualFile[2] ?? "after", name));
      if (!(await file.exists()))
        return new Response("not found", {
          status: 404,
        });
      return new Response(file, {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
        },
      });
    }
    const taskAction = url.pathname.match(
      /^\/api\/tasks\/([^/]+)(?:\/(plan|approve|prompts|transition|diff|generate-plan|answer|plan-comments|verify-command|drafts|retro|retro-comments|retro-reviewed|lane|rollback|visual-approve|visual-request-changes))?$/,
    );
    if (taskAction) {
      const taskId = taskAction[1] ?? "";
      const action = taskAction[2];
      if (req.method === "DELETE" && !action) {
        // Hoisted before the shared readTask: markers are acquired
        // synchronously, before any await in this branch.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId))
          return Response.json(
            {
              error: "invalid task id",
            },
            {
              status: 400,
            },
          );
        const wasDeleting = deletingTasks.has(taskId);
        const wasActive = activePipelines.has(taskId);
        if (wasDeleting)
          return Response.json(
            {
              error: "task deletion already in progress",
            },
            {
              status: 409,
            },
          );
        deletingTasks.add(taskId);
        const acquiredDeleting = true;
        const acquiredActive = !wasActive;
        if (acquiredActive) activePipelines.add(taskId);
        try {
          const origin = req.headers.get("origin");
          if (origin && origin !== url.origin)
            return Response.json(
              {
                error: "cross-origin delete refused",
              },
              {
                status: 403,
              },
            );
          const task = await store.readTask(taskId);
          if (!task)
            return Response.json(
              {
                error: "task not found",
              },
              {
                status: 404,
              },
            );
          if (
            task.state === "running" ||
            task.state === "in-review" ||
            wasActive ||
            planRuns.has(taskId) ||
            retroRuns.has(taskId) ||
            activeStationFor(task.jobId)
          ) {
            return Response.json(
              {
                error:
                  "feature is active right now — stop its station or wait for planning/retro to finish before removing it",
              },
              {
                status: 409,
              },
            );
          }
          try {
            const result = await store.deleteTask(taskId);
            if (!result)
              return Response.json(
                {
                  error: "task not found",
                },
                {
                  status: 404,
                },
              );
            if (!result.centralRemoved)
              return Response.json(
                {
                  error: "delete incomplete; task retained so you can retry",
                  id: result.id,
                  removed: result.removed,
                  skipped: result.skipped,
                },
                {
                  status: 500,
                },
              );
            return Response.json({
              status: "deleted",
              deleted: result.id,
              id: result.id,
              removed: result.removed,
              skipped: result.skipped,
              partial: result.skipped.length > 0,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("invalid id"))
              return Response.json(
                {
                  error: "invalid task id",
                },
                {
                  status: 400,
                },
              );
            if (msg.includes("deletion in progress"))
              return Response.json(
                {
                  error: "task deletion already in progress",
                },
                {
                  status: 409,
                },
              );
            throw e;
          }
        } finally {
          if (acquiredDeleting) deletingTasks.delete(taskId);
          if (acquiredActive) activePipelines.delete(taskId);
        }
      }
      const task = await store.readTask(taskId);
      if (!task)
        return Response.json(
          {
            error: "task not found",
          },
          {
            status: 404,
          },
        );
      if (req.method === "POST" && deletingTasks.has(taskId))
        return Response.json(
          {
            error: "task deletion in progress",
          },
          {
            status: 409,
          },
        );
      if (req.method === "GET" && !action) {
        const [prompts, cards, deliveries, planArtifact, artifacts, similar] = await Promise.all([
          store.listPrompts(taskId),
          store.listCards(task.jobId),
          store.listDeliveries(task.jobId),
          store.readPlanArtifact(task),
          store.listArtifacts(task),
          store.similarTasks(task.projectId, task.tags),
        ]);
        const retro = await store.readRetro(taskId).catch(() => null);
        const visual = await store.readVisualReview(taskId).catch(() => null);
        return Response.json({
          visual,
          task,
          prompts,
          stations: cards.map((c) => ({
            card: c,
            delivery: deliveries.find((d) => d.stationId === c.id) ?? null,
          })),
          planArtifact,
          artifacts,
          similar,
          activity: worktreeActivity(task),
          planning: planRuns.has(taskId),
          planningSince: planRuns.get(taskId) ?? null,
          retro,
          retroRunning: retroRuns.has(taskId),
          live: activeStationFor(task.jobId),
        });
      }
      if (req.method === "POST" && action === "retro") {
        // Retrospective runs automatically when a task finishes or fails
        // (see the sweep in dispatchNow); this forces a fresh one. Async —
        // the UI polls the task detail.
        if (retroRuns.has(taskId))
          return Response.json(
            {
              status: "retro-running",
            },
            {
              status: 202,
            },
          );
        retroRuns.add(taskId);
        void runRetro(taskId, {
          store,
          command: agentCommand,
          maxParallelTasks,
        })
          .catch(async (err) => {
            await store
              .writeRetro(taskId, {
                text: "",
                findings: [],
                at: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
              })
              .catch(() => {});
          })
          .finally(() => retroRuns.delete(taskId));
        return Response.json(
          {
            status: "retro-running",
          },
          {
            status: 202,
          },
        );
      }
      if (req.method === "POST" && action === "retro-reviewed") {
        // The owner reviewed the retro (or chose to close without it):
        // the feature leaves Retro review and is Closed.
        const next = {
          ...task,
          retroReviewedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await store.writeTask(next);
        await store
          .appendPrompt(taskId, {
            at: new Date().toISOString(),
            kind: "user",
            text: "retro reviewed — feature closed by the owner",
          })
          .catch(() => {});
        return Response.json({
          task: next,
        });
      }
      if (req.method === "POST" && action === "retro-comments") {
        const body = (await req.json().catch(() => ({}))) as {
          comments?: {
            finding?: string;
            comment?: string;
          }[];
        };
        const comments = (body.comments ?? [])
          .map((c) => ({
            finding: String(c.finding ?? ""),
            comment: String(c.comment ?? "").trim(),
          }))
          .filter((c) => c.comment);
        if (!comments.length)
          return Response.json(
            {
              error: "comments required",
            },
            {
              status: 400,
            },
          );
        if (retroRuns.has(taskId))
          return Response.json(
            {
              status: "retro-running",
            },
            {
              status: 202,
            },
          );
        retroRuns.add(taskId);
        void runRetroFollowup(taskId, comments, {
          store,
          command: agentCommand,
          maxParallelTasks,
        })
          .catch(async (err) => {
            await store
              .appendPrompt(taskId, {
                at: new Date().toISOString(),
                kind: "system",
                text: `retro follow-up failed: ${err instanceof Error ? err.message : String(err)}`,
              })
              .catch(() => {});
          })
          .finally(() => retroRuns.delete(taskId));
        return Response.json(
          {
            status: "retro-running",
          },
          {
            status: 202,
          },
        );
      }
      if (req.method === "POST" && action === "lane") {
        // Owner override of the triage lane: sovereignty over ceremony.
        // Setting it before planning skips triage entirely; setting it
        // later changes how the remaining stages treat the task.
        const body = (await req.json().catch(() => ({}))) as {
          lane?: string;
        };
        const lane = String(body.lane ?? "");
        if (
          ![
            "fast",
            "standard",
            "careful",
          ].includes(lane)
        )
          return Response.json(
            {
              error: "lane must be fast, standard or careful",
            },
            {
              status: 400,
            },
          );
        const next = {
          ...task,
          lane: lane as typeof task.lane,
          triage: task.triage
            ? `${task.triage} | lane set by owner: ${lane}`
            : `lane set by owner: ${lane}`,
          updatedAt: new Date().toISOString(),
        };
        await store.writeTask(next);
        await store
          .appendPrompt(taskId, {
            at: new Date().toISOString(),
            kind: "user",
            text: `lane override: ${lane} (set by the owner)`,
          })
          .catch(() => {});
        return Response.json({
          task: next,
        });
      }
      if (req.method === "POST" && action === "generate-plan") {
        // Queue the plan request: the dispatcher launches it ahead of
        // implementation work when a parallel slot is free, and it stays
        // queued (planRequested) until then. Async either way — planning
        // runs three agent stations and can take minutes. The UI polls
        // the task; stage progress lands in its history.
        if (planRuns.has(taskId))
          return Response.json(
            {
              status: "planning",
              planningSince: planRuns.get(taskId),
            },
            {
              status: 202,
            },
          );
        if (!task.planRequested)
          await store.writeTask({
            ...task,
            planRequested: true,
            updatedAt: new Date().toISOString(),
          });
        dispatchNow();
        return Response.json(
          {
            status: planRuns.has(taskId) ? "planning" : "queued",
            planningSince: planRuns.get(taskId) ?? null,
          },
          {
            status: 202,
          },
        );
      }
      if (req.method === "POST" && action === "answer") {
        // The owner decides the red-team points the planner left open; the
        // planner then updates the plan. Async like generate-plan.
        const body = (await req.json().catch(() => ({}))) as {
          text?: string;
        };
        const text = String(body.text ?? "").trim();
        if (!text)
          return Response.json(
            {
              error: "text required",
            },
            {
              status: 400,
            },
          );
        if (!task.planQuestions.length)
          return Response.json(
            {
              error: "no open plan questions",
            },
            {
              status: 400,
            },
          );
        if (planRuns.has(taskId))
          return Response.json(
            {
              status: "planning",
              planningSince: planRuns.get(taskId),
            },
            {
              status: 202,
            },
          );
        const startedAt = new Date().toISOString();
        planRuns.set(taskId, startedAt);
        void answerPlanQuestions(taskId, text, {
          store,
          command: agentCommand,
          maxParallelTasks,
        })
          .catch(async (err) => {
            await store
              .appendPrompt(taskId, {
                at: new Date().toISOString(),
                kind: "system",
                text: `plan update failed: ${err instanceof Error ? err.message : String(err)}`,
              })
              .catch(() => {});
          })
          .finally(() => planRuns.delete(taskId));
        return Response.json(
          {
            status: "planning",
            planningSince: startedAt,
          },
          {
            status: 202,
          },
        );
      }
      if (req.method === "POST" && action === "plan-comments") {
        // Per-line owner comments on the plan (and prompt): the planner
        // revises the plan against them. Async like generate-plan/answer.
        const body = (await req.json().catch(() => ({}))) as {
          comments?: Array<{
            line?: number;
            text?: string;
            comment?: string;
          }>;
        };
        const comments = (Array.isArray(body.comments) ? body.comments : [])
          .map((c) => ({
            line: Number(c.line ?? 0),
            text: String(c.text ?? ""),
            comment: String(c.comment ?? "").trim(),
          }))
          .filter((c) => c.comment);
        if (!comments.length)
          return Response.json(
            {
              error: "no comments",
            },
            {
              status: 400,
            },
          );
        if (!task.plan.trim())
          return Response.json(
            {
              error: "no plan to comment on yet",
            },
            {
              status: 400,
            },
          );
        if (planRuns.has(taskId))
          return Response.json(
            {
              status: "planning",
              planningSince: planRuns.get(taskId),
            },
            {
              status: 202,
            },
          );
        const text = comments
          .map((c) => `Line ${c.line}: "${c.text}"\nOwner comment: ${c.comment}`)
          .join("\n\n");
        const startedAt = new Date().toISOString();
        planRuns.set(taskId, startedAt);
        void commentOnPlan(taskId, text, {
          store,
          command: agentCommand,
          maxParallelTasks,
        })
          .catch(async (err) => {
            await store
              .appendPrompt(taskId, {
                at: new Date().toISOString(),
                kind: "system",
                text: `plan comment update failed: ${err instanceof Error ? err.message : String(err)}`,
              })
              .catch(() => {});
          })
          .finally(() => planRuns.delete(taskId));
        return Response.json(
          {
            status: "planning",
            planningSince: startedAt,
          },
          {
            status: 202,
          },
        );
      }
      if (action === "drafts" && req.method === "GET") {
        return Response.json({
          drafts: await store.listDrafts(taskId),
        });
      }
      if (action === "drafts" && req.method === "POST") {
        // Unsent user input (answer, reply, line comments) is saved as
        // typed, so a browser or app crash never loses a response.
        const body = (await req.json().catch(() => ({}))) as {
          field?: string;
          text?: string;
        };
        const field = String(body.field ?? "").trim();
        if (!field)
          return Response.json(
            {
              error: "field is required",
            },
            {
              status: 400,
            },
          );
        await store.saveDraft(taskId, field, String(body.text ?? ""));
        return Response.json({
          status: "saved",
        });
      }
      if (req.method === "POST" && action === "verify-command") {
        const body = (await req.json().catch(() => ({}))) as {
          verifyCommand?: string;
        };
        const verifyCommand = String(body.verifyCommand ?? "").trim();
        await store.writeTask({
          ...task,
          verifyCommand,
          updatedAt: new Date().toISOString(),
        });
        return Response.json({
          status: "saved",
          verifyCommand,
        });
      }
      if (req.method === "GET" && action === "diff")
        return Response.json({
          diff: taskDiff(task),
        });
      if (req.method === "POST" && action === "plan") {
        const body = (await req.json().catch(() => ({}))) as {
          plan?: string;
        };
        try {
          const next = draftPlan(task, String(body.plan ?? ""), new Date().toISOString());
          await store.writeTask(next);
          return Response.json({
            task: next,
          });
        } catch (err) {
          return Response.json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            {
              status: 400,
            },
          );
        }
      }
      if (req.method === "POST" && action === "approve") {
        try {
          const next = approvePlan(task, new Date().toISOString());
          await store.writeTask(next);
          return Response.json({
            task: next,
          });
        } catch (err) {
          // Idempotent: the auto-approve tick may have approved this
          // draft first (Settings default) — that is the same outcome
          // the owner asked for, not an error.
          const fresh = await store.readTask(taskId).catch(() => null);
          if (fresh?.planState === "approved")
            return Response.json({
              task: fresh,
            });
          return Response.json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            {
              status: 400,
            },
          );
        }
      }
      if (req.method === "POST" && action === "prompts") {
        const body = (await req.json().catch(() => ({}))) as {
          text?: string;
        };
        const text = String(body.text ?? "").trim();
        if (!text)
          return Response.json(
            {
              error: "text required",
            },
            {
              status: 400,
            },
          );
        try {
          await store.appendPrompt(taskId, {
            at: new Date().toISOString(),
            kind: "user",
            text,
          });
        } catch (err) {
          return Response.json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            {
              status: 400,
            },
          );
        }
        // Answering a blocked agent resumes its own station/session. A
        // reply while a decisions-file merge waits counts as the owner
        // seeing it: accept for that main HEAD (or act on the instruction).
        if (task.state === "needs-input" && task.decisionsPendingHead) {
          await store.writeTask({
            ...task,
            decisionsAckHead: task.decisionsPendingHead,
            decisionsPendingHead: "",
          });
        }
        if (task.state === "needs-input") {
          await store.moveTask(taskId, "running", new Date().toISOString());
          launchPipeline(taskId);
        }
        return Response.json({
          status: "recorded",
        });
      }
      if (req.method === "POST" && action === "transition") {
        const body = (await req.json().catch(() => ({}))) as {
          to?: string;
        };
        try {
          const next = await store.moveTask(
            taskId,
            String(body.to ?? "") as TaskState,
            new Date().toISOString(),
          );
          return Response.json({
            task: next,
          });
        } catch (err) {
          return Response.json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            {
              status: 400,
            },
          );
        }
      }
      if (
        req.method === "POST" &&
        (action === "visual-approve" || action === "visual-request-changes")
      ) {
        const review = await store.readVisualReview(taskId).catch(() => null);
        if (!review)
          return Response.json(
            {
              error: "no visual review for this task",
            },
            {
              status: 404,
            },
          );
        const body = (await req.json().catch(() => ({}))) as {
          comments?: {
            shot?: string;
            comment?: string;
          }[];
          comment?: string;
        };
        const comments = [
          ...(Array.isArray(body.comments) ? body.comments : [])
            .map((c) => ({
              shot: String(c.shot ?? ""),
              comment: String(c.comment ?? "").trim(),
            }))
            .filter((c) => c.comment),
          ...(String(body.comment ?? "").trim()
            ? [
                {
                  shot: "",
                  comment: String(body.comment).trim(),
                },
              ]
            : []),
        ];
        const nowIso = new Date().toISOString();
        if (action === "visual-approve") {
          if (
            review.status !== "pending" &&
            task.visualState !== "pending" &&
            task.visualState !== "error"
          )
            return Response.json(
              {
                error: "visual review is not waiting for approval",
              },
              {
                status: 409,
              },
            );
          const hashes = changedShots(review)
            .map((s) => s.afterHash)
            .filter(Boolean);
          const next = {
            ...task,
            visualState: "approved" as const,
            visualApprovedHashes: [
              ...new Set([
                ...(task.visualApprovedHashes ?? []),
                ...hashes,
              ]),
            ],
            updatedAt: nowIso,
          };
          await store.writeVisualReview(taskId, {
            ...review,
            status: "approved",
            at: nowIso,
          });
          await store.writeTask(next);
          await store
            .appendPrompt(taskId, {
              at: nowIso,
              kind: "user",
              text: "visual review approved by the owner — land this work",
            })
            .catch(() => {});
          if (task.state === "needs-input" || task.state === "in-review") {
            await store.moveTask(taskId, "running", nowIso);
            launchPipeline(taskId);
          }
          return Response.json({
            status: "approved",
            task: next,
          });
        }
        if (!comments.length)
          return Response.json(
            {
              error:
                "comments required: say what must change, per screenshot or for the whole review",
            },
            {
              status: 400,
            },
          );
        const noted = comments.map((c) => ({
          ...c,
          at: nowIso,
        }));
        await store.writeVisualReview(taskId, {
          ...review,
          status: "changes-requested",
          at: nowIso,
          comments: [
            ...review.comments,
            ...noted,
          ],
        });
        const next = {
          ...task,
          visualState: "changes-requested" as const,
          updatedAt: nowIso,
        };
        await store.writeTask(next);
        const text = `visual review — changes requested by the owner:\n${comments.map((c) => `- ${c.shot ? `[${c.shot}] ` : ""}${c.comment}`).join("\n")}\nFix these screenshots (route/moment names refer to visual.moments.json), re-verify, and finish; Visual Review will re-capture and diff again.`;
        await store
          .appendPrompt(taskId, {
            at: nowIso,
            kind: "user",
            text,
          })
          .catch(() => {});
        if (task.state === "needs-input" || task.state === "in-review") {
          await store.moveTask(taskId, "running", nowIso);
          launchPipeline(taskId);
        }
        return Response.json({
          status: "changes-requested",
          task: next,
        });
      }
      if (action === "rollback" && req.method === "GET") {
        // Eligibility for the Rollback button: enabled when revertible,
        // disabled with the reason when not.
        const project = await store.readProject(task.projectId).catch(() => null);
        if (!project?.repoPath)
          return Response.json({
            eligible: false,
            reason: "project has no local repo path — revert the merge manually",
            mergeCommit: "",
          });
        return Response.json(rollbackEligibility(project.repoPath, task));
      }
      if (action === "rollback" && req.method === "POST") {
        if (rollingBack.has(taskId))
          return Response.json(
            {
              error: "rollback already in progress",
            },
            {
              status: 409,
            },
          );
        rollingBack.add(taskId);
        try {
          const result = await rollbackTask(store, taskId);
          return Response.json({
            status: result.status,
            task: result.task,
            mergeCommit: result.mergeCommit,
            revertCommit: result.revertCommit,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json(
            {
              error: msg,
            },
            {
              status: msg.includes("revert conflict") ? 409 : 400,
            },
          );
        } finally {
          rollingBack.delete(taskId);
        }
      }
    }
    const featureAction = url.pathname.match(/^\/api\/projects\/([^/]+)\/features(?:\/([^/]+))?$/);
    if (featureAction && req.method === "POST") {
      const project = await store.readProject(featureAction[1] ?? "");
      if (!project)
        return Response.json(
          {
            error: "project not found or offline",
          },
          {
            status: 404,
          },
        );
      const body = (await req.json().catch(() => ({}))) as {
        title?: string;
        state?: string;
      };
      if (!featureAction[2]) {
        const title = String(body.title ?? "").trim();
        if (!title)
          return Response.json(
            {
              error: "title required",
            },
            {
              status: 400,
            },
          );
        project.features.push({
          id: `f-${Date.now()}`,
          title,
          state: "planned",
          notes: "",
        });
      } else {
        const feature = project.features.find((f) => f.id === featureAction[2]);
        if (!feature)
          return Response.json(
            {
              error: "feature not found",
            },
            {
              status: 404,
            },
          );
        if (
          ![
            "planned",
            "in-progress",
            "implemented",
          ].includes(String(body.state))
        )
          return Response.json(
            {
              error: "invalid feature state",
            },
            {
              status: 400,
            },
          );
        feature.state = String(body.state) as typeof feature.state;
      }
      await store.writeProject(project);
      return Response.json({
        project,
      });
    }
    if (url.pathname === "/api/floor" && req.method === "GET") {
      const jobId = url.searchParams.get("job") ?? "demo";
      const [cards, deliveries] = await Promise.all([
        store.listCards(jobId),
        store.listDeliveries(jobId),
      ]);
      return Response.json({
        jobId,
        stations: cards.map((c) => ({
          card: c,
          delivery: deliveries.find((d) => d.stationId === c.id) ?? null,
        })),
      });
    }
    if (url.pathname === "/api/orders" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        order?: string;
        jobId?: string;
      };
      const order = String(body.order ?? "");
      const verdict = clarificationGate(order);
      if (verdict.decision === "ask")
        return Response.json(
          {
            status: "clarification-needed",
            reasons: verdict.reasons,
          },
          {
            status: 422,
          },
        );
      const jobId = String(body.jobId ?? `job-${Date.now()}`);
      const cards = [
        {
          id: "builder",
          jobId,
          role: "builder" as const,
          task: order,
          worktree: process.env.FACTORY_WORKTREE ?? process.cwd(),
          constraints: [],
          gates: [
            "redteam",
            "clarification",
          ],
        },
        {
          id: "qc",
          jobId,
          role: "qc" as const,
          task: `Review the builder output for: ${order}`,
          worktree: process.env.FACTORY_WORKTREE ?? process.cwd(),
          constraints: [
            "different context from builder",
          ],
          gates: [
            "redteam",
          ],
        },
      ];
      for (const c of cards) await store.writeCard(c);
      return Response.json({
        status: "queued",
        jobId,
        stations: cards.map((c) => c.id),
      });
    }
    if (url.pathname === "/api/governance/override" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        jobId?: string;
        by?: string;
        reason?: string;
      };
      if (!body.jobId || !body.reason)
        return Response.json(
          {
            error: "jobId and reason required",
          },
          {
            status: 400,
          },
        );
      await store.recordOverride(body.jobId, body.by ?? "owner", body.reason);
      return Response.json({
        status: "recorded",
      });
    }
    const cancel = url.pathname.match(/^\/api\/stations\/([^/]+)\/cancel$/);
    if (cancel && req.method === "POST") {
      // Static import on purpose: a dynamic import here can resolve a
      // second module instance whose kill registry is empty, making
      // Stop report "not-running" for a station that is live.
      return Response.json({
        status: killStation(cancel[1] ?? "") ? "killed" : "not-running",
      });
    }
    const streamRoute = url.pathname.match(/^\/api\/stations\/([^/]+)\/stream$/);
    if (streamRoute && req.method === "GET") {
      // Live station log over SSE: replay the in-memory buffer, then tail
      // until the station ends (or the viewer disconnects). Default is
      // the parsed view (`?seq=` resumes from a parsed line); `?raw=1`
      // serves the raw byte tail (`?offset=` resumes from a byte offset).
      // Stations run in this same process, so the buffer is always warm.
      const stationId = decodeURIComponent(streamRoute[1] ?? "");
      const out = stationOutput(stationId);
      if (!out)
        return Response.json(
          {
            error: "station not found — it has not run in this server generation",
          },
          {
            status: 404,
          },
        );
      const raw = url.searchParams.get("raw") === "1";
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (s: string) => {
            try {
              controller.enqueue(enc.encode(s));
            } catch {
              /* viewer gone */
            }
          };
          const close = () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          if (raw) {
            const since = Number(url.searchParams.get("offset") ?? "-1");
            const replay = out.replayRaw(since);
            if (replay.text)
              send(
                `id: ${replay.end}\ndata: ${JSON.stringify({
                  from: replay.from,
                  text: replay.text,
                })}\n\n`,
              );
            else send(`id: ${replay.end}\n\n`); // baseline offset even with nothing to replay
          } else {
            const since = Number(url.searchParams.get("seq") ?? "-1");
            for (const l of out.replayParsed(since))
              send(`id: ${l.seq}\ndata: ${JSON.stringify(l.text)}\n\n`);
          }
          if (out.done) {
            send("event: done\ndata: done\n\n");
            close();
            return;
          }
          const off = raw
            ? out.subscribeRaw((chunk, end) =>
                send(
                  `id: ${end}\ndata: ${JSON.stringify({
                    from: end - chunk.length,
                    text: chunk,
                  })}\n\n`,
                ),
              )
            : out.subscribeParsed((l) => send(`id: ${l.seq}\ndata: ${JSON.stringify(l.text)}\n\n`));
          const doneOff = out.onDone(() => {
            cleanup();
            send("event: done\ndata: done\n\n");
            close();
          });
          const hb = setInterval(() => send(": ping\n\n"), 15_000);
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            clearInterval(hb);
            off();
            doneOff();
          };
          req.signal.addEventListener("abort", () => {
            cleanup();
            close();
          });
          // Race: the station ended between the done check and subscribe.
          if (out.done) {
            cleanup();
            send("event: done\ndata: done\n\n");
            close();
          }
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        },
      });
    }
    // SPA fallback: client routes (/tasks/:id, /projects/:id, …) load the app.
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const file = Bun.file(ui);
      if (await file.exists())
        return new Response(file, {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
    }
    return new Response("not found", {
      status: 404,
    });
  },
});
console.log(
  `agent factory dashboard on http://${server.hostname}:${server.port} (data: ${dataDir})`,
);
if (
  ![
    "127.0.0.1",
    "::1",
    "localhost",
  ].includes(String(server.hostname)) &&
  !(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS)
) {
  console.warn(
    "warning: dashboard is reachable from the network with no login — set DASHBOARD_USER and DASHBOARD_PASS to gate it",
  );
}
