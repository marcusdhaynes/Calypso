/**
 * First-run local inference runtime (Angen) — mirrors Spin's ensureBrowserRuntime.
 *
 * 1. Detect Ollama (GET /api/tags). If the server is down but an `ollama` binary
 *    is on disk, start `ollama serve` as the current user (no sudo) and wait.
 * 2. If Ollama is missing entirely: report phase "install" + platform installUrl
 *    and return state "notInstalled". We never attempt a silent system-wide
 *    install — the first-run UI should open installUrl for the user.
 *    (A portable Ollama in userData, like Chromium, is not straightforward:
 *    the Windows/Linux bundles are 1–2 GB with GPU runtimes and need the
 *    service lifecycle. Revisit later if needed.)
 * 3. When up: planFirstRunInference(profile ?? probeHardware()), then POST
 *    /api/pull (streaming NDJSON) for each missing local model + the
 *    embedding model, mapping bytes to an overall weighted percent.
 * 4. Publish `models.runtime.ready` once every required model is present.
 *
 * Events published on `bus` (same shape as browser.runtime.*):
 *   { type: "models.runtime.progress", progress: { phase, percent?, message, model? }, at }
 *   { type: "models.runtime.ready",    status: InferenceRuntimeStatus, at }
 *
 * Errors are reported as progress phase "error" and a returned status with
 * state "error" (UI-friendly); only an AbortSignal abort rejects.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type {
  CalypsoEvent,
  InferenceRuntimeProgress,
  InferenceRuntimeStatus,
} from "@calypso/shared";
import { probeHardware, type HardwareProfile } from "../benchmark.js";
import { planFirstRunInference, type FirstRunInferencePlan } from "./first-run.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** Anything with a publish(event) — EventBus or a forwarding shim. */
export interface InferenceRuntimeEventSink {
  publish(event: CalypsoEvent): void;
}

export interface InferenceRuntimeOptions {
  bus?: InferenceRuntimeEventSink;
  /** Also called for every progress update (in addition to bus). */
  onProgress?: (progress: InferenceRuntimeProgress) => void;
  profile?: HardwareProfile;
  /** Precomputed plan; overrides profile. */
  plan?: FirstRunInferencePlan;
  signal?: AbortSignal;
  /** Native Ollama base URL. Default OLLAMA_HOST or http://127.0.0.1:11434. */
  baseUrl?: string;
  /**
   * Skip model pulls (detect/status only). Defaults to
   * process.env.CALYPSO_SKIP_MODEL_PULL === "1".
   */
  skipPull?: boolean;
  /** Start `ollama serve` when the binary exists but the server is down. Default true. */
  autoStartServer?: boolean;
  /** How long to wait for a spawned `ollama serve` to answer. Default 20000 ms. */
  startTimeoutMs?: number;
}

export interface InferenceRuntimeStatusOptions {
  baseUrl?: string;
  profile?: HardwareProfile;
  plan?: FirstRunInferencePlan;
  /** Probe timeout. Default 2000 ms. */
  timeoutMs?: number;
}

