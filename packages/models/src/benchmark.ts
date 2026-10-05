/**
 * Hardware probe + VRAM-budget model recommendations (Angen).
 *
 * Target reference: NVIDIA RTX 4060 Laptop GPU (8 GB VRAM).
 * Recommendations are budget-based — this Linux box may have no GPU;
 * we do not claim live GPU benchmarks ran here.
 *
 * Live tokens/sec + vision UI bench belong on DESKTOP-J47PDQK (Windows RTX 4060).
 * Do not ollama pull large models on this ~2GB-free Linux box.
 */
import { cpus, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatCompletionRequest, TaskClass } from "@calypso/shared";

const execFileAsync = promisify(execFile);

export interface HardwareProfile {
  cpuCores: number;
  totalMemoryGb: number;
  gpuName?: string;
  /** Total GPU VRAM in GiB when detectable. */
  vramGb?: number;
  /** True when nvidia-smi (or equivalent) reported a GPU. */
  gpuDetected: boolean;
  estimatedTokensPerSec?: number;
}

export interface ModelRouteRecommendation {
  providerId: string;
  model: string;
  /** Estimated resident VRAM for Q4-ish local weights, MB. */
  estimatedVramMb?: number;
  notes?: string;
}

export type TaskClassRoutes = Record<TaskClass, ModelRouteRecommendation>;

/** Soft VRAM budget for an 8 GB laptop GPU (leave ~1 GB for driver/desktop). */
export const VRAM_BUDGET_MB = 7000;

/**
 * Approximate resident footprints (MB) for common Ollama tags at Q4/Q4_K_M.
 * Used for co-residency checks and first-run download planning — not measured
 * on this machine.
 *
 * qwen3:8b ≈ 5.2 GB (ollama.com/library/qwen3).
 * qwen2.5vl:3b ≈ 3.2 GB (ollama.com/library/qwen2.5vl:3b).
 * qwen2-vl:2b is NOT in the Ollama library — do not recommend it.
 */
export const MODEL_FOOTPRINTS_MB: Readonly<Record<string, number>> = {
  "qwen2.5:0.5b": 400,
  "qwen3:0.6b": 500,
  "llama3.2:1b": 1300,
  "llama3.2:3b": 2200,
  "qwen2.5:3b": 2200,
  "qwen3:4b": 2600,
  "qwen2.5:7b": 4700,
  "qwen2.5:7b-instruct-q4_K_M": 4700,
  "qwen2.5-coder:7b": 4700,
  "qwen3:8b": 5200,
  "qwen2.5vl:3b": 3200,
  moondream: 1700,
  "minicpm-v": 2300,
  "deepseek-r1:7b": 4700,
  "deepseek-r1:8b": 5200,
  "nomic-embed-text": 274,
  /** Intentionally huge — never recommend on 8 GB. */
  "llama3.1:70b": 40000,
};

/**
 * Documented default routes for RTX 4060 Laptop 8 GB.
 *
 * Resident primary: `qwen3:8b` for normal / code / reasoning (one load).
 * - normal/code: think:false (Ollama thinking off)
 * - reasoning: think:true at request time via thinkingEnabledForTaskClass
 * - code optional alternate: qwen2.5-coder:7b pending Windows RTX 4060 bench
 *
 * Vision: `qwen2.5vl:3b` — hard-swap unload before load; not co-resident with 8B.
 * Frontier is cloud-only on this budget — never a local 70B.
 */
export const DEFAULT_RTX_4060_8GB_ROUTES: TaskClassRoutes = {
  simple: {
    providerId: "ollama",
    model: "qwen2.5:0.5b",
    estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen2.5:0.5b"],
    notes: "Very fast micro-model for classification / trivial replies.",
  },
  normal: {
    providerId: "ollama",
    model: "qwen3:8b",
    estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen3:8b"],
    notes: "Resident primary (~5.2 GB); think:false for normal chat.",
  },
  code: {
    providerId: "ollama",
    model: "qwen3:8b",
    estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen3:8b"],
    notes:
      "Same resident qwen3:8b (no second load); think:false. Optional alternate qwen2.5-coder:7b pending Windows RTX 4060 bench if it clearly wins.",
  },
  vision: {
    providerId: "ollama",
    model: "qwen2.5vl:3b",
    estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen2.5vl:3b"],
    notes:
      "Hard-swap unload before load; not co-resident with qwen3:8b. Soft swap via SharedInferenceServer / OllamaAdmin keep_alive=0.",
  },
  reasoning: {
    providerId: "ollama",
    model: "qwen3:8b",
    estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen3:8b"],
    notes:
      "Same resident qwen3:8b; enable think:true at request time (Ollama thinking).",
  },
  frontier: {
    providerId: "openai",
    model: "gpt-4o",
    notes: "Cloud frontier placeholder. Never map frontier → local 70B on 8 GB.",
  },
};

/**
 * Whether Ollama thinking should be enabled for this task class.
 * Only reasoning uses think:true; normal/code keep thinking off on the same model.
 */
export function thinkingEnabledForTaskClass(taskClass: TaskClass): boolean {
  return taskClass === "reasoning";
}

/**
 * Attach Ollama `think` (and preserve other fields) based on TaskClass.
 * Providers that ignore unknown fields stay compatible.
 */
