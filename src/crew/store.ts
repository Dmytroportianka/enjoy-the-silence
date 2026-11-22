import { Database } from "bun:sqlite";
import { execFileSync, execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type DeferredPoint, DeferredPointSchema } from "./deferred";
import { DialogueDb } from "./dialogue-db";
import { type DeliveryNote, DeliveryNoteSchema, type JobCard, JobCardSchema } from "./jobcard";
import { QUOTA_PROBE_MS } from "./preset";
import {
  healthFromOutcomes,
  isProviderId,
  type ProviderHealth,
  type ProviderId,
  type ProviderOutcome,
} from "./providers";
import {
  normalizePrompt,
  type Project,
  ProjectSchema,
  type PromptEntry,
  PromptEntrySchema,
  type Task,
  TaskSchema,
  type TaskState,
  transitionTask,
} from "./task";
import { type VisualReview, VisualReviewSchema } from "./visual";

export interface ScoutSuggestions {
  description: string;
  rules: string;
  smeSoul: string;
  coderSoul: string;
  at: string;
  error?: string;
}

// Factory state lives under one dir (default /data): task/project files
// stay plain and debuggable, while dialogue, decisions and drafts are in
// SQLite (factory.db, WAL) so a crash or restart loses nothing typed or
// said. The dashboard and orchestrator share this store; neither owns
// in-memory state.
export interface DeleteTaskResult {
  id: string;
  removed: string[];
  skipped: string[];
  centralRemoved: boolean;
}

