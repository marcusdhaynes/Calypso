import type {
  EmbeddingProvider,
  MemoryEntry,
  MemoryId,
  MemoryRetrieveQuery,
  MemoryScope,
  MemoryStore,
  MemoryWriteInput,
} from "@calypso/shared";
import type { CalypsoDatabase } from "../db/database.js";

function scopeKey(scope: MemoryScope): { type: string; id: string | null } {
  switch (scope.type) {
    case "conversation":
      return { type: "conversation", id: scope.conversationId };
    case "worker":
      return { type: "worker", id: scope.workerId };
    case "user":
      return { type: "user", id: null };
    case "project":
      return { type: "project", id: scope.projectId };
    case "team":
      return { type: "team", id: scope.teamId };
  }
}

function parseScope(type: string, id: string | null): MemoryScope {
  switch (type) {
    case "conversation":
      return { type: "conversation", conversationId: id! };
    case "worker":
      return { type: "worker", workerId: id! };
    case "user":
      return { type: "user" };
    case "project":
      return { type: "project", projectId: id! };
    case "team":
      return { type: "team", teamId: id! };
    default:
      throw new Error(`Unknown memory scope type: ${type}`);
  }
}

function packEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i]!, i * 4);
  return buf;
}

function unpackEmbedding(buf: Buffer | null): number[] | undefined {
  if (!buf || buf.length === 0) return undefined;
  const out: number[] = [];
  for (let i = 0; i + 3 < buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

type MemoryRow = {
  id: string;
  kind: MemoryEntry["kind"];
  content: string;
  facts: string | null;
  scope_type: string;
  scope_id: string | null;
  metadata: string | null;
  embedding: Buffer | null;
  created_at: number;
  updated_at: number;
};

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    facts: row.facts ? (JSON.parse(row.facts) as Record<string, unknown>) : undefined,
    scope: parseScope(row.scope_type, row.scope_id),
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    embedding: unpackEmbedding(row.embedding),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistent MemoryStore backed by better-sqlite3.
 * retrieve() never dumps the whole DB — always limited, scoped, ranked.
 */
export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private database: CalypsoDatabase,
    private embeddings?: EmbeddingProvider
  ) {}

  async write(entry: MemoryWriteInput): Promise<MemoryEntry> {
    const now = Date.now();
    const id = entry.id ?? `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.database.db
      .prepare("SELECT created_at, embedding FROM memory WHERE id = ?")
      .get(id) as { created_at: number; embedding: Buffer | null } | undefined;

    let embedding = entry.embedding;
    if (!embedding && this.embeddings) {
      try {
        const ready = await this.embeddings.isReady();
        if (ready) {
          const [vec] = await this.embeddings.embed([entry.content]);
          embedding = vec;
        }
      } catch {
        /* embeddings optional — keyword retrieve still works */
      }
    }
    if (!embedding && existing?.embedding) {
      embedding = unpackEmbedding(existing.embedding);
    }

    const scope = scopeKey(entry.scope);
    const createdAt = existing?.created_at ?? now;
    this.database.db
      .prepare(
        `INSERT INTO memory(id, kind, content, facts, scope_type, scope_id, metadata, embedding, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           content = excluded.content,
           facts = excluded.facts,
           scope_type = excluded.scope_type,
           scope_id = excluded.scope_id,
           metadata = excluded.metadata,
           embedding = excluded.embedding,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        entry.kind,
        entry.content,
        entry.facts ? JSON.stringify(entry.facts) : null,
        scope.type,
        scope.id,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        embedding ? packEmbedding(embedding) : null,
        createdAt,
        now
      );

    return {
      id,
      kind: entry.kind,
      content: entry.content,
      facts: entry.facts,
      scope: entry.scope,
      metadata: entry.metadata,
      embedding,
      createdAt,
      updatedAt: now,
    };
  }

  async get(id: MemoryId): Promise<MemoryEntry | null> {
    const row = this.database.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  async delete(id: MemoryId): Promise<boolean> {
    const info = this.database.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    return info.changes > 0;
  }

  async retrieve(query: MemoryRetrieveQuery): Promise<MemoryEntry[]> {
    const limit = Math.min(query.limit ?? 20, 100);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.kind) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    if (query.includeSummaries === false) {
      clauses.push("kind != 'summary'");
    }
    if (query.scope) {
      const s = scopeKey(query.scope);
      clauses.push("scope_type = ?");
      params.push(s.type);
      if (s.id !== null) {
        clauses.push("scope_id = ?");
        params.push(s.id);
      }
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // Pull a candidate pool larger than limit for ranking; still bounded.
    const poolLimit = Math.min(Math.max(limit * 10, 50), 500);
    const rows = this.database.db
      .prepare(`SELECT * FROM memory ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, poolLimit) as MemoryRow[];

    let results = rows.map(rowToEntry);

    if (query.factKeys?.length) {
      results = results.filter((e) => {
        if (!e.facts) return false;
        return query.factKeys!.every((k) => k in e.facts!);
      });
    }

    if (query.text) {
      const q = query.text.toLowerCase();
      let queryVec: number[] | undefined;
      if (this.embeddings) {
        try {
          const ready = await this.embeddings.isReady();
          if (ready) {
            const [vec] = await this.embeddings.embed([query.text]);
            queryVec = vec;
          }
        } catch {
          /* fall through to keyword */
        }
      }

      const scored = results.map((e) => {
        let score = 0;
        if (e.content.toLowerCase().includes(q)) score += 0.35;
        if (queryVec && e.embedding) score += cosine(queryVec, e.embedding);
        return { e, score };
      });
      scored.sort((a, b) => b.score - a.score);
      results = scored.filter((s) => s.score > 0 || !query.text).map((s) => s.e);
      // If nothing matched keyword/semantic, return empty rather than unrelated dumps.
      if (scored.every((s) => s.score === 0)) results = [];
    }

    return results.slice(0, limit);
  }
}
