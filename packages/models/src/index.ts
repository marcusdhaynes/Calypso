export {
  OpenAICompatibleProvider,
  createOllamaProvider,
  createLlamaCppProvider,
  createOpenAICloudProvider,
  resolveOpenAIApiKey,
  DEFAULT_OPENAI_CLOUD_BASE_URL,
} from "./providers/openai-compatible.js";
export type { OpenAICloudProviderOptions } from "./providers/openai-compatible.js";
export { DefaultModelRouter } from "./router/model-router.js";
export type {
  DefaultModelRouterOptions,
  FrontierFallbackReason,
} from "./router/model-router.js";
export {
  toPublicSettings,
  hasCloudApiKeyAvailable,
} from "./frontier/settings.js";
export type { PersistedCalypsoSettings } from "./frontier/settings.js";
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
  DEFAULT_NUM_CTX,
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
export {
  ensureInferenceRuntime,
  getInferenceRuntimeStatus,
  findOllamaBinary,
  ollamaInstallUrl,
  requiredModelsForPlan,
  DEFAULT_OLLAMA_BASE_URL,
} from "./setup/ensure-inference-runtime.js";
export type {
  InferenceRuntimeOptions,
  InferenceRuntimeStatusOptions,
  InferenceRuntimeEventSink,
} from "./setup/ensure-inference-runtime.js";
export {
  preloadPrimaryModel,
  PRIMARY_MODEL_KEEP_ALIVE,
} from "./setup/preload-primary-model.js";
export type { PreloadPrimaryModelOptions } from "./setup/preload-primary-model.js";
export type {
  InferenceRuntimeProgress,
  InferenceRuntimePhase,
  InferenceRuntimeState,
  InferenceRuntimeStatus,
} from "@calypso/shared";
