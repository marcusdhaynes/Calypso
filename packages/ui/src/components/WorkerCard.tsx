import type { Worker } from "@calypso/shared";
import { Avatar } from "./Avatar.js";
import { statusVisual } from "../theme/status.js";
import { colors, motion, radii, space } from "../theme/tokens.js";

export interface WorkerCardProps {
  worker: Worker;
  selected?: boolean;
  onClick?: () => void;
}

export function WorkerCard({ worker, selected, onClick }: WorkerCardProps) {
  const visual = statusVisual(worker.status);
  return (
    <button
      type="button"
      onClick={onClick}
      className="cal-focus-ring"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space[6],
        width: "100%",
        padding: `${space[5]} ${space[6]}`,
        borderRadius: radii.lg,
        textAlign: "left",
        background: selected ? colors.accentSoft : "transparent",
        border: `1px solid ${selected ? "rgba(56, 210, 193, 0.28)" : "transparent"}`,
        transition: `background ${motion.duration.fast} ${motion.easing.standard}, border-color ${motion.duration.fast} ${motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = colors.raised;
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <Avatar name={worker.name} src={worker.avatar || undefined} status={worker.status} size={36} />
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontWeight: 600,
            fontSize: 13.5,
            color: colors.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {worker.name}
        </span>
        <span
          style={{
            fontSize: 12,
            color: visual.color,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {visual.label}
          {worker.role ? ` · ${worker.role}` : ""}
        </span>
      </span>
    </button>
  );
}