const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class FactoryStore {
  private dialogueDb: DialogueDb | null = null;
  private deleting = new Set<string>();

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "jobs"), {
      recursive: true,
    });
  }

  /** Global quota pause: when any station hits the token limit, all
   * dispatching pauses until this instant so 24 parallel stations do
   * not keep failing against the same wall. Stored as a file so a
   * dashboard restart keeps the pause. `nextProbeAt` is when a single
   * probe task may test whether tokens are back before `until`. */
  async noteQuotaPause(untilIso: string): Promise<void> {
    const probeAt = new Date(
      Math.min(Date.parse(untilIso), Date.now() + QUOTA_PROBE_MS),
    ).toISOString();
    await Bun.write(
      join(this.dir, "quota-pause.json"),
      JSON.stringify({
        until: untilIso,
        nextProbeAt: probeAt,
      }),
    );
  }

  async quotaPausedUntil(): Promise<string> {
    return (await this.quotaPause()).until;
  }

  async quotaPause(): Promise<{
    until: string;
    nextProbeAt: string;
  }> {
    const raw = (await Bun.file(join(this.dir, "quota-pause.json"))
      .json()
      .catch(() => null)) as {
      until?: string;
      nextProbeAt?: string;
    } | null;
    return {
      until: raw?.until ?? "",
      nextProbeAt: raw?.nextProbeAt ?? "",
    };
  }

  /** Claim the next probe slot: push nextProbeAt out one interval. */
  async claimQuotaProbe(nowIso: string): Promise<void> {
    const { until } = await this.quotaPause();
    const next = new Date(Date.parse(nowIso) + QUOTA_PROBE_MS).toISOString();
    await Bun.write(
      join(this.dir, "quota-pause.json"),
      JSON.stringify({
        until,
        nextProbeAt: next,
      }),
    );
  }

  // Per-provider quota state: one subscription exhausting must not
  // pause the others. Map provider -> ISO until, in one small file.
  private async providerQuotas(): Promise<Record<string, string>> {
    const raw = await Bun.file(join(this.dir, "provider-quota.json"))
      .json()
      .catch(() => null);
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  }

  async noteProviderQuota(provider: string, untilIso: string): Promise<void> {
    const quotas = await this.providerQuotas();
    quotas[provider] = untilIso;
    await Bun.write(join(this.dir, "provider-quota.json"), JSON.stringify(quotas, null, 2));
  }

  async providerQuotaUntil(provider: string): Promise<string> {
    return (await this.providerQuotas())[provider] ?? "";
  }

  async clearProviderQuota(provider: string): Promise<void> {
    const quotas = await this.providerQuotas();
    if (!(provider in quotas)) return;
    delete quotas[provider];
    await Bun.write(join(this.dir, "provider-quota.json"), JSON.stringify(quotas, null, 2));
  }

  // Recent provider outcomes as JSONL, one append-only file per provider:
  // concurrent station appends cannot overwrite each other, and the
  // health rates Settings shows are computed from the same records.
  private providerHealthPath(provider: string): string {
    const dir = join(this.dir, "provider-health");
    mkdirSync(dir, {
      recursive: true,
    });
    return join(dir, `${provider.replace(/[^A-Za-z0-9_-]/g, "")}.jsonl`);
  }

  async appendProviderOutcome(
    provider: string,
    outcome: ProviderOutcome,
    at: string,
    presetId = "",
  ): Promise<void> {
    appendFileSync(
      this.providerHealthPath(provider),
      `${JSON.stringify({
        at,
        outcome,
        presetId,
      })}\n`,
    );
  }

  async providerHealth(provider: string, windowSize = 20): Promise<ProviderHealth> {
    const text = await Bun.file(this.providerHealthPath(provider))
      .text()
      .catch(() => "");
    const outcomes: ProviderOutcome[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          outcome?: unknown;
        };
        if (
          [
            "success",
            "failure",
            "error",
            "quota",
          ].includes(String(parsed.outcome))
        )
          outcomes.push(parsed.outcome as ProviderOutcome);
      } catch {
        // tolerate a torn last line from a killed process
      }
    }
    return healthFromOutcomes(outcomes, windowSize);
  }

  async clearQuotaPause(): Promise<void> {
    await Bun.write(
      join(this.dir, "quota-pause.json"),
      JSON.stringify({
        until: "",
        nextProbeAt: "",
      }),
    );
  }

  private dialogue(): DialogueDb {
    if (!this.dialogueDb) this.dialogueDb = new DialogueDb(join(this.dir, "factory.db"));
    return this.dialogueDb;
  }

  private jobDir(jobId: string): string {
    const d = join(this.dir, "jobs", jobId);
    mkdirSync(d, {
      recursive: true,
    });
    return d;
  }

  async writeCard(card: JobCard): Promise<void> {
    await Bun.write(
      join(this.jobDir(card.jobId), `${card.id}.card.json`),
      JSON.stringify(card, null, 2),
    );
  }

  async saveDelivery(jobId: string, note: DeliveryNote): Promise<void> {
    await Bun.write(
      join(this.jobDir(jobId), `${note.stationId}.delivery.json`),
      JSON.stringify(note, null, 2),
    );
  }

  /** Raw stored session value: "<provider>:<id>" (legacy plain ids are muse). */
  private async storedSession(jobId: string, stationId: string): Promise<string> {
    return (
      await Bun.file(join(this.jobDir(jobId), `${stationId}.session`))
        .text()
        .catch(() => "")
    ).trim();
  }

  async getSession(jobId: string, stationId: string): Promise<string | null> {
    const raw = await this.storedSession(jobId, stationId);
    if (!raw) return null;
    const sep = raw.indexOf(":");
    return sep > 0 && isProviderId(raw.slice(0, sep)) ? raw.slice(sep + 1) || null : raw;
  }

  /** Session id plus the provider that created it — resume ids never cross providers. */
  async getSessionRecord(
    jobId: string,
    stationId: string,
  ): Promise<{
    provider: ProviderId;
    id: string;
  } | null> {
    const raw = await this.storedSession(jobId, stationId);
    if (!raw) return null;
    const sep = raw.indexOf(":");
    if (sep > 0 && isProviderId(raw.slice(0, sep)))
      return {
        provider: raw.slice(0, sep) as ProviderId,
        id: raw.slice(sep + 1),
      };
    return {
      provider: "muse",
      id: raw,
    };
  }

  async setSession(
    jobId: string,
    stationId: string,
    id: string | null,
    provider?: ProviderId,
  ): Promise<void> {
    await Bun.write(
      join(this.jobDir(jobId), `${stationId}.session`),
      id ? (provider ? `${provider}:${id}` : id) : "",
    );
  }

  async listCards(jobId: string): Promise<JobCard[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.jobDir(jobId)).catch(() => [] as string[]);
    const cards: JobCard[] = [];
    for (const n of names.filter((x) => x.endsWith(".card.json"))) {
      const raw = await Bun.file(join(this.jobDir(jobId), n))
        .json()
        .catch(() => null);
      const parsed = JobCardSchema.safeParse(raw);
      if (parsed.success) cards.push(parsed.data);
    }
    return cards;
  }

  async listDeliveries(jobId: string): Promise<DeliveryNote[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.jobDir(jobId)).catch(() => [] as string[]);
    const notes: DeliveryNote[] = [];
    for (const n of names.filter((x) => x.endsWith(".delivery.json"))) {
      const raw = await Bun.file(join(this.jobDir(jobId), n))
        .json()
        .catch(() => null);
      const parsed = DeliveryNoteSchema.safeParse(raw);
      if (parsed.success) notes.push(parsed.data);
    }
    return notes;
  }

  /** Reconcile on restart: cards with no delivery are the resume queue. */
  async reconcile(jobId: string): Promise<{
    done: string[];
    pending: JobCard[];
  }> {
    const [cards, deliveries] = await Promise.all([
      this.listCards(jobId),
      this.listDeliveries(jobId),
    ]);
    const done = new Set(deliveries.filter((d) => d.status === "done").map((d) => d.stationId));
    return {
      done: [
        ...done,
      ],
      pending: cards.filter((c) => !done.has(c.id)),
    };
  }

  // --- Tasks (dashboard layer): queue state central, history per-project. ---

  private taskDir(taskId: string): string {
    const d = join(this.dir, "tasks", taskId);
    mkdirSync(d, {
      recursive: true,
    });
    return d;
  }

  async writeTask(task: Task): Promise<void> {
    const valid = TaskSchema.parse(task);
    await Bun.write(join(this.taskDir(valid.id), "task.json"), JSON.stringify(valid, null, 2));
  }

  async readTask(taskId: string): Promise<Task | null> {
    const raw = await Bun.file(join(this.dir, "tasks", taskId, "task.json"))
      .json()
      .catch(() => null);
    const parsed = TaskSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async listTasks(projectId?: string): Promise<Task[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(this.dir, "tasks")).catch(() => [] as string[]);
    const tasks: Task[] = [];
    for (const n of names) {
      const t = await this.readTask(n);
      if (t && (projectId === undefined || t.projectId === projectId)) tasks.push(t);
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * Completely erase a task. Callers must exclude live pipelines before
   * calling; `deleteTask` performs no `running`-state / `activePipelines`
   * / `planRuns` check — that guard lives only in the dashboard server.
   * Peripherals (git, project files, history) are removed before the
   * central record; an online failure aborts with centralRemoved:false
   * so a retry can finish. Offline project cleanup is reported in
   * `skipped` (full locators) and persisted to deletion-receipts.jsonl.
   * Returns null when no such task exists.
   */

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  async deleteTask(taskId: string): Promise<DeleteTaskResult | null> {
    if (!VALID_ID.test(taskId)) throw new Error(`task ${taskId}: invalid id`);
    if (this.deleting.has(taskId)) throw new Error(`task ${taskId}: deletion in progress`);
    this.deleting.add(taskId);
    try {
      const task = await this.readTask(taskId);
      if (!task) return null;
      if (task.id !== taskId) throw new Error(`task ${taskId}: invalid id`);
      const id = task.id;
      const removed: string[] = [];
      const skipped: string[] = [];
      let failed = false;
      const taskPath = join(this.dir, "tasks", id);
      try {
        if (lstatSync(taskPath).isSymbolicLink()) {
          skipped.push(`tasks/${id} (skipped: task dir is a symlink, not removed)`);
          const res: DeleteTaskResult = {
            id,
            removed,
            skipped,
            centralRemoved: false,
          };
          this.writeReceipt(res, task.projectId);
          return res;
        }
      } catch {
        /* absent: central rm below is a no-op success */
      }
      const projectId = task.projectId;
      const jobId = task.jobId;
      const branch = `task/${id}`;
      const online = VALID_ID.test(projectId) && this.isProjectOnline(projectId);
      const project = online ? await this.readProject(projectId) : null;
      const repoPath = project?.repoPath ?? "";
      // --- Git / project files / history (peripherals first) ---
      if (!online) {
        if (task.worktree)
          skipped.push(`worktree: ${task.worktree} (project ${projectId} offline, not erased)`);
        skipped.push(`branch: ${branch} (project ${projectId} offline, not erased)`);
        skipped.push(`${projectId}: data/communication/${id}.jsonl (project offline, not erased)`);
        skipped.push(`${projectId}: data/plans/${id}.md (project offline, not erased)`);
        skipped.push(`${projectId}: data/artifacts/${id}/ (project offline, not erased)`);
        skipped.push(`${projectId}: history row for ${id} (project offline, not erased)`);
      } else {
        if (repoPath) {
          const git = (args: string[], cwd = repoPath) =>
            execFileSync("git", args, {
              cwd,
              encoding: "utf8",
              timeout: 30_000,
            });
          // Warm-pool slots are shared infrastructure, not this task's
          // worktree: erase the task's changes and lease, keep the slot.
          const poolDir = join(dirname(repoPath), ".enjoy-worktrees", projectId);
          const isPoolSlot =
            !!task.worktree &&
            dirname(resolve(task.worktree)) === resolve(poolDir) &&
            /^slot-\d+$/.test(task.worktree.split(sep).pop() ?? "");
          if (task.worktree && isPoolSlot) {
            try {
              if (existsSync(task.worktree)) {
                git(
                  [
                    "reset",
                    "--hard",
                    "-q",
                    "HEAD",
                  ],
                  task.worktree,
                );
                git(
                  [
                    "clean",
                    "-fdq",
                  ],
                  task.worktree,
                );
              }
              rmSync(`${task.worktree}.lease`, {
                force: true,
              });
              rmSync(join(poolDir, "diffs", `${id}.diff`), {
                force: true,
              });
              removed.push(
                `worktree lease ${task.worktree} (warm-pool slot reset and released; slot kept for reuse)`,
              );
            } catch (e) {
              skipped.push(
                `worktree: ${task.worktree} (failed: ${e instanceof Error ? e.message : String(e)})`,
              );
              failed = true;
            }
            try {
              git([
                "show-ref",
                "--verify",
                `refs/heads/${branch}`,
              ]);
              git([
                "branch",
                "-D",
                branch,
              ]);
              removed.push(`git branch ${branch}`);
            } catch {
              removed.push(`git branch ${branch} (already absent)`);
            }
          } else {
            let listed = "";
            try {
              listed = git([
                "worktree",
                "list",
                "--porcelain",
              ]);
            } catch (e) {
              skipped.push(
                `worktree: ${task.worktree || "(none)"} (git worktree list failed: ${e instanceof Error ? e.message : String(e)})`,
              );
              failed = true;
            }
            if (!failed) {
              const registered =
                !!task.worktree &&
                listed
                  .split("\n")
                  .some(
                    (l) =>
                      l === `worktree ${task.worktree}` ||
                      l === `worktree ${resolve(task.worktree)}`,
                  );
              const expected = join(dirname(repoPath), ".enjoy-worktrees", projectId, id);
              const contained =
                !!task.worktree && (registered || resolve(task.worktree) === resolve(expected));
              if (task.worktree && existsSync(task.worktree)) {
                if (!contained) {
                  skipped.push(
                    `worktree: ${task.worktree} (skipped: outside registered/expected location, not removed)`,
                  );
                  failed = true;
                } else {
                  try {
                    git([
                      "worktree",
                      "remove",
                      "--force",
                      task.worktree,
                    ]);
                    removed.push(`worktree ${task.worktree}`);
                  } catch {
                    try {
                      rmSync(task.worktree, {
                        recursive: true,
                        force: true,
                      });
                      git([
                        "worktree",
                        "prune",
                      ]);
                      removed.push(`worktree ${task.worktree}`);
                    } catch (e) {
                      skipped.push(
                        `worktree: ${task.worktree} (failed: ${e instanceof Error ? e.message : String(e)})`,
                      );
                      failed = true;
                    }
                  }
                }
              } else if (task.worktree) removed.push(`worktree ${task.worktree} (already absent)`);
              if (!failed) {
                let branchExists = false;
                try {
                  git([
                    "show-ref",
                    "--verify",
                    `refs/heads/${branch}`,
                  ]);
                  branchExists = true;
                } catch {
                  /* absent */
                }
                if (branchExists) {
                  try {
                    git([
                      "branch",
                      "-D",
                      branch,
                    ]);
                    removed.push(`git branch ${branch}`);
                  } catch (e) {
                    skipped.push(
                      `branch: ${branch} (failed: ${e instanceof Error ? e.message : String(e)})`,
                    );
                    failed = true;
                  }
                } else removed.push(`git branch ${branch} (already absent)`);
                if (!failed && task.worktree) {
                  const after = git([
                    "worktree",
                    "list",
                    "--porcelain",
                  ]);
                  if (after.split("\n").some((l) => l === `worktree ${task.worktree}`)) {
                    skipped.push(`worktree: ${task.worktree} (still registered after removal)`);
                    failed = true;
                  }
                }
              }
            }
          }
        }
        if (!failed) {
          const dataDir = join(this.dir, "projects", projectId, "data");
          try {
            rmSync(join(dataDir, "communication", `${id}.jsonl`), {
              force: true,
            });
            removed.push(`${projectId}: data/communication/${id}.jsonl`);
            rmSync(join(dataDir, "plans", `${id}.md`), {
              force: true,
            });
            removed.push(`${projectId}: data/plans/${id}.md`);
            rmSync(join(dataDir, "artifacts", id), {
              recursive: true,
              force: true,
            });
            removed.push(`${projectId}: data/artifacts/${id}/`);
          } catch (e) {
            skipped.push(
              `${projectId}: project files for ${id} (failed: ${e instanceof Error ? e.message : String(e)})`,
            );
            failed = true;
          }
        }
        if (!failed) {
          const dbPath = join(this.dir, "projects", projectId, "data", "history.sqlite");
          if (!existsSync(dbPath))
            removed.push(`${projectId}: history row for ${id} (already absent)`);
          else {
            let db: Database | null = null;
            try {
              db = new Database(dbPath);
              const has = db
                .query("SELECT name FROM sqlite_master WHERE type='table' AND name='task_history'")
                .get();
              if (!has)
                removed.push(
                  `${projectId}: history row for ${id} (already absent: no task_history table)`,
                );
              else {
                db.query("DELETE FROM task_history WHERE task_id = ?").run(id);
                removed.push(`${projectId}: history row for ${id}`);
              }
            } catch (e) {
              skipped.push(
                `${projectId}: history row for ${id} (failed: ${e instanceof Error ? e.message : String(e)})`,
              );
              failed = true;
            } finally {
              try {
                db?.close();
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
      if (failed) {
        const res: DeleteTaskResult = {
          id,
          removed,
          skipped,
          centralRemoved: false,
        };
        if (skipped.length) this.writeReceipt(res, projectId);
        return res;
      }
      // --- Jobs: only the provably task-owned default jobId === id ---
      if (!VALID_ID.test(jobId)) skipped.push(`jobs/${jobId} (retained: invalid job id)`);
      else if (jobId === id) {
        const others = (await this.listTasks()).filter((t) => t.id !== id);
        if (others.some((t) => t.jobId === jobId))
          skipped.push(`jobs/${jobId} (retained: not solely owned by this task)`);
        else {
          rmSync(join(this.dir, "jobs", jobId), {
            recursive: true,
            force: true,
          });
          removed.push(`jobs/${jobId}/`);
        }
      } else skipped.push(`jobs/${jobId} (retained: not solely owned by this task)`);
      try {
        this.dialogue().deleteTask(id);
        removed.push(`dialogue and drafts for ${id}`);
      } catch (e) {
        skipped.push(`dialogue for ${id} (failed: ${e instanceof Error ? e.message : String(e)})`);
        const res: DeleteTaskResult = {
          id,
          removed,
          skipped,
          centralRemoved: false,
        };
        this.writeReceipt(res, projectId);
        return res;
      }
      if (skipped.length) {
        const res: DeleteTaskResult = {
          id,
          removed,
          skipped,
          centralRemoved: true,
        };
        this.writeReceipt(res, projectId);
        rmSync(taskPath, {
          recursive: true,
          force: true,
        });
        return (await this.readTask(id))
          ? {
              ...res,
              centralRemoved: false,
            }
          : res;
      }
      rmSync(taskPath, {
        recursive: true,
        force: true,
      });
      const gone = (await this.readTask(id)) === null;
      return {
        id,
        removed,
        skipped,
        centralRemoved: gone,
      };
    } finally {
      this.deleting.delete(taskId);
    }
  }

  private writeReceipt(res: DeleteTaskResult, projectId: string): void {
    try {
      appendFileSync(
        join(this.dir, "deletion-receipts.jsonl"),
        `${JSON.stringify({
          ts: new Date().toISOString(),
          id: res.id,
          projectId,
          centralRemoved: res.centralRemoved,
          removed: res.removed,
          skipped: res.skipped,
        })}\n`,
      );
    } catch (e) {
      res.skipped.push(
        `deletion-receipts.jsonl (failed: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  /** Move a task through the queue state machine and persist the result. */
  async moveTask(taskId: string, to: TaskState, now: string): Promise<Task> {
    const task = await this.readTask(taskId);
    if (!task) throw new Error(`task ${taskId}: not found`);
    const next = transitionTask(task, to, now);
    await this.writeTask(next);
    return next;
  }

  // Communication history lives in the project's own data folder:
  // <project>/data/communication/<taskId>.jsonl, reached via its symlink.
  private commPath(task: Task): string {
    return join(this.projectDataDir(task.projectId), "communication", `${task.id}.jsonl`);
  }

  /** One-time import of a task's legacy JSONL dialogue into SQLite. */
  private async ensureDialogueImported(task: Task): Promise<void> {
    const db = this.dialogue();
    if (db.hasImported(task.id)) return;
    const text = await Bun.file(this.commPath(task))
      .text()
      .catch(() => "");
    const entries: PromptEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = PromptEntrySchema.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
    }
    db.importPrompts(task.id, entries);
  }

  async appendPrompt(taskId: string, entry: PromptEntry): Promise<void> {
    const valid = PromptEntrySchema.parse(entry);
    const task = await this.readTask(taskId);
    if (!task) throw new Error(`task ${taskId}: not found`);
    if (!this.isProjectOnline(task.projectId))
      throw new Error(`project ${task.projectId}: not registered or offline`);
    await this.ensureDialogueImported(task);
    this.dialogue().appendPrompt(taskId, valid);
  }

  async listPrompts(taskId: string): Promise<PromptEntry[]> {
    const task = await this.readTask(taskId);
    if (!task || !this.isProjectOnline(task.projectId)) return [];
    await this.ensureDialogueImported(task);
    return this.dialogue().listPrompts(taskId) as PromptEntry[];
  }

  // --- Unsent UI drafts (answer / reply / line comments), crash-safe. ---

  async saveDraft(taskId: string, field: string, text: string): Promise<void> {
    this.dialogue().saveDraft(taskId, field.slice(0, 80), text.slice(0, 8000));
  }

  async listDrafts(taskId: string): Promise<Record<string, string>> {
    return this.dialogue().drafts(taskId);
  }

  // --- Plan artifacts: <project>/data/plans/<taskId>.md, next to history. ---

  async writePlanArtifact(task: Task, content: string): Promise<string> {
    if (!this.isProjectOnline(task.projectId))
      throw new Error(`project ${task.projectId}: not registered or offline`);
    const dir = join(this.projectDataDir(task.projectId), "plans");
    mkdirSync(dir, {
      recursive: true,
    });
    const path = join(dir, `${task.id}.md`);
    await Bun.write(path, content);
    return path;
  }

  async readPlanArtifact(task: Task): Promise<string> {
    if (!this.isProjectOnline(task.projectId)) return "";
    return Bun.file(join(this.projectDataDir(task.projectId), "plans", `${task.id}.md`))
      .text()
      .catch(() => "");
  }

  // --- Tag history: <project>/data/history.sqlite, one row per finished
  // task, queried by tags when planning similar new work. ---

  private historyDb(projectId: string) {
    mkdirSync(this.projectDataDir(projectId), {
      recursive: true,
    });
    const db = new Database(join(this.projectDataDir(projectId), "history.sqlite"), {
      create: true,
    });
    db.exec(
      "CREATE TABLE IF NOT EXISTS task_history (task_id TEXT, project_id TEXT, title TEXT, intent TEXT, tags TEXT, outcome TEXT, finished_at TEXT)",
    );
    return db;
  }

  async recordHistory(task: Task, outcome: string, finishedAt: string): Promise<void> {
    if (!this.isProjectOnline(task.projectId)) return;
    const db = this.historyDb(task.projectId);
    try {
      db.query("INSERT INTO task_history VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        task.id,
        task.projectId,
        task.title,
        task.prompt,
        JSON.stringify(task.tags),
        outcome,
        finishedAt,
      );
    } finally {
      db.close();
    }
  }

  async similarTasks(
    projectId: string,
    tags: string[],
    limit = 5,
  ): Promise<
    {
      taskId: string;
      title: string;
      tags: string[];
      outcome: string;
    }[]
  > {
    if (!this.isProjectOnline(projectId)) return [];
    const { existsSync: exists } = await import("node:fs");
    if (!exists(join(this.projectDataDir(projectId), "history.sqlite"))) return [];
    const db = this.historyDb(projectId);
    try {
      const rows = db
        .query(
          "SELECT task_id, title, tags, outcome FROM task_history ORDER BY finished_at DESC LIMIT 100",
        )
        .all() as {
        task_id: string;
        title: string;
        tags: string;
        outcome: string;
      }[];
      const wanted = new Set(tags.map((t) => t.toLowerCase()));
      return rows
        .map((r) => ({
          taskId: r.task_id,
          title: r.title,
          tags: JSON.parse(r.tags) as string[],
          outcome: r.outcome,
        }))
        .filter((r) => r.tags.some((t) => wanted.has(t.toLowerCase())))
        .slice(0, limit);
    } finally {
      db.close();
    }
  }

  // --- Verification artifacts: videos/specs an agent left in its worktree
  // (e.g. a one-time Playwright run) are kept in the project data folder. ---

  async collectArtifacts(task: Task): Promise<string[]> {
    if (!task.worktree || !this.isProjectOnline(task.projectId)) return [];
    const { cpSync, readdirSync } = await import("node:fs");
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 5) return;
      for (const name of readdirSync(dir, {
        withFileTypes: true,
      })) {
        if (name.name === ".git" || name.name === "node_modules" || name.name === "data") continue;
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p, depth + 1);
        else if (/\.(webm|mp4)$/i.test(name.name)) found.push(p);
      }
    };
    try {
      walk(task.worktree, 0);
    } catch {
      return [];
    }
    if (!found.length) return [];
    const dest = join(this.projectDataDir(task.projectId), "artifacts", task.id);
    mkdirSync(dest, {
      recursive: true,
    });
    const names: string[] = [];
    for (const src of found) {
      const name = src.slice(task.worktree.length + 1).replaceAll("/", "__");
      cpSync(src, join(dest, name));
      names.push(name);
    }
    return names;
  }

  async listArtifacts(task: Task): Promise<string[]> {
    if (!this.isProjectOnline(task.projectId)) return [];
    const { readdir } = await import("node:fs/promises");
    return readdir(join(this.projectDataDir(task.projectId), "artifacts", task.id)).catch(
      () => [] as string[],
    );
  }

  artifactPath(task: Task, name: string): string {
    return join(this.projectDataDir(task.projectId), "artifacts", task.id, name);
  }

  // --- Projects: a project is a real folder on this machine, adopted via
  // one symlink in <store>/projects/. Meta and history live inside it
  // under data/ (git-ignored there); removing the symlink unregisters it
  // and touches nothing in the folder. ---

  private projectLink(projectId: string): string {
    return join(this.dir, "projects", projectId);
  }

  private projectDataDir(projectId: string): string {
    return join(this.projectLink(projectId), "data");
  }

  /** Registered at all (symlink present, target may be gone). */
  isProjectRegistered(projectId: string): boolean {
    try {
      return lstatSync(this.projectLink(projectId)).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Registered and the target folder is still there. */
  isProjectOnline(projectId: string): boolean {
    return this.isProjectRegistered(projectId) && existsSync(this.projectLink(projectId));
  }

  /** All registered ids, including ones whose folder is currently offline. */
  async listProjectIds(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(this.dir, "projects")).catch(() => [] as string[]);
    return names.filter((n) => this.isProjectRegistered(n)).sort();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
  async registerProject(
    projectId: string,
    folderPath: string,
    meta?: Partial<Project>,
  ): Promise<Project> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId))
      throw new Error(`project ${projectId}: id must be lowercase letters, digits, dashes`);
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      throw new Error(`project ${projectId}: folder not found: ${folderPath}`);
    }
    mkdirSync(join(this.dir, "projects"), {
      recursive: true,
    });
    const link = this.projectLink(projectId);
    if (this.isProjectRegistered(projectId)) {
      if (!this.isProjectOnline(projectId))
        throw new Error(`project ${projectId}: already registered but offline`);
      if (realpathSync(link) !== realpathSync(folderPath)) {
        throw new Error(`project ${projectId}: already registered to a different folder`);
      }
    } else {
      symlinkSync(folderPath, link, "dir");
    }
    mkdirSync(join(folderPath, "data", "communication"), {
      recursive: true,
    });
    mkdirSync(join(folderPath, "data", "artifacts"), {
      recursive: true,
    });
    // Runtime data must never be committed into the project's own repo.
    const gitignore = join(folderPath, ".gitignore");
    if (existsSync(join(folderPath, ".git"))) {
      const prev = await Bun.file(gitignore)
        .text()
        .catch(() => "");
      if (!prev.split("\n").some((l) => l.trim() === "data/" || l.trim() === "data")) {
        await Bun.write(gitignore, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + "data/\n");
      }
    }
    const project = ProjectSchema.parse({
      id: projectId,
      name: meta?.name ?? projectId,
      description: meta?.description ?? "",
      businessPlan: meta?.businessPlan ?? "",
      rules: meta?.rules ?? "",
      smeSoul: meta?.smeSoul ?? "",
      coderSoul: meta?.coderSoul ?? "",
      goals: meta?.goals ?? [],
      moat: meta?.moat ?? "",
      repoPath: folderPath,
      devCommand: meta?.devCommand ?? "",
      devPort: meta?.devPort ?? 0,
      testMode: meta?.testMode ?? "checks",
      features: meta?.features ?? [],
      lastCommit: this.gitHead(folderPath),
      lastSyncAt: new Date().toISOString(),
    });
    await this.writeProject(project);
    return project;
  }

  private gitHead(folderPath: string): string {
    try {
      return execSync("git rev-parse HEAD", {
        cwd: folderPath,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      return ""; // not a git repo, or no commits yet
    }
  }

  /**
   * Is the stored project data still describing the folder as it is now?
   * stale = the folder has commits the data was not captured at.
   */
  async projectStaleness(projectId: string): Promise<{
    lastCommit: string;
    currentCommit: string;
    stale: boolean;
  }> {
    const project = await this.readProject(projectId);
    const lastCommit = project?.lastCommit ?? "";
    const currentCommit = project ? this.gitHead(project.repoPath) : "";
    return {
      lastCommit,
      currentCommit,
      stale: currentCommit !== "" && currentCommit !== lastCommit,
    };
  }

  /** Re-stamp the project data at the folder's current HEAD. */
  async syncProjectCommit(projectId: string, now: string): Promise<Project> {
    const project = await this.readProject(projectId);
    if (!project) throw new Error(`project ${projectId}: not registered or offline`);
    const next = {
      ...project,
      lastCommit: this.gitHead(project.repoPath),
      lastSyncAt: now,
    };
    await this.writeProject(next);
    return next;
  }

  /** Retrospective for a finished task: the retro agent's review of the whole run, with findings the owner can turn into tasks. */
  async writeRetro(
    taskId: string,
    retro: {
      text: string;
      findings: string[];
      at: string;
      error?: string;
    },
  ): Promise<void> {
    await Bun.write(join(this.taskDir(taskId), "retro.json"), JSON.stringify(retro, null, 2));
  }

  async readRetro(taskId: string): Promise<{
    text: string;
    findings: string[];
    at: string;
    error?: string;
  } | null> {
    const raw = (await Bun.file(join(this.taskDir(taskId), "retro.json"))
      .json()
      .catch(() => null)) as {
      text?: unknown;
      findings?: unknown;
      at?: unknown;
      error?: unknown;
    } | null;
    if (!raw) return null;
    return {
      text: String(raw.text ?? ""),
      findings: Array.isArray(raw.findings) ? raw.findings.map(String) : [],
      at: String(raw.at ?? ""),
      ...(raw.error
        ? {
            error: String(raw.error),
          }
        : {}),
    };
  }

  // --- Visual Review: review record + PNGs under tasks/<id>/visual/,
  // outside every git worktree/repo (the store dir is git-ignored). ---

  visualDir(taskId: string): string {
    const d = join(this.taskDir(taskId), "visual");
    mkdirSync(d, {
      recursive: true,
    });
    return d;
  }

  async writeVisualReview(taskId: string, review: VisualReview): Promise<void> {
    const valid = VisualReviewSchema.parse(review);
    await Bun.write(join(this.visualDir(taskId), "visual.json"), JSON.stringify(valid, null, 2));
  }

  async readVisualReview(taskId: string): Promise<VisualReview | null> {
    const raw = await Bun.file(join(this.dir, "tasks", taskId, "visual", "visual.json"))
      .json()
      .catch(() => null);
    const parsed = VisualReviewSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** Absolute path of one stored screenshot; kind is baseline|after|diff. */
  visualFilePath(taskId: string, kind: string, name: string): string {
    const safeKind = [
      "baseline",
      "after",
      "diff",
    ].includes(kind)
      ? kind
      : "after";
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, "");
    return join(this.dir, "tasks", taskId, "visual", safeKind, safeName);
  }

  // --- Deferred minor red-team points: per-project list in the central
  // store dir (not a task, not in git). Dismissed/included stay recorded. ---

  private deferredPath(projectId: string): string {
    const dir = join(this.dir, "deferred");
    mkdirSync(dir, {
      recursive: true,
    });
    return join(dir, `${projectId}.json`);
  }

  async listDeferred(projectId: string): Promise<DeferredPoint[]> {
    const raw = await Bun.file(this.deferredPath(projectId))
      .json()
      .catch(() => null);
    if (!Array.isArray(raw)) return [];
    const out: DeferredPoint[] = [];
    for (const item of raw) {
      const parsed = DeferredPointSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async writeDeferred(projectId: string, points: DeferredPoint[]): Promise<void> {
    await Bun.write(this.deferredPath(projectId), JSON.stringify(points, null, 2));
  }

  /** Add points, skipping any whose normalized text is already recorded. Returns the added ones. */
  async addDeferred(projectId: string, points: DeferredPoint[]): Promise<DeferredPoint[]> {
    const existing = await this.listDeferred(projectId);
    const seen = new Set(existing.map((d) => normalizePrompt(d.text)));
    const added: DeferredPoint[] = [];
    for (const d of points) {
      const key = normalizePrompt(d.text);
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(d);
    }
    if (added.length)
      await this.writeDeferred(projectId, [
        ...existing,
        ...added,
      ]);
    return added;
  }

  async setDeferredStatus(
    projectId: string,
    pointId: string,
    status: DeferredPoint["status"],
    includedInTaskId = "",
  ): Promise<DeferredPoint | null> {
    const points = await this.listDeferred(projectId);
    const point = points.find((d) => d.id === pointId);
    if (!point) return null;
    point.status = status;
    if (includedInTaskId) point.includedInTaskId = includedInTaskId;
    await this.writeDeferred(projectId, points);
    return point;
  }

  /** Scout suggestions for a project: shown to the owner, applied only on accept. Stored in SQLite (decision record), mirrored to scout.json. */
  async writeScoutSuggestions(projectId: string, suggestions: ScoutSuggestions): Promise<void> {
    this.dialogue().saveScout(projectId, JSON.stringify(suggestions));
    mkdirSync(this.projectDataDir(projectId), {
      recursive: true,
    });
    await Bun.write(
      join(this.projectDataDir(projectId), "scout.json"),
      JSON.stringify(suggestions, null, 2),
    );
  }

  async readScoutSuggestions(projectId: string): Promise<ScoutSuggestions | null> {
    const fromDb = this.dialogue().scout(projectId);
    const raw = fromDb
      ? (JSON.parse(fromDb) as Partial<ScoutSuggestions>)
      : ((await Bun.file(join(this.projectDataDir(projectId), "scout.json"))
          .json()
          .catch(() => null)) as Partial<ScoutSuggestions> | null);
    if (!raw) return null;
    return {
      description: String(raw.description ?? ""),
      rules: String(raw.rules ?? ""),
      smeSoul: String(raw.smeSoul ?? ""),
      coderSoul: String(raw.coderSoul ?? ""),
      at: String(raw.at ?? ""),
      ...(raw.error
        ? {
            error: String(raw.error),
          }
        : {}),
    };
  }

  /** Remove only the registry symlink; the project folder is untouched. */
  unregisterProject(projectId: string): void {
    if (this.isProjectRegistered(projectId)) unlinkSync(this.projectLink(projectId));
  }

  async writeProject(project: Project): Promise<void> {
    const valid = ProjectSchema.parse(project);
    if (!this.isProjectOnline(valid.id))
      throw new Error(`project ${valid.id}: not registered or offline`);
    mkdirSync(this.projectDataDir(valid.id), {
      recursive: true,
    });
    await Bun.write(
      join(this.projectDataDir(valid.id), "project.json"),
      JSON.stringify(valid, null, 2),
    );
  }

  async readProject(projectId: string): Promise<Project | null> {
    if (!this.isProjectOnline(projectId)) return null;
    const raw = await Bun.file(join(this.projectDataDir(projectId), "project.json"))
      .json()
      .catch(() => null);
    const parsed = ProjectSchema.safeParse(raw);
    if (!parsed.success) return null;
    // repoPath is authoritative from the symlink, never from stored JSON.
    let repoPath = parsed.data.repoPath;
    try {
      repoPath = realpathSync(this.projectLink(projectId));
    } catch {
      // keep stored value
    }
    return {
      ...parsed.data,
      repoPath,
    };
  }

  async listProjects(): Promise<Project[]> {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(this.dir, "projects")).catch(() => [] as string[]);
    const projects: Project[] = [];
    for (const n of names) {
      const p = await this.readProject(n);
      if (p) projects.push(p);
    }
    return projects.sort((a, b) => a.id.localeCompare(b.id));
  }

  async recordOverride(jobId: string, by: string, reason: string): Promise<void> {
    const line =
      JSON.stringify({
        at: new Date().toISOString(),
        jobId,
        by,
        reason,
      }) + "\n";
    const path = join(this.jobDir(jobId), "overrides.jsonl");
    const prev = await Bun.file(path)
      .text()
      .catch(() => "");
    await Bun.write(path, prev + line);
  }
}
