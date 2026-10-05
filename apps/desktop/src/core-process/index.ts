/**
 * Core entrypoint for Electron utilityProcess.
 * Speaks CoreRequest / CoreResponse / CorePush over process.parentPort.
 * Same protocol can later be served over localhost WebSocket
 * (shell-swappable, UI stays responsive).
 */
import { Orchestrator } from "@calypso/core";
import type { CalypsoEvent, CorePush, CoreRequest, CoreResponse } from "@calypso/shared";

const orchestrator = new Orchestrator();

function respond(msg: CoreResponse): void {
  process.parentPort?.postMessage(msg);
}

function push(msg: CorePush): void {
  process.parentPort?.postMessage(msg);
}

orchestrator.bus.subscribe((event: CalypsoEvent) => {
  push({ channel: "event", event });
});

process.parentPort?.on("message", (event) => {
  void handle(event.data as CoreRequest);
});

async function handle(req: CoreRequest): Promise<void> {
  try {
    switch (req.method) {
      case "getAppInfo":
        respond({
          id: req.id,
          ok: true,
          result: { name: "Calypso", version: "0.1.0", platform: process.platform },
        });
        return;
      case "listWorkers":
        respond({ id: req.id, ok: true, result: orchestrator.workers.list() });
        return;
      case "getTaskGraph":
        respond({ id: req.id, ok: true, result: orchestrator.tasks.snapshot() });
        return;
      case "sendMessage": {
        const message = {
          id: `msg_${Date.now()}`,
          conversationId: req.params.conversationId,
          author: { type: "user" as const },
          content: req.params.content,
          createdAt: Date.now(),
        };
        orchestrator.bus.publish({ type: "message.created", message });
        respond({ id: req.id, ok: true, result: message });
        return;
      }
      case "resolvePermission":
        orchestrator.gate.resolve(req.params.requestId, req.params.allow);
        respond({ id: req.id, ok: true, result: null });
        return;
      case "controlCommand":
        orchestrator.bus.publish({
          type: "control.session.command",
          command: req.params.command,
        });
        respond({ id: req.id, ok: true, result: null });
        return;
      default:
        respond({
          id: (req as { id: string }).id,
          ok: false,
          error: `Unknown method`,
        });
    }
  } catch (err) {
    respond({
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
