import type { ToolCall, WorkerId } from "@calypso/shared";
import { Button } from "./Button.js";
import { colors, radii, shadows, space } from "../theme/tokens.js";

export interface PermissionToastProps {
  requestId: string;
  workerId: WorkerId;
  workerName?: string;
  toolCall: ToolCall;
  reason: string;
  onAllow: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function PermissionToast({
  requestId,
  workerId,
  workerName,
  toolCall,
  reason,
  onAllow,
  onDeny,
}: PermissionToastProps) {
  return (
    <div
      role="alertdialog"
      aria-label="Permission request"
      className="cal-fade-in"
      style={{
        position: "fixed",
        right: space[10],
        bottom: space[10],
        zIndex: 400,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        padding: space[8],
        borderRadius: radii.xl,
        background: colors.overlay,
        border: `1px solid ${colors.borderStrong}`,
        boxShadow: shadows.lg,
        display: "flex",
        flexDirection: "column",
        gap: space[6],
      }}
    >
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: colors.warning }}>
          Approval needed
        </div>
        <div style={{ marginTop: 4, fontWeight: 600, color: colors.textPrimary }}>
          {workerName ?? workerId} wants to run{" "}
          <span style={{ fontFamily: "var(--cal-font-mono)", color: colors.accent }}>{toolCall.toolName}</span>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13, color: colors.textSecondary, lineHeight: 1.45 }}>{reason}</p>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: space[3] }}>
        <Button size="sm" variant="ghost" onClick={() => onDeny(requestId)}>
          Deny
        </Button>
        <Button size="sm" variant="primary" onClick={() => onAllow(requestId)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
