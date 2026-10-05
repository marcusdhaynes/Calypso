import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
} from "@calypso/shared";
import { DEFAULT_NUM_CTX } from "../inference/shared-server.js";

/**
 * Generic OpenAI-compatible HTTP provider (Ollama, llama.cpp server, cloud).
 * Streaming uses SSE over fetch for /v1 backends.
 *
 * keep_alive: Ollama's OpenAI-compatible `/v1` endpoints do NOT accept
 * `keep_alive`. To keep a model resident in VRAM, use OllamaAdmin native
 * `/api/generate` (see preloadPrimaryModel + SharedInferenceServer
 * refreshKeepAliveAfterInference). Do not add keep_alive to chat payloads here.
 *
 * num_ctx / Ollama chat path: `/v1` silently ignores `options.num_ctx` (and
 * top-level num_ctx on many builds), which would drop a preload'd 8k KV cache
 * back to ~4k on the first reply. For id "ollama" we therefore call native
 * `/api/chat` with `options.num_ctx = DEFAULT_NUM_CTX` (8192) so chat matches
 * preload VRAM — 8k on RTX 4060 8GB with resident qwen3:8b; vision
 * qwen2.5vl:3b loads on demand and must still fit after unload.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: {
    id: string;
    displayName: string;
    baseUrl: string;
    apiKey?: string;
  }) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  /** Native Ollama host (strip trailing /v1). */
  private ollamaNativeBase(): string {
    return this.baseUrl.replace(/\/v1$/i, "");
  }

  /**
   * OpenAI-compatible /v1 body (llama.cpp, cloud, and unused Ollama /v1 fallback).
   * Drop undefined keys so providers that reject unknown nulls stay happy.
   */
  private body(request: ChatCompletionRequest, stream: boolean): string {
    const payload: Record<string, unknown> = { ...request, stream };
    if (this.id === "ollama") {
      // Kept for any residual /v1 callers: reasoning_effort turns thinking off;
      // options.num_ctx is ignored by /v1 on current Ollama — prefer native /api/chat.
      if (request.think === true) {
        delete payload.reasoning_effort;
      } else {
        payload.reasoning_effort = "none";
      }
      delete payload.think;
      const prevOpts =
        payload.options && typeof payload.options === "object"
          ? (payload.options as Record<string, unknown>)
          : {};
      payload.options = { ...prevOpts, num_ctx: DEFAULT_NUM_CTX };
    } else {
      delete payload.think;
    }
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    return JSON.stringify(payload);
  }

  /**
   * Native Ollama /api/chat body — honors options.num_ctx and `think`.
   * Do NOT turn thinking back on for normal chat (think only when request.think).
   */
  private ollamaNativeBody(request: ChatCompletionRequest, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
      options: { num_ctx: DEFAULT_NUM_CTX },
      // Native API respects `think`; false keeps qwen3 from burning hidden tokens.
      think: request.think === true,
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.max_tokens !== undefined) {
      // Native uses options.num_predict for generation length.
      (payload.options as Record<string, unknown>).num_predict = request.max_tokens;
    }
    if (request.stop !== undefined) payload.stop = request.stop;
    if (request.tools !== undefined) payload.tools = request.tools;
    return JSON.stringify(payload);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    if (this.id === "ollama") {
      return this.ollamaComplete(request);
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, false),
    });
    if (!res.ok) {
      throw new Error(`ModelProvider ${this.id} complete failed: ${res.status}`);
    }
    return (await res.json()) as ChatCompletionResponse;
  }

  private async ollamaComplete(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const res = await fetch(`${this.ollamaNativeBase()}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: this.ollamaNativeBody(request, false),
    });
    if (!res.ok) {
      throw new Error(`ModelProvider ${this.id} complete failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      model?: string;
      message?: {
        role?: string;
        content?: string | null;
        tool_calls?: unknown[];
      };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const message = {
      role: (data.message?.role as "assistant") ?? "assistant",
      content: data.message?.content ?? "",
      ...(data.message?.tool_calls
        ? { tool_calls: data.message.tool_calls }
        : {}),
    };
    return {
      id: `ollama-${Date.now()}`,
      choices: [
        {
          index: 0,
          message: message as ChatCompletionResponse["choices"][0]["message"],
          finish_reason: data.done_reason ?? "stop",
        },
      ],
      usage:
        data.prompt_eval_count !== undefined || data.eval_count !== undefined
          ? {
              prompt_tokens: data.prompt_eval_count ?? 0,
              completion_tokens: data.eval_count ?? 0,
              total_tokens:
                (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            }
          : undefined,
    };
  }

  async *stream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<ChatCompletionChunk> {
    if (this.id === "ollama") {
      yield* this.ollamaStream(request, signal);
      return;
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, true),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ModelProvider ${this.id} stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as ChatCompletionChunk;
        } catch {
          /* skip malformed */
        }
      }
    }
  }

  /** Native Ollama NDJSON stream → OpenAI-shaped chunks. */
  private async *ollamaStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<ChatCompletionChunk> {
    const res = await fetch(`${this.ollamaNativeBase()}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      body: this.ollamaNativeBody(request, true),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ModelProvider ${this.id} stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const id = `ollama-${Date.now()}`;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed) as {
            message?: {
              role?: string;
              content?: string | null;
              tool_calls?: unknown[];
            };
            done?: boolean;
            done_reason?: string | null;
          };
          const delta: ChatCompletionChunk["choices"][0]["delta"] = {};
          if (evt.message?.role) delta.role = evt.message.role;
          if (evt.message?.content) delta.content = evt.message.content;
          if (evt.message?.tool_calls) delta.tool_calls = evt.message.tool_calls;
          yield {
            id,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: evt.done ? (evt.done_reason ?? "stop") : null,
              },
            ],
          };
          if (evt.done) return;
        } catch {
          /* skip malformed */
        }
      }
    }
  }

  async isReady(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}

/** Convenience factory for local Ollama (default localhost:11434). */
export function createOllamaProvider(
  baseUrl = "http://127.0.0.1:11434/v1"
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "ollama",
    displayName: "Ollama",
    baseUrl,
  });
}

/** Convenience factory for llama.cpp server. */
export function createLlamaCppProvider(
  baseUrl = "http://127.0.0.1:8080/v1"
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "llamacpp",
    displayName: "llama.cpp",
    baseUrl,
  });
}

/** Default OpenAI-compatible cloud base URL. */
export const DEFAULT_OPENAI_CLOUD_BASE_URL = "https://api.openai.com/v1";

/**
 * Resolve a cloud API key without logging it.
 * Prefers explicit opt → CALYPSO_OPENAI_API_KEY → OPENAI_API_KEY.
 */
export function resolveOpenAIApiKey(explicit?: string): string | undefined {
  const fromOpt = explicit?.trim();
  if (fromOpt) return fromOpt;
  const fromCalypso = process.env.CALYPSO_OPENAI_API_KEY?.trim();
  if (fromCalypso) return fromCalypso;
  const fromOpenAI = process.env.OPENAI_API_KEY?.trim();
  if (fromOpenAI) return fromOpenAI;
  return undefined;
}

export interface OpenAICloudProviderOptions {
  /** Defaults to "openai" (matches DEFAULT_RTX_4060_8GB_ROUTES.frontier). */
  id?: string;
  displayName?: string;
  /** OpenAI-compatible base URL. Default https://api.openai.com/v1 */
  baseUrl?: string;
  /** Explicit key; otherwise env CALYPSO_OPENAI_API_KEY / OPENAI_API_KEY. */
  apiKey?: string;
}

/**
 * Factory for an OpenAI-compatible cloud frontier provider.
 * Returns null when no API key is available (caller should keep cloud unregistered).
 * Never logs the key.
 */
export function createOpenAICloudProvider(
  opts: OpenAICloudProviderOptions = {}
): OpenAICompatibleProvider | null {
  const apiKey = resolveOpenAIApiKey(opts.apiKey);
  if (!apiKey) return null;
  return new OpenAICompatibleProvider({
    id: opts.id ?? "openai",
    displayName: opts.displayName ?? "OpenAI (cloud)",
    baseUrl: (opts.baseUrl?.trim() || DEFAULT_OPENAI_CLOUD_BASE_URL).replace(
      /\/$/,
      ""
    ),
    apiKey,
  });
}
