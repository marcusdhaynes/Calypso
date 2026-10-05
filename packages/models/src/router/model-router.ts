import type { ModelProvider, ModelRouter, TaskClass } from "@calypso/shared";

interface Route {
  providerId: string;
  model: string;
}

/**
 * Picks a model by TaskClass. Workers may override via preferredModel
 * (either a TaskClass name or "providerId/model" string).
 */
export class DefaultModelRouter implements ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private routes = new Map<TaskClass, Route>();

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  setRoute(taskClass: TaskClass, providerId: string, model: string): void {
    this.routes.set(taskClass, { providerId, model });
  }

  async resolve(
    taskClass: TaskClass,
    preferredModel?: string
  ): Promise<{ provider: ModelProvider; model: string }> {
    if (preferredModel?.includes("/")) {
      const [providerId, ...rest] = preferredModel.split("/");
      const model = rest.join("/");
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
    const provider = this.providers.get(route.providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${route.providerId}`);
    }
    return { provider, model: route.model };
  }
}
