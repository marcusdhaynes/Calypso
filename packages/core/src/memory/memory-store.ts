import type {
  MemoryEntry,
  MemoryId,
  MemoryRetrieveQuery,
  MemoryStore,
  MemoryWriteInput,
} from "@calypso/shared";

/** In-memory MemoryStore stub. Replace with better-sqlite3 (Anky). */
export class InMemoryMemoryStore implements MemoryStore {
  private entries = new Map<MemoryId, MemoryEntry>();

  async write(entry: MemoryWriteInput): Promise<MemoryEntry> {
    const now = Date.now();
    const id = entry.id ?? `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.entries.get(id);
    const full: MemoryEntry = {
      id,
      kind: entry.kind,
      content: entry.content,
      facts: entry.facts,
      scope: entry.scope,
      metadata: entry.metadata,
      embedding: entry.embedding,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(id, full);
    return full;
  }

  async get(id: MemoryId): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async delete(id: MemoryId): Promise<boolean> {
    return this.entries.delete(id);
  }

  /**
   * Scoped retrieve with a hard limit — never dump the whole store
   * into a model prompt.
   */
  async retrieve(query: MemoryRetrieveQuery): Promise<MemoryEntry[]> {
    const limit = Math.min(query.limit ?? 20, 100);
    let results = [...this.entries.values()];

    if (query.kind) results = results.filter((e) => e.kind === query.kind);
    if (query.scope) {
      const s = query.scope;
      results = results.filter((e) => {
        if (e.scope.type !== s.type) return false;
        if (s.type === "conversation" && e.scope.type === "conversation") {
          return e.scope.conversationId === s.conversationId;
        }
        if (s.type === "worker" && e.scope.type === "worker") {
          return e.scope.workerId === s.workerId;
        }
        if (s.type === "project" && e.scope.type === "project") {
          return e.scope.projectId === s.projectId;
        }
        if (s.type === "team" && e.scope.type === "team") {
          return e.scope.teamId === s.teamId;
        }
        return s.type === "user";
      });
    }
    if (query.text) {
      const q = query.text.toLowerCase();
      results = results.filter((e) => e.content.toLowerCase().includes(q));
    }
    if (query.factKeys?.length) {
      results = results.filter((e) => {
        if (!e.facts) return false;
        return query.factKeys!.every((k) => k in e.facts!);
      });
    }
    if (query.includeSummaries === false) {
      results = results.filter((e) => e.kind !== "summary");
    }
    return results.slice(0, limit);
  }
}
