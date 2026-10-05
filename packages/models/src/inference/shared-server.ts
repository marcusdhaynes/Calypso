/**
 * Shared local inference layer — one ModelProvider, concurrent queue.
 *
 * Calypso must NOT load a separate massive model per worker. All workers
 * share this server; VRAM-tight GPUs (RTX 4060 8 GB) default to low
 * concurrency and explicit model swap/unload.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
} from "@calypso/shared";

export interface SharedInferenceServerOptions {
  /** Underlying OpenAI-compatible (or other) provider. */
  provider: ModelProvider;
  /**
   * Max in-flight complete/stream calls.
   * Default 1 for GPU safety; raise for CPU-only or plenty of VRAM.
   */
  maxConcurrent?: number;
  /**
   * When true (default), switching to a different model calls unload on the
   * previous active model before the new request (VRAM swap policy).
   */
  swapUnload?: boolean;
  /** Optional admin hooks (Ollama keep_alive / unload). */
  admin?: InferenceAdmin;
}

/** Thin admin surface for load/unload beyond OpenAI-compatible chat APIs. */
export interface InferenceAdmin {
  warmup?(model: string): Promise<void>;
  unload?(model: string): Promise<void>;
}

export interface OllamaAdminOptions {
  /** Native Ollama base (not /v1). Default http://127.0.0.1:11434 */
  baseUrl?: string;
  /** keep_alive for warmup generate; default "10m". Use "0" to unload. */
  keepAlive?: string;
}

/**
 * Ollama native API helpers (/api/generate keep_alive, /api/generate unload).
 * OpenAI-compatible /v1 does not expose unload — use this alongside the chat provider.
 */
export class OllamaAdmin implements InferenceAdmin {
  private baseUrl: string;
  private keepAlive: string;

  constructor(opts: OllamaAdminOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.keepAlive = opts.keepAlive ?? "10m";
  }

  async warmup(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: this.keepAlive,
      }),
    });
    if (!res.ok) {
      throw new Error(`OllamaAdmin warmup failed: ${res.status}`);
    }
    // Drain body so the connection can close cleanly.
    await res.text().catch(() => undefined);
  }

  async unload(model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: "0",
      }),
    });
    if (!res.ok) {
      throw new Error(`OllamaAdmin unload failed: ${res.status}`);
    }
    await res.text().catch(() => undefined);
  }
}

interface QueueWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * Single shared inference front-door with a concurrency queue and optional
 * VRAM-aware model swap.
 */
export class SharedInferenceServer {
  readonly provider: ModelProvider;
  private maxConcurrent: number;
  private swapUnload: boolean;
  private admin?: InferenceAdmin;
  private active = 0;
  private waiters: QueueWaiter[] = [];
  private _activeModel: string | null = null;

  constructor(opts: SharedInferenceServerOptions) {
    this.provider = opts.provider;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 1);
    this.swapUnload = opts.swapUnload ?? true;
    this.admin = opts.admin;
  }

  /** Model name of the last acquired inference slot (best-effort). */
  get activeModel(): string | null {
    return this._activeModel;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  get activeCount(): number {
    return this.active;
  }

  async warmup(model: string): Promise<void> {
    if (!this.admin?.warmup) return;
    await this.admin.warmup(model);
    this._activeModel = model;
  }

  async unload(model: string): Promise<void> {
    if (!this.admin?.unload) return;
    await this.admin.unload(model);
    if (this._activeModel === model) this._activeModel = null;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const release = await this.acquire(request.model);
    try {
      return await this.provider.complete(request);
    } finally {
      release();
    }
  }

  async *stream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<ChatCompletionChunk> {
    const release = await this.acquire(request.model, signal);
    try {
      for await (const chunk of this.provider.stream(request, signal)) {
        yield chunk;
      }
    } finally {
      release();
    }
  }

  private async acquire(
    model: string,
    signal?: AbortSignal
  ): Promise<() => void> {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const waiter: QueueWaiter = { resolve, reject };
        this.waiters.push(waiter);
        if (signal) {
          const onAbort = () => {
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) this.waiters.splice(idx, 1);
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }

    this.active += 1;

    try {
      await this.ensureModel(model);
    } catch (err) {
      this.releaseSlot();
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next.resolve();
  }

  private async ensureModel(model: string): Promise<void> {
    if (
      this.swapUnload &&
      this._activeModel &&
      this._activeModel !== model &&
      this.admin?.unload
    ) {
      try {
        await this.admin.unload(this._activeModel);
      } catch {
        /* best-effort unload — proceed with new model */
      }
    }
    this._activeModel = model;
  }
}

/**
 * Sensible defaults: GPU → maxConcurrent 1; pass higher for CPU-only hosts.
 */
export function createSharedInferenceServer(
  opts: SharedInferenceServerOptions
): SharedInferenceServer {
  return new SharedInferenceServer(opts);
}
