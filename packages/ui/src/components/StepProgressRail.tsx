import type { CSSProperties } from "react";
import { colors, radii, space } from "../theme/tokens.js";

export type StepProgressStatus = "running" | "ok" | "failed";

export interface StepProgressItem {
  toolCallId: string;
  toolName: string;
  workerName?: string;
  message: string;
  status: StepProgressStatus;
  percent?: number;
  error?: string;
}

export interface StepProgressRailProps {
  steps: StepProgressItem[];
  className?: string;
  style?: CSSProperties;
}

const statusColor: Record<StepProgressStatus, string> = {
  running: colors.accent,
  ok: colors.success,
  failed: colors.danger,
};

const statusLabel: Record<StepProgressStatus, string> = {
  running: "Running",
  ok: "Done",
  failed: "Failed",
};

/**
 * Compact step chips for worker tool calls — scaffolding visibility for local reliability.
 */
export function StepProgressRail({ steps, className, style }: StepProgressRailProps) {
  if (steps.length === 0) return null;

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label="Worker step progress"
      data-testid="step-progress-rail"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space[3],
        padding: `${space[4]} ${space[6]}`,
        borderRadius: radii.lg,
        background: colors.raised,
        border: `1px solid ${colors.border}`,
        ...style,
      }}
    >
      {steps.map((step) => {
        const pct =
          typeof step.percent === "number" ? Math.max(0, Math.min(100, step.percent)) : null;
        return (
          <div
            key={step.toolCallId}
            data-testid={`step-chip-${step.status}`}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space[3],
                minWidth: 0,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: statusColor[step.status],
                  flexShrink: 0,
                  boxShadow:
                    step.status === "running" ? `0 0 0 3px ${colors.accentSoft}` : undefined,
                }}
              />
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: colors.textPrimary,
                  fontFamily: "var(--cal-font-mono, ui-monospace, monospace)",
                  flexShrink: 0,
                }}
              >
                {step.toolName}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: statusColor[step.status],
                  flexShrink: 0,
                }}
              >
                {statusLabel[step.status]}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: colors.textSecondary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
                title={step.error || step.message}
              >
                {step.workerName ? `${step.workerName} · ` : ""}
                {step.status === "failed" && step.error ? step.error : step.message}
              </span>
            </div>
            {step.status === "running" && pct !== null ? (
              <div
                aria-hidden
                style={{
                  height: 3,
                  borderRadius: 999,
                  background: colors.border,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: colors.accent,
                    transition: "width 160ms ease-out",
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