export function buildCompletionRequest(
  base: ChatCompletionRequest,
  taskClass: TaskClass
): ChatCompletionRequest {
  return {
    ...base,
    think: thinkingEnabledForTaskClass(taskClass),
  };
}

async function probeNvidiaSmi(): Promise<{ name: string; vramGb: number } | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000, windowsHide: true }
    );
    const line = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!line) return null;
    // e.g. "NVIDIA GeForce RTX 4060 Laptop GPU, 8188"
    const comma = line.lastIndexOf(",");
    if (comma < 0) return null;
    const name = line.slice(0, comma).trim();
    const mb = Number.parseFloat(line.slice(comma + 1).trim());
    if (!name || !Number.isFinite(mb) || mb <= 0) return null;
    return { name, vramGb: Math.round((mb / 1024) * 10) / 10 };
  } catch {
    return null;
  }
}

/**
 * Probe local hardware. Uses nvidia-smi when available; always fills CPU/RAM
 * from Node `os`. Graceful when no GPU (typical CI / this Linux box).
 */
export async function probeHardware(): Promise<HardwareProfile> {
  const cpuList = cpus();
  const profile: HardwareProfile = {
    cpuCores: cpuList.length || 1,
    totalMemoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    gpuDetected: false,
  };

  const gpu = await probeNvidiaSmi();
  if (gpu) {
    profile.gpuName = gpu.name;
    profile.vramGb = gpu.vramGb;
    profile.gpuDetected = true;
  }

  return profile;
}

function cloudFrontier(): ModelRouteRecommendation {
  return {
    providerId: "openai",
    model: "gpt-4o",
    notes: "Cloud frontier placeholder (also valid: anthropic / claude-sonnet-4-5).",
  };
}

/**
 * Recommend TaskClass → provider/model routes from a hardware profile.
 * Scales down when VRAM is below the 8 GB target; CPU-only falls back to
 * tiny local models + cloud frontier.
 */
export function recommendTaskClassRoutes(profile: HardwareProfile): TaskClassRoutes {
  const vramGb = profile.vramGb ?? 0;
  const hasGpu = profile.gpuDetected && vramGb > 0;

  // ~8 GB+ laptop / desktop — full DEFAULT_RTX_4060_8GB_ROUTES
  if (hasGpu && vramGb >= 7.5) {
    return { ...DEFAULT_RTX_4060_8GB_ROUTES };
  }

  // Mid VRAM (4–7.4 GB): qwen3:8b if ≥6 GB, else qwen3:4b; same model for N/C/R
  if (hasGpu && vramGb >= 4) {
    const use8b = vramGb >= 6;
    const primary = use8b ? "qwen3:8b" : "qwen3:4b";
    return {
      simple: {
        providerId: "ollama",
        model: "qwen2.5:0.5b",
        estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen2.5:0.5b"],
      },
      normal: {
        providerId: "ollama",
        model: primary,
        estimatedVramMb: MODEL_FOOTPRINTS_MB[primary],
        notes: `Resident primary for ~${vramGb} GB VRAM; think:false.`,
      },
      code: {
        providerId: "ollama",
        model: primary,
        estimatedVramMb: MODEL_FOOTPRINTS_MB[primary],
        notes:
          "Same resident model (no second load). Optional alternate qwen2.5-coder:7b pending Windows bench.",
      },
      vision: {
        providerId: "ollama",
        model: "qwen2.5vl:3b",
        estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen2.5vl:3b"],
        notes: "Hard-swap unload before load; not co-resident with the text primary.",
      },
      reasoning: {
        providerId: "ollama",
        model: primary,
        estimatedVramMb: MODEL_FOOTPRINTS_MB[primary],
        notes: "Same resident model; enable think:true at request time.",
      },
      frontier: cloudFrontier(),
    };
  }

  // Low VRAM (<4 GB) or CPU-only
  const cpuNote = hasGpu
    ? `Low VRAM (~${vramGb} GB): tiny local models only.`
    : "No GPU detected: CPU-friendly tiny models; prefer cloud for quality.";

  return {
    simple: {
      providerId: "ollama",
      model: "qwen2.5:0.5b",
      estimatedVramMb: MODEL_FOOTPRINTS_MB["qwen2.5:0.5b"],
      notes: cpuNote,
    },
    normal: {
      providerId: "ollama",
      model: "llama3.2:1b",
      estimatedVramMb: MODEL_FOOTPRINTS_MB["llama3.2:1b"],
      notes: cpuNote,
    },
    code: {
      providerId: "ollama",
      model: "llama3.2:1b",
      estimatedVramMb: MODEL_FOOTPRINTS_MB["llama3.2:1b"],
      notes: cpuNote,
    },
    vision: {
      providerId: "ollama",
      model: "moondream",
      estimatedVramMb: MODEL_FOOTPRINTS_MB.moondream,
      notes: "Smallest practical VL; may be slow on CPU. Prefer qwen2.5vl:3b when VRAM allows.",
    },
    reasoning: {
      providerId: "ollama",
      model: "llama3.2:1b",
      estimatedVramMb: MODEL_FOOTPRINTS_MB["llama3.2:1b"],
      notes: cpuNote,
    },
    frontier: cloudFrontier(),
  };
}