function resolveBaseUrl(baseUrl?: string): string {
  let url = baseUrl ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_BASE_URL;
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Platform installer / download page for Ollama. */
export function ollamaInstallUrl(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "https://ollama.com/download/OllamaSetup.exe";
  if (platform === "darwin") return "https://ollama.com/download/Ollama.dmg";
  return "https://ollama.com/download/linux";
}

/** Locate an `ollama` binary on PATH or the default per-user install dirs. */
export function findOllamaBinary(): string | undefined {
  const isWin = process.platform === "win32";
  const names = isWin ? ["ollama.exe"] : ["ollama"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (isWin && process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, "Programs", "Ollama"));
  }
  if (process.platform === "darwin") {
    dirs.push("/Applications/Ollama.app/Contents/Resources", "/usr/local/bin", "/opt/homebrew/bin");
  }
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Ollama tags default to ":latest" — compare normalized names. */
function normalizeModel(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

async function fetchJson<T>(url: string, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

interface OllamaProbe {
  reachable: boolean;
  models: string[];
  version?: string;
}

async function probeOllama(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<OllamaProbe> {
  const tags = await fetchJson<{ models?: Array<{ name?: string; model?: string }> }>(
    `${baseUrl}/api/tags`,
    timeoutMs,
    signal,
  );
  if (!tags) return { reachable: false, models: [] };
  const models = (tags.models ?? [])
    .map((m) => m.name ?? m.model ?? "")
    .filter(Boolean)
    .map(normalizeModel);
  const ver = await fetchJson<{ version?: string }>(`${baseUrl}/api/version`, timeoutMs, signal);
  return { reachable: true, models, version: ver?.version };
}

/** Planned local models (chat + embedding), Ollama tags, de-duplicated. */
export function requiredModelsForPlan(plan: FirstRunInferencePlan): string[] {
  const out = new Set<string>();
  for (const m of plan.modelsToDownload) {
    if (m.providerId === "ollama" || m.providerId === "llamacpp" || m.providerId === "local") {
      out.add(m.model);
    }
  }
  out.add(plan.embedding.model);
  return [...out];
}

function estimatedMbFor(plan: FirstRunInferencePlan, model: string): number {
  if (model === plan.embedding.model) return plan.embedding.estimatedDownloadMb;
  return plan.modelsToDownload.find((m) => m.model === model)?.estimatedDownloadMb ?? 4000;
}

function buildStatus(
  baseUrl: string,
  probe: OllamaProbe,
  required: string[],
  binaryPath: string | undefined,
): InferenceRuntimeStatus {
  const present = new Set(probe.models);
  const presentModels = required.filter((m) => present.has(normalizeModel(m)));
  const missingModels = required.filter((m) => !present.has(normalizeModel(m)));
  if (!probe.reachable) {
    if (!binaryPath) {
      return {
        state: "notInstalled",
        baseUrl,
        ollamaReachable: false,
        requiredModels: required,
        presentModels: [],
        missingModels: required,
        installUrl: ollamaInstallUrl(),
        message: `Ollama is not installed (no server at ${baseUrl} and no ollama binary found). Install Ollama, then retry.`,
      };
    }
    return {
      state: "error",
      baseUrl,
      ollamaReachable: false,
      binaryPath,
      requiredModels: required,
      presentModels: [],
      missingModels: required,
      message: `Ollama is installed (${binaryPath}) but the server at ${baseUrl} is not responding.`,
    };
  }
  const ready = missingModels.length === 0;
  return {
    state: ready ? "ready" : "needsModels",
    baseUrl,
    ollamaReachable: true,
    binaryPath,
    version: probe.version,
    requiredModels: required,
    presentModels,
    missingModels,
    message: ready
      ? `Ollama${probe.version ? ` ${probe.version}` : ""} ready with all ${required.length} planned models.`
      : `Ollama running; ${missingModels.length} planned model(s) not pulled: ${missingModels.join(", ")}.`,
  };
}

async function resolvePlan(opts: { plan?: FirstRunInferencePlan; profile?: HardwareProfile }) {
  return opts.plan ?? planFirstRunInference(opts.profile ?? (await probeHardware()));
}

/** Quick probe: is Ollama up, and which planned models are present? Never pulls. */
export async function getInferenceRuntimeStatus(
  opts: InferenceRuntimeStatusOptions = {},
): Promise<InferenceRuntimeStatus> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const [plan, probe] = await Promise.all([
    resolvePlan(opts),
    probeOllama(baseUrl, opts.timeoutMs ?? 2000),
  ]);
  const status = buildStatus(baseUrl, probe, requiredModelsForPlan(plan), findOllamaBinary());
  if (inFlight && status.ollamaReachable && status.state !== "ready") status.state = "pulling";
  return status;
}

let inFlight: Promise<InferenceRuntimeStatus> | null = null;

/**
 * Ensure Ollama is reachable and every planned model is pulled.
 * Concurrent callers share one in-flight run.
 */
export async function ensureInferenceRuntime(
  opts: InferenceRuntimeOptions = {},
): Promise<InferenceRuntimeStatus> {
  if (inFlight) return inFlight;
  inFlight = runEnsure(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runEnsure(opts: InferenceRuntimeOptions): Promise<InferenceRuntimeStatus> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const { signal, bus } = opts;
  const skipPull = opts.skipPull ?? process.env.CALYPSO_SKIP_MODEL_PULL === "1";

  const report = (progress: InferenceRuntimeProgress) => {
    opts.onProgress?.(progress);
    bus?.publish({ type: "models.runtime.progress", progress, at: Date.now() });
  };
  const fail = (status: InferenceRuntimeStatus): InferenceRuntimeStatus => {
    report({ phase: "error", message: status.message });
    return status;
  };

  signal?.throwIfAborted();
  report({ phase: "checking", message: "Checking local inference runtime (Ollama)…" });

  const plan = await resolvePlan(opts);
  const required = requiredModelsForPlan(plan);
  const binaryPath = findOllamaBinary();
  let probe = await probeOllama(baseUrl, 2000, signal);

  // Binary present but server down → start it as the current user.
  if (!probe.reachable && binaryPath && opts.autoStartServer !== false) {
    report({ phase: "starting", message: "Starting Ollama server…" });
    probe = await startOllamaServer(binaryPath, baseUrl, opts.startTimeoutMs ?? 20000, signal);
  }

  let status = buildStatus(baseUrl, probe, required, binaryPath);

  if (status.state === "notInstalled") {
    report({
      phase: "install",
      message: `Ollama is required for local models. Download it from ${status.installUrl} and run the installer, then retry.`,
    });
    return status;
  }
  if (!probe.reachable) return fail(status);

  if (status.missingModels.length === 0) {
    report({ phase: "ready", percent: 100, message: status.message });
    bus?.publish({ type: "models.runtime.ready", status, at: Date.now() });
    return status;
  }

  if (skipPull) {
    report({
      phase: "pulling",
      percent: 0,
      message: `Skipping model pulls (CALYPSO_SKIP_MODEL_PULL=1). Missing: ${status.missingModels.join(", ")}`,
    });
    return status;
  }

  // Weighted overall percent across all missing models.
  const weights = status.missingModels.map((m) => estimatedMbFor(plan, m));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let doneWeight = 0;

  for (let i = 0; i < status.missingModels.length; i++) {
    const model = status.missingModels[i]!;
    const weight = weights[i]!;
    const label = `(${i + 1}/${status.missingModels.length})`;
    report({
      phase: "pulling",
      percent: Math.floor((doneWeight / totalWeight) * 100),
      model,
      message: `Pulling ${model} ${label}…`,
    });
    try {
      await pullModel(baseUrl, model, signal, (fraction, detail) => {
        const percent = Math.min(99, Math.floor(((doneWeight + fraction * weight) / totalWeight) * 100));
        report({ phase: "pulling", percent, model, message: `Pulling ${model} ${label}: ${detail}` });
      });
    } catch (err) {
      if (signal?.aborted) {
        report({ phase: "error", model, message: "Model pull aborted" });
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const after = buildStatus(baseUrl, await probeOllama(baseUrl, 2000), required, binaryPath);
      return fail({ ...after, state: "error", message: `Failed to pull ${model}: ${msg}` });
    }
    doneWeight += weight;
  }

  status = buildStatus(baseUrl, await probeOllama(baseUrl, 5000, signal), required, binaryPath);
  if (status.state !== "ready") {
    return fail({ ...status, state: "error", message: `Pulls finished but still missing: ${status.missingModels.join(", ")}` });
  }
  report({ phase: "ready", percent: 100, message: status.message });
  bus?.publish({ type: "models.runtime.ready", status, at: Date.now() });
  return status;
}

async function startOllamaServer(
  binaryPath: string,
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaProbe> {
  try {
    const host = new URL(baseUrl).host;
    const child = spawn(binaryPath, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OLLAMA_HOST: host },
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    return { reachable: false, models: [] };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const probe = await probeOllama(baseUrl, 1000, signal);
    if (probe.reachable) return probe;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { reachable: false, models: [] };
}

interface PullLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** POST /api/pull with streaming NDJSON; onProgress gets fraction 0..1 of this model. */
async function pullModel(
  baseUrl: string,
  model: string,
  signal: AbortSignal | undefined,
  onProgress: (fraction: number, detail: string) => void,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  // Layers (digests) download sequentially; aggregate bytes across them.
  const layers = new Map<string, { total: number; completed: number }>();
  let lastPct = -1;
  let sawSuccess = false;
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let msg: PullLine;
    try {
      msg = JSON.parse(line) as PullLine;
    } catch {
      return;
    }
    if (msg.error) throw new Error(msg.error);
    if (msg.status === "success") sawSuccess = true;
    if (msg.digest && msg.total) {
      layers.set(msg.digest, { total: msg.total, completed: msg.completed ?? 0 });
      let total = 0;
      let completed = 0;
      for (const l of layers.values()) {
        total += l.total;
        completed += l.completed;
      }
      const fraction = total > 0 ? completed / total : 0;
      const pct = Math.floor(fraction * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(fraction, `${pct}% (${Math.round(completed / 1e6)}/${Math.round(total / 1e6)} MB)`);
      }
    } else if (msg.status) {
      onProgress(Math.max(0, lastPct) / 100, msg.status);
    }
  };
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  }
  handleLine(buf);
  if (!sawSuccess) throw new Error("pull stream ended without success");
  onProgress(1, "done");
}
