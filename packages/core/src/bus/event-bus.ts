import type { CalypsoEvent, CalypsoEventType, EventBus } from "@calypso/shared";

/** Simple in-process event bus. Main process will also bridge this to IPC. */
export class InProcessEventBus implements EventBus {
  private handlers = new Set<(event: CalypsoEvent) => void>();
  private typed = new Map<string, Set<(event: CalypsoEvent) => void>>();

  publish(event: CalypsoEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        /* swallow subscriber errors */
      }
    }
    const set = this.typed.get(event.type);
    if (set) {
      for (const h of set) {
        try {
          h(event);
        } catch {
          /* swallow */
        }
      }
    }
  }

  subscribe(handler: (event: CalypsoEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeType<T extends CalypsoEventType>(
    type: T,
    handler: (event: Extract<CalypsoEvent, { type: T }>) => void
  ): () => void {
    let set = this.typed.get(type);
    if (!set) {
      set = new Set();
      this.typed.set(type, set);
    }
    const wrapped = handler as (event: CalypsoEvent) => void;
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }
}
