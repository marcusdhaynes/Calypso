import type { WorkerStatus } from "@calypso/shared";
import { statusVisual } from "../theme/status.js";

export interface StatusDotProps {
  status: WorkerStatus;
  size?: number;
  className?: string;
  title?: string;
}

export function StatusDot({ status, size = 8, className, title }: StatusDotProps) {
  const visual = statusVisual(status);
  return (
    <span
      className={[visual.pulse ? "cal-pulse" : "", className].filter(Boolean).join(" ")}
      title={title ?? visual.label}
      aria-label={visual.label}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: visual.color,
        boxShadow: visual.pulse ? `0 0 8px ${visual.color}` : undefined,
        flexShrink: 0,
      }}
    />
  );
}
