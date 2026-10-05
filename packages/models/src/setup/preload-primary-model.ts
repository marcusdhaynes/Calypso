/**
 * Preload the resident primary chat model into Ollama VRAM with a long keep_alive.
 *
 * Tyran measured qwen3:8b ~45 tok/s / ~0.4s TTFT once loaded, but ~34s first load.
 * Call this on Calypso start so Theriz can show a warming banner (models.runtime.progress
 * phase "starting" → "ready") and grey the composer until the model is resident.
 *
 * keep_alive: Ollama's OpenAI-compatible /v1 chat API does NOT accept keep_alive.
 * Residence is maintained by this native /api/generate warmup (and optional
 * fire-and-forget refresh after SharedInferenceServer complete/stream).
 *
 * num_ctx: OllamaAdmin.warmup pins DEFAULT_NUM_CTX (8192) so the resident
 * KV cache matches OpenAICompatibleProvider chat requests.
 */
import type {
  InferenceRuntimeProgress,
  InferenceRuntimeStatus,
} from "@calypso/shared";
import { DEFAULT_RTX_4060_8GB_ROUTES } from "../benchmark.js";
import { OllamaAdmin } from "../inference/shared-server.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  type InferenceRuntimeEventSink,
} from "./ensure-inference-runtime.js";

/** Default keep_alive for the resident primary — long enough to survive idle UI. */
export const PRIMARY_MODEL_KEEP_ALIVE = "24h";

export interface PreloadPrimaryModelOptions {
  bus?: InferenceRuntimeEventSink;
  /** Also called for every progress update (in addition to bus). */
  onProgress?: (progress: InferenceRuntimeProgress) => void;
  /** Override primary model. Default DEFAULT_RTX_4060_8GB_ROUTES.normal.model. */
  model?: string;
  /** Ollama keep_alive duration. Default "24h". */
  keepAlive?: string;
  /** Native Ollama base URL (not /v1). Default OLLAMA_HOST or http://127.0.0.1:11434. */
  baseUrl?: string;
  signal?: AbortSignal;
}

function resolveBaseUrl(baseUrl?: string): string {
  let url = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_BASE_URL;
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function normalizeModel(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

async function probeTags(
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ reachable: boolean; models: string[]; version?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctl.signal });
    if (!res.ok) return { reachable: false, models: [] };
    const tags = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = (tags.models ?? [])
      .map((m) => m.name ?? m.model ?? "")
      .filter(Boolean)
      .map(normalizeModel);
    let version: string | undefined;
    try {
      const verRes = await fetch(`${baseUrl}/api/version`, { signal: ctl.signal });
      if (verRes.ok) {
        const ver = (await verRes.json()) as { version?: string };
        version = ver.version;
      }
    } catch {
      /* optional */
    }
    return { reachable: true, models, version };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Warm the primary local model into VRAM with a long keep_alive.
 * Concurrent callers share one in-flight run. Never throws for Ollama-down /
 * model-missing — emits phase "error" and returns so app startup is safe.
 * Only AbortSignal abort rejects.
 */
export async function preloadPrimaryModel(
  opts: PreloadPrimaryModelOptions = {},
): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runPreload(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runPreload(opts: PreloadPrimaryModelOptions): Promise<void> {
  const model = opts.model ?? DEFAULT_RTX_4060_8GB_ROUTES.normal.model;
  const keepAlive = opts.keepAlive ?? PRIMARY_MODEL_KEEP_ALIVE;
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const { signal, bus } = opts;

  const report = (progress: InferenceRuntimeProgress) => {
    opts.onProgress?.(progress);
    bus?.publish({ type: "models.runtime.progress", progress, at: Date.now() });
  };

  signal?.throwIfAborted();
  report({
    phase: "starting",
    model,
    message: `Warming up ${model}…`,
  });

  const probe = await probeTags(baseUrl, 2000, signal);
  if (!probe.reachable) {
    report({
      phase: "error",
      model,
      message: `Cannot warm ${model}: Ollama is not reachable at ${baseUrl}.`,
    });
    return;
  }

  const present = probe.models.includes(normalizeModel(model));
  if (!present) {
    report({
      phase: "error",
      model,
      message: `${model} is not pulled yet. Run ensureInferenceRuntime first, then retry preload.`,
    });
    return;
  }

  try {
    signal?.throwIfAborted();
    const admin = new OllamaAdmin({ baseUrl, keepAlive });
    await admin.warmup(model);
  } catch (err) {
    if (signal?.aborted) {
      report({ phase: "error", model, message: "Primary model preload aborted" });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    report({
      phase: "error",
      model,
      message: `Failed to warm ${model}: ${msg}`,
    });
    return;
  }

  const status: InferenceRuntimeStatus = {
    state: "ready",
    baseUrl,
    ollamaReachable: true,
    version: probe.version,
    requiredModels: [model],
    presentModels: [model],
    missingModels: [],
    message: `${model} loaded and kept alive (${keepAlive}).`,
  };
  report({ phase: "ready", percent: 100, model, message: status.message });
  bus?.publish({ type: "models.runtime.ready", status, at: Date.now() });
}
