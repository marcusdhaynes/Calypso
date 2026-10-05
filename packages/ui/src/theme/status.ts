import type { WorkerStatus } from "@calypso/shared";
import { colors } from "./tokens.js";

/**
 * Live worker status → color + label + pulse behavior.
 * Keep in lockstep with WorkerStatus in @calypso/shared contracts.
 */
export interface StatusVisual {
  color: string;
  soft: string;
  label: string;
  /** Soft breathing glow when true. */
  pulse: boolean;
}

export const workerStatusVisuals: Record<WorkerStatus, StatusVisual> = {
  idle: {
    color: colors.textMuted,
    soft: "rgba(101, 114, 134, 0.18)",
    label: "Idle",
    pulse: false,
  },
  thinking: {
    color: colors.violet,
    soft: colors.violetSoft,
    label: "Thinking",
    pulse: true,
  },
  working: {
    color: colors.accent,
    soft: colors.accentSoft,
    label: "Working",
    pulse: true,
  },
  waiting: {
    color: colors.warning,
    soft: "rgba(240, 194, 90, 0.16)",
    label: "Waiting",
    pulse: true,
  },
  controlling_computer: {
    color: colors.info,
    soft: "rgba(91, 168, 255, 0.16)",
    label: "Controlling computer",
    pulse: true,
  },
  browsing: {
    color: colors.info,
    soft: "rgba(91, 168, 255, 0.16)",
    label: "Browsing",
    pulse: true,
  },
  coding: {
    color: colors.accent,
    soft: colors.accentSoft,
    label: "Coding",
    pulse: true,
  },
  speaking: {
    color: colors.violet,
    soft: colors.violetSoft,
    label: "Speaking",
    pulse: true,
  },
  error: {
    color: colors.danger,
    soft: "rgba(255, 107, 122, 0.16)",
    label: "Error",
    pulse: false,
  },
  offline: {
    color: "#3A4454",
    soft: "rgba(58, 68, 84, 0.2)",
    label: "Offline",
    pulse: false,
  },
};

export function statusVisual(status: WorkerStatus): StatusVisual {
  return workerStatusVisuals[status];
}
