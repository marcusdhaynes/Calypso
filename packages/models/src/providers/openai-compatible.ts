import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
} from "@calypso/shared";

/**
 * Generic OpenAI-compatible HTTP provider (Ollama, llama.cpp server, cloud).
 * Streaming uses SSE over fetch.
 *
 * keep_alive: Ollama's OpenAI-compatible `/v1` endpoints do NOT accept
 * `keep_alive`. To keep a model resident in VRAM, use OllamaAdmin native
 * `/api/generate` (see preloadPrimaryModel + SharedInferenceServer
 * refreshKeepAliveAfterInference). Do not add keep_alive to chat payloads here.
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


  /** Drop undefined keys so providers that reject unknown nulls stay happy. */
  private body(request: ChatCompletionRequest, stream: boolean): string {
    const payload: Record<string, unknown> = { ...request, stream };
    if (this.id === "ollama") {
      // Ollama's /v1 endpoint ignores `think`; qwen3 thinks by default and spends
      // hundreds of hidden tokens per reply (≈3s vs ≈12s measured on the 4060).
      // reasoning_effort "none" is what actually turns thinking off there.
      if (request.think === true) {
        delete payload.reasoning_effort;
      } else {
        payload.reasoning_effort = "none";
      }
      delete payload.think;
    } else {
      delete payload.think;
    }
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
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

  async *stream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncIterable<ChatCompletionChunk> {
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
