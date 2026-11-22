import { Database } from "bun:sqlite";

// SQLite store for everything conversational: task dialogue (prompts),
// owner decisions, scout suggestions, and unsent UI drafts. Files were
// the old medium (JSONL rewrites on every append); SQLite with WAL and
// FULL synchronous survives a crash mid-write, and a restart reopens the
// same database — no dialogue or draft is lost.
export interface DialogueEntry {
  at: string;
  kind: string;
  text: string;
}

export class DialogueDb {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, {
      create: true,
    });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompts_task ON prompts(task_id, id);
      CREATE TABLE IF NOT EXISTS drafts (
        task_id TEXT NOT NULL,
        field TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, field)
      );
      CREATE TABLE IF NOT EXISTS scout (
        project_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imports (
        task_id TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
    `);
  }

  appendPrompt(taskId: string, entry: DialogueEntry): void {
    this.db
      .query("INSERT INTO prompts (task_id, at, kind, text) VALUES (?, ?, ?, ?)")
      .run(taskId, entry.at, entry.kind, entry.text);
  }

  listPrompts(taskId: string): DialogueEntry[] {
    return this.db
      .query("SELECT at, kind, text FROM prompts WHERE task_id = ? ORDER BY id")
      .all(taskId) as DialogueEntry[];
  }

  promptCount(taskId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM prompts WHERE task_id = ?")
      .get(taskId) as {
      n: number;
    };
    return row.n;
  }

  hasImported(taskId: string): boolean {
    return !!this.db.query("SELECT task_id FROM imports WHERE task_id = ?").get(taskId);
  }

  /** One-time legacy import: insert JSONL rows and mark the task done. */
  importPrompts(taskId: string, entries: DialogueEntry[]): void {
    const insert = this.db.query(
      "INSERT INTO prompts (task_id, at, kind, text) VALUES (?, ?, ?, ?)",
    );
    const mark = this.db.query(
      "INSERT OR IGNORE INTO imports (task_id, imported_at) VALUES (?, ?)",
    );
    this.db.transaction(() => {
      for (const e of entries) insert.run(taskId, e.at, e.kind, e.text);
      mark.run(taskId, new Date().toISOString());
    })();
  }

  saveDraft(taskId: string, field: string, text: string): void {
    if (!text) {
      this.db.query("DELETE FROM drafts WHERE task_id = ? AND field = ?").run(taskId, field);
      return;
    }
    this.db
      .query(
        "INSERT INTO drafts (task_id, field, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, field) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
      )
      .run(taskId, field, text, new Date().toISOString());
  }

  drafts(taskId: string): Record<string, string> {
    const rows = this.db.query("SELECT field, text FROM drafts WHERE task_id = ?").all(taskId) as {
      field: string;
      text: string;
    }[];
    return Object.fromEntries(
      rows.map((r) => [
        r.field,
        r.text,
      ]),
    );
  }

  /** Erase every conversational trace of a task: dialogue, unsent drafts, import marks. */
  deleteTask(taskId: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM prompts WHERE task_id = ?").run(taskId);
      this.db.query("DELETE FROM drafts WHERE task_id = ?").run(taskId);
      this.db.query("DELETE FROM imports WHERE task_id = ?").run(taskId);
    })();
  }

  saveScout(projectId: string, json: string): void {
    this.db
      .query(
        "INSERT INTO scout (project_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      )
      .run(projectId, json, new Date().toISOString());
  }

  scout(projectId: string): string | null {
    const row = this.db.query("SELECT json FROM scout WHERE project_id = ?").get(projectId) as {
      json: string;
    } | null;
    return row?.json ?? null;
  }

  close(): void {
    this.db.close();
  }
}
