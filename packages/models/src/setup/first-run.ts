/**
 * First-run inference planning for Theriz's setup UI (no UI code here).
 * Combines hardware probe recommendations with download size estimates.
 */
import type { TaskClass } from "@calypso/shared";
import {
  DEFAULT_RTX_4060_8GB_ROUTES,
  MODEL_FOOTPRINTS_MB,
  VRAM_BUDGET_MB,
  recommendTaskClassRoutes,
  type HardwareProfile,
  type ModelRouteRecommendation,
  type TaskClassRoutes,
} from "../benchmark.js";
import {
  DEFAULT_LOCAL_EMBED_DIMENSIONS,
  DEFAULT_LOCAL_EMBED_MODEL,
} from "../embeddings/embedding-provider.js";

export interface ModelDownloadPlan {
  providerId: string;
  model: string;
  /** Approximate download / on-disk size in MB (weights ≈ footprint for Q4). */
  estimatedDownloadMb: number;
  /** Task classes that reference this model. */
  usedBy: TaskClass[];
  purpose: string;
}

export interface FirstRunInferencePlan {
  profile: HardwareProfile;
  gpuDetected: boolean;
  vramBudgetMb: number;
  routes: TaskClassRoutes;
  /** Documented RTX 4060 8 GB reference table (for UI comparison). */
  referenceRtx4060Routes: TaskClassRoutes;
  modelsToDownload: ModelDownloadPlan[];
  embedding: {
    model: string;
    dimensions: number;
    estimatedDownloadMb: number;
    preferCpu: boolean;
    notes: string;
  };
  maxConcurrentSuggestion: number;
  notes: string[];
  visionSwapPolicy: string;
}

const TASK_PURPOSE: Record<TaskClass, string> = {
  simple: "Fast trivial / classification replies",
  normal: "Primary interactive brain",
  code: "Code generation and repair",
  vision: "Image understanding (qwen2.5vl:3b; hard-swap with 8B)",
  reasoning: "Harder multi-step reasoning (qwen3:8b + think:true)",
  frontier: "Optional cloud frontier quality",
};

function estimateMb(model: string): number {
  return MODEL_FOOTPRINTS_MB[model] ?? 4000;
}

/**
 * Build a first-run inference plan from a hardware profile (already probed).
 */
export function planFirstRunInference(profile: HardwareProfile): FirstRunInferencePlan {
  const routes = recommendTaskClassRoutes(profile);
  const notes: string[] = [];

  if (!profile.gpuDetected) {
    notes.push(
      "No NVIDIA GPU detected via nvidia-smi. Local models will run on CPU; expect lower tokens/sec. Cloud frontier remains available for quality."
    );
  } else {
    notes.push(
      `GPU detected: ${profile.gpuName ?? "unknown"}` +
        (profile.vramGb != null ? ` (~${profile.vramGb} GB VRAM).` : ".")
    );
    if ((profile.vramGb ?? 0) < 7.5) {
      notes.push(
        "VRAM below the 8 GB RTX 4060 Laptop target — routes scaled down. Do not pull 70B weights."
      );
    }
  }

  notes.push(
    `System: ${profile.cpuCores} CPU cores, ${profile.totalMemoryGb} GB RAM.`
  );

  const byModel = new Map<string, ModelDownloadPlan>();

  const consider = (task: TaskClass, rec: ModelRouteRecommendation) => {
    if (rec.providerId === "openai" || rec.providerId === "anthropic") {
      notes.push(
        `Frontier route uses cloud provider "${rec.providerId}" model "${rec.model}" — no local download.`
      );
      return;
    }
    const key = `${rec.providerId}::${rec.model}`;
    const existing = byModel.get(key);
    if (existing) {
      if (!existing.usedBy.includes(task)) existing.usedBy.push(task);
      return;
    }
    byModel.set(key, {
      providerId: rec.providerId,
      model: rec.model,
      estimatedDownloadMb: rec.estimatedVramMb ?? estimateMb(rec.model),
      usedBy: [task],
      purpose: TASK_PURPOSE[task],
    });
  };

  (Object.keys(routes) as TaskClass[]).forEach((task) => {
    consider(task, routes[task]);
  });

  // Always recommend local embeddings for Anky memory.
  const embedMb = MODEL_FOOTPRINTS_MB[DEFAULT_LOCAL_EMBED_MODEL] ?? 274;

  const visionSwapPolicy =
    "On ≤8 GB VRAM, keep qwen3:8b resident for normal/code/reasoning (think:true only " +
    "for reasoning). Soft-swap unload before loading qwen2.5vl:3b for vision — do not " +
    "co-reside VL with the 8B. SharedInferenceServer / OllamaAdmin keep_alive=0 handles " +
    "the unload. Optional code alternate qwen2.5-coder:7b pending Windows RTX 4060 bench.";

  notes.push(visionSwapPolicy);
  notes.push(
    "Default local runtime assumption: Ollama (OpenAI-compatible /v1). llama.cpp server is also supported via createLlamaCppProvider."
  );

  const maxConcurrentSuggestion = profile.gpuDetected ? 1 : Math.min(2, Math.max(1, Math.floor(profile.cpuCores / 4)));

  return {
    profile,
    gpuDetected: profile.gpuDetected,
    vramBudgetMb: VRAM_BUDGET_MB,
    routes,
    referenceRtx4060Routes: { ...DEFAULT_RTX_4060_8GB_ROUTES },
    modelsToDownload: [...byModel.values()],
    embedding: {
      model: DEFAULT_LOCAL_EMBED_MODEL,
      dimensions: DEFAULT_LOCAL_EMBED_DIMENSIONS,
      estimatedDownloadMb: embedMb,
      preferCpu: true,
      notes:
        "nomic-embed-text is small and CPU-friendly so chat GPU VRAM is not stolen.",
    },
    maxConcurrentSuggestion,
    notes,
    visionSwapPolicy,
  };
}
