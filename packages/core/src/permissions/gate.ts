import type {
  AutonomyLevel,
  PermissionDecision,
  PermissionGate,
  ToolCall,
  ToolClass,
  ToolPermission,
  Worker,
} from "@calypso/shared";
import { DEFAULT_PERMISSION_POLICY } from "@calypso/shared";
import type { InProcessEventBus } from "../bus/event-bus.js";

type Pending = {
  resolve: (allow: boolean) => void;
  workerId: string;
  toolCall: ToolCall;
};

/**
 * Default PermissionGate using AutonomyLevel × ToolClass policy.
 * "ask" decisions publish permission.asked and wait for resolve().
 */
export class DefaultPermissionGate implements PermissionGate {
  private pending = new Map<string, Pending>();
  private overrides = new Map<string, ToolPermission>();

  constructor(private bus: InProcessEventBus) {}

  setOverride(workerId: string, toolClass: ToolClass, permission: ToolPermission): void {
    this.overrides.set(`${workerId}:${toolClass}`, permission);
  }

  lookup(level: AutonomyLevel, toolClass: ToolClass, workerId: string): ToolPermission {
    return (
      this.overrides.get(`${workerId}:${toolClass}`) ??
      DEFAULT_PERMISSION_POLICY[level][toolClass]
    );
  }

  async check(worker: Worker, toolCall: ToolCall): Promise<PermissionDecision> {
    const permission = this.lookup(worker.autonomyLevel, toolCall.toolClass, worker.id);
    if (permission === "allow") return { decision: "allow" };
    if (permission === "deny") {
      return {
        decision: "deny",
        reason: `Policy denies ${toolCall.toolClass} at autonomy=${worker.autonomyLevel}`,
      };
    }
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reason = `Autonomy=${worker.autonomyLevel} requires approval for ${toolCall.toolName} (${toolCall.toolClass})`;
    this.bus.publish({
      type: "permission.asked",
      requestId,
      workerId: worker.id,
      toolCall,
      reason,
      at: Date.now(),
    });
    const allow = await new Promise<boolean>((resolve) => {
      this.pending.set(requestId, { resolve, workerId: worker.id, toolCall });
    });
    this.bus.publish({
      type: "permission.resolved",
      requestId,
      allow,
      at: Date.now(),
    });
    if (!allow) {
      return { decision: "deny", reason: "User denied permission" };
    }
    return { decision: "allow" };
  }

  resolve(requestId: string, allow: boolean): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(allow);
  }
}
