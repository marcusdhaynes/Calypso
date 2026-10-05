/**
 * Hardware benchmark stub (Angen).
 * Future: probe VRAM, CPU, tokens/sec to recommend local model sizes.
 */
export interface HardwareProfile {
  cpuCores: number;
  totalMemoryGb: number;
  gpuName?: string;
  vramGb?: number;
  estimatedTokensPerSec?: number;
}

export async function probeHardware(): Promise<HardwareProfile> {
  // Stub — real probes (nvidia-smi, systeminformation, etc.) come later.
  return {
    cpuCores: 1,
    totalMemoryGb: 8,
    estimatedTokensPerSec: undefined,
  };
}

export function recommendTaskClassRoutes(
  _profile: HardwareProfile
): Record<string, { providerId: string; model: string }> {
  return {
    simple: { providerId: "ollama", model: "llama3.2:1b" },
    normal: { providerId: "ollama", model: "llama3.2:3b" },
    code: { providerId: "ollama", model: "qwen2.5-coder:7b" },
    vision: { providerId: "ollama", model: "llava:7b" },
    reasoning: { providerId: "ollama", model: "deepseek-r1:8b" },
    frontier: { providerId: "ollama", model: "llama3.1:70b" },
  };
}
