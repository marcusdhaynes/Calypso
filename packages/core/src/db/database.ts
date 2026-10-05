import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  Conversation,
  Message,
  Project,
  Routine,
  Task,
  Team,
  Worker,
} from "@calypso/shared";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  facts TEXT,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  metadata TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_run_at);
`;

export interface OpenDatabaseOptions {
  /** Absolute path to the .sqlite file, or ":memory:" for tests. */
  filePath: string;
}

/**
 * Calypso persistence root — one SQLite file shared by workers, teams,
 * projects, tasks, routines, conversations, messages, and memory.
 */
export class CalypsoDatabase {
  readonly filePath: string;
  readonly db: Database.Database;

  constructor(opts: OpenDatabaseOptions) {
    this.filePath = opts.filePath;
    if (opts.filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
    }
    this.db = new Database(opts.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 0;
    if (current < SCHEMA_VERSION) {
      this.db
        .prepare(
          "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run("schema_version", String(SCHEMA_VERSION));
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- generic JSON entity helpers ----

  private upsertJson(table: string, id: string, value: unknown, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id, json, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(id, JSON.stringify(value), updatedAt);
  }

  private loadAllJson<T>(table: string): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table}`).all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as T);
  }

  private getJson<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  private deleteId(table: string, id: string): boolean {
    const info = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  // ---- workers / teams / projects ----

  upsertWorker(worker: Worker): void {
    this.upsertJson("workers", worker.id, worker, worker.updatedAt);
  }
  listWorkers(): Worker[] {
    return this.loadAllJson<Worker>("workers");
  }
  getWorker(id: string): Worker | undefined {
    return this.getJson<Worker>("workers", id);
  }
  deleteWorker(id: string): boolean {
    return this.deleteId("workers", id);
  }

  upsertTeam(team: Team): void {
    this.upsertJson("teams", team.id, team, team.updatedAt);
  }
  listTeams(): Team[] {
    return this.loadAllJson<Team>("teams");
  }
  getTeam(id: string): Team | undefined {
    return this.getJson<Team>("teams", id);
  }
  deleteTeam(id: string): boolean {
    return this.deleteId("teams", id);
  }

  upsertProject(project: Project): void {
    this.upsertJson("projects", project.id, project, project.updatedAt);
  }
  listProjects(): Project[] {
    return this.loadAllJson<Project>("projects");
  }
  getProject(id: string): Project | undefined {
    return this.getJson<Project>("projects", id);
  }
  deleteProject(id: string): boolean {
    return this.deleteId("projects", id);
  }

  // ---- tasks ----

  upsertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks(id, json, status, parent_id, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           status = excluded.status,
           parent_id = excluded.parent_id,
           updated_at = excluded.updated_at`
      )
      .run(task.id, JSON.stringify(task), task.status, task.parentId, task.updatedAt);
  }

  listTasks(): Task[] {
    const rows = this.db.prepare("SELECT json FROM tasks").all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Task);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Task) : undefined;
  }

  deleteTask(id: string): boolean {
    return this.deleteId("tasks", id);
  }

  // ---- routines ----

  upsertRoutine(routine: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines(id, json, enabled, next_run_at, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`
      )
      .run(
        routine.id,
        JSON.stringify(routine),
        routine.enabled ? 1 : 0,
        routine.nextRunAt ?? null,
        routine.updatedAt
      );
  }

  listRoutines(): Routine[] {
    const rows = this.db.prepare("SELECT json FROM routines").all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Routine);
  }

  getRoutine(id: string): Routine | undefined {
    const row = this.db.prepare("SELECT json FROM routines WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Routine) : undefined;
  }

  deleteRoutine(id: string): boolean {
    return this.deleteId("routines", id);
  }

  // ---- conversations / messages ----

  upsertConversation(conversation: Conversation): void {
    this.upsertJson("conversations", conversation.id, conversation, conversation.updatedAt);
  }

  listConversations(): Conversation[] {
    return this.loadAllJson<Conversation>("conversations");
  }

  upsertMessage(message: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages(id, conversation_id, json, created_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           json = excluded.json,
           created_at = excluded.created_at`
      )
      .run(message.id, message.conversationId, JSON.stringify(message), message.createdAt);
  }

  listMessages(conversationId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT json FROM messages WHERE conversation_id = ? ORDER BY created_at ASC"
      )
      .all(conversationId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Message);
  }
}

/** Default on-disk path under the user data directory (caller supplies root). */
export function defaultDatabasePath(userDataRoot: string): string {
  return path.join(userDataRoot, "calypso.sqlite");
}
