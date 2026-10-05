import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelProvider,
} from "@calypso/shared";

/**
 * Generic OpenAI-compatible HTTP provider (Ollama, llama.cpp server, cloud).
 * Streaming uses SSE over fetch.
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
      body: JSON.stringify({ ...request, stream: false }),
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
      body: JSON.stringify({ ...request, stream: true }),
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
