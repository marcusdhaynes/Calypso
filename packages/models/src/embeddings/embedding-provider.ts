/**
 * Embedding providers for Anky's memory layer.
 * Default local model: nomic-embed-text (small, CPU-friendly — does not steal GPU from chat).
 */
import type { EmbeddingProvider } from "@calypso/shared";

export type { EmbeddingProvider };

export interface OpenAICompatibleEmbeddingOptions {
  id?: string;
  displayName?: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Declared output dimensionality (nomic-embed-text = 768). */
  dimensions: number;
}

/**
 * OpenAI-compatible `/embeddings` client (Ollama, cloud, etc.).
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly displayName: string;
  readonly dimensions: number;
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(opts: OpenAICompatibleEmbeddingOptions) {
    this.id = opts.id ?? "openai-compatible-embeddings";
    this.displayName = opts.displayName ?? "OpenAI-compatible embeddings";
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(
        `EmbeddingProvider ${this.id} failed: ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const rows = data.data ?? [];
    // Preserve input order by index when present.
    const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((r) => r.embedding);
  }

  async isReady(): Promise<boolean> {
    try {
      const vectors = await this.embed(["ping"]);
      return Array.isArray(vectors[0]) && vectors[0].length > 0;
    } catch {
      return false;
    }
  }
}

/** Default Ollama embed model — small, typically CPU-resident. */
export const DEFAULT_LOCAL_EMBED_MODEL = "nomic-embed-text";
export const DEFAULT_LOCAL_EMBED_DIMENSIONS = 768;

/**
 * Factory for local Ollama embeddings (nomic-embed-text).
 */
export function createLocalEmbeddingProvider(
  baseUrl = "http://127.0.0.1:11434/v1",
  model = DEFAULT_LOCAL_EMBED_MODEL
): OpenAICompatibleEmbeddingProvider {
  return new OpenAICompatibleEmbeddingProvider({
    id: "ollama-embeddings",
    displayName: "Ollama embeddings",
    baseUrl,
    model,
    dimensions: DEFAULT_LOCAL_EMBED_DIMENSIONS,
  });
}
