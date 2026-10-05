import type { ModelProvider, ModelRouter, TaskClass } from "@calypso/shared";

interface Route {
  providerId: string;
  model: string;
}

const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic"]);

export type FrontierFallbackReason =
  | "cloud_disabled"
  | "provider_missing"
  | "no_api_key";

export interface DefaultModelRouterOptions {
  /** When false (default), frontier never resolves to a cloud provider. */
  cloudModelsEnabled?: boolean;
  /** Optional sink for silent fallback notes (logs / events). */
  onFrontierFallback?: (info: {
    reason: FrontierFallbackReason;
    message: string;
    taskClass: TaskClass;
  }) => void;
}

function isCloudProviderId(id: string): boolean {
  return CLOUD_PROVIDER_IDS.has(id);
}

/**
 * Picks a model by TaskClass. Workers may override via preferredModel
 * (either a TaskClass name or "providerId/model" string).
 *
 * Cloud frontier is opt-in: when `cloudModelsEnabled` is false (or the
 * openai/anthropic provider is not registered), routes that point at
 * cloud providers silently fall back to the local `normal` route.
 */
export class DefaultModelRouter implements ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private routes = new Map<TaskClass, Route>();
  private cloudModelsEnabled: boolean;
  private onFrontierFallback?: DefaultModelRouterOptions["onFrontierFallback"];

  constructor(opts: DefaultModelRouterOptions = {}) {
    this.cloudModelsEnabled = opts.cloudModelsEnabled ?? false;
    this.onFrontierFallback = opts.onFrontierFallback;
  }

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Unregister a provider (e.g. cloud when the toggle turns off). */
  unregisterProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  setRoute(taskClass: TaskClass, providerId: string, model: string): void {
    this.routes.set(taskClass, { providerId, model });
  }

  /** Master toggle for cloud frontier resolution (default false). */
  setCloudModelsEnabled(enabled: boolean): void {
    this.cloudModelsEnabled = enabled;
  }

  getCloudModelsEnabled(): boolean {
    return this.cloudModelsEnabled;
  }

  setFrontierFallbackHandler(
    handler: DefaultModelRouterOptions["onFrontierFallback"]
  ): void {
    this.onFrontierFallback = handler;
  }

  private noteFallback(
    reason: FrontierFallbackReason,
    taskClass: TaskClass
  ): void {
    const message =
      reason === "cloud_disabled"
        ? "Cloud frontier disabled; falling back to local primary (normal)."
        : reason === "no_api_key"
          ? "Cloud frontier enabled but no API key; falling back to local primary (normal)."
          : "Cloud frontier provider not registered; falling back to local primary (normal).";
    this.onFrontierFallback?.({ reason, message, taskClass });
  }

  private resolveLocalNormal(): { provider: ModelProvider; model: string } {
    const route = this.routes.get("normal");
    if (!route) {
      throw new Error("No model route configured for task class: normal");
    }
    const provider = this.providers.get(route.providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${route.providerId}`);
    }
    return { provider, model: route.model };
  }

  /**
   * Resolve a cloud-bound request, or fall back to local normal.
   * Never throws for missing cloud — chat stays up.
   */
  private resolveCloudOrFallback(
    providerId: string,
    model: string,
    taskClass: TaskClass,
    reasonIfMissing: FrontierFallbackReason = "provider_missing"
  ): { provider: ModelProvider; model: string } {
    if (!this.cloudModelsEnabled) {
      this.noteFallback("cloud_disabled", taskClass);
      return this.resolveLocalNormal();
    }
    const provider = this.providers.get(providerId);
    if (!provider) {
      // Cloud enabled but provider absent almost always means missing API key.
      this.noteFallback(
        reasonIfMissing === "provider_missing" ? "no_api_key" : reasonIfMissing,
        taskClass
      );
      return this.resolveLocalNormal();
    }
    return { provider, model };
  }

  async resolve(
    taskClass: TaskClass,
    preferredModel?: string
  ): Promise<{ provider: ModelProvider; model: string }> {
    if (preferredModel?.includes("/")) {
      const [providerId, ...rest] = preferredModel.split("/");
      const model = rest.join("/");
      if (isCloudProviderId(providerId)) {
        return this.resolveCloudOrFallback(providerId, model, taskClass);
      }
      const provider = this.providers.get(providerId);
      if (provider) return { provider, model };
    }

    const preferredClass = preferredModel as TaskClass | undefined;
    const route =
      (preferredClass && this.routes.get(preferredClass)) ||
      this.routes.get(taskClass) ||
      this.routes.get("normal");

    if (!route) {
      throw new Error(`No model route configured for task class: ${taskClass}`);
    }

    if (isCloudProviderId(route.providerId)) {
      const label: TaskClass =
        preferredClass === "frontier" || taskClass === "frontier"
          ? "frontier"
          : taskClass;
      return this.resolveCloudOrFallback(
        route.providerId,
        route.model,
        label,
        "provider_missing"
      );
    }

    const provider = this.providers.get(route.providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${route.providerId}`);
    }
    return { provider, model: route.model };
  }
}
