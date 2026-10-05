export {
  OpenAICompatibleProvider,
  createOllamaProvider,
  createLlamaCppProvider,
} from "./providers/openai-compatible.js";
export { DefaultModelRouter } from "./router/model-router.js";
export {
  probeHardware,
  recommendTaskClassRoutes,
  thinkingEnabledForTaskClass,
  buildCompletionRequest,
  VRAM_BUDGET_MB,
  MODEL_FOOTPRINTS_MB,
  DEFAULT_RTX_4060_8GB_ROUTES,
} from "./benchmark.js";
export type {
  HardwareProfile,
  ModelRouteRecommendation,
  TaskClassRoutes,
} from "./benchmark.js";
export {
  SharedInferenceServer,
  OllamaAdmin,
  createSharedInferenceServer,
} from "./inference/shared-server.js";
export type {
  SharedInferenceServerOptions,
  InferenceAdmin,
  OllamaAdminOptions,
} from "./inference/shared-server.js";
export {
  OpenAICompatibleEmbeddingProvider,
  createLocalEmbeddingProvider,
  DEFAULT_LOCAL_EMBED_MODEL,
  DEFAULT_LOCAL_EMBED_DIMENSIONS,
} from "./embeddings/embedding-provider.js";
export type { OpenAICompatibleEmbeddingOptions } from "./embeddings/embedding-provider.js";
export type { EmbeddingProvider } from "@calypso/shared";
export { planFirstRunInference } from "./setup/first-run.js";
export type {
  FirstRunInferencePlan,
  ModelDownloadPlan,
} from "./setup/first-run.js";
