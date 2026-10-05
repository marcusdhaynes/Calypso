/**
 * Frontier / cloud-models settings helpers (Angen).
 * Pure normalization — persistence lives in core meta + desktop IPC.
 */
import {
  DEFAULT_FRONTIER_BASE_URL,
  DEFAULT_FRONTIER_MODEL_ID,
  defaultCalypsoSettings,
  type CalypsoSettings,
  type CalypsoSettingsUpdate,
} from "@calypso/shared";
import { resolveOpenAIApiKey } from "../providers/openai-compatible.js";

/** Stored shape in SQLite meta (may include apiKey; never returned raw over IPC). */
export interface PersistedCalypsoSettings {
  cloudModelsEnabled?: boolean;
  frontier?: {
    enabled?: boolean;
    baseUrl?: string;
    modelId?: string;
    apiKey?: string;
  };
}

export function hasCloudApiKeyAvailable(storedApiKey?: string): boolean {
  return !!resolveOpenAIApiKey(storedApiKey);
}

/**
 * Merge persisted + update into a public CalypsoSettings view (no raw key).
 * Keeps `cloudModelsEnabled` and `frontier.enabled` in sync.
 */
export function toPublicSettings(
  persisted: PersistedCalypsoSettings | null | undefined,
  update?: CalypsoSettingsUpdate
): { public: CalypsoSettings; stored: PersistedCalypsoSettings } {
  const base = defaultCalypsoSettings();
  const prev = persisted ?? {};
  const nextEnabled =
    update?.cloudModelsEnabled ??
    update?.frontier?.enabled ??
    prev.cloudModelsEnabled ??
    prev.frontier?.enabled ??
    base.cloudModelsEnabled;

  let nextApiKey = prev.frontier?.apiKey;
  if (update?.frontier && "apiKey" in update.frontier) {
    const raw = update.frontier.apiKey;
    nextApiKey = raw && raw.trim() ? raw.trim() : undefined;
  }

  const stored: PersistedCalypsoSettings = {
    cloudModelsEnabled: !!nextEnabled,
    frontier: {
      enabled: !!nextEnabled,
      baseUrl:
        update?.frontier?.baseUrl?.trim() ||
        prev.frontier?.baseUrl ||
        DEFAULT_FRONTIER_BASE_URL,
      modelId:
        update?.frontier?.modelId?.trim() ||
        prev.frontier?.modelId ||
        DEFAULT_FRONTIER_MODEL_ID,
      ...(nextApiKey ? { apiKey: nextApiKey } : {}),
    },
  };

  const pub: CalypsoSettings = {
    cloudModelsEnabled: !!stored.cloudModelsEnabled,
    frontier: {
      enabled: !!stored.frontier?.enabled,
      baseUrl: stored.frontier?.baseUrl ?? DEFAULT_FRONTIER_BASE_URL,
      modelId: stored.frontier?.modelId ?? DEFAULT_FRONTIER_MODEL_ID,
    },
    hasCloudApiKey: hasCloudApiKeyAvailable(stored.frontier?.apiKey),
  };

  return { public: pub, stored };
}
