import { colors, motion, radii, space } from "../theme/tokens.js";

export interface RuntimeProgress {
  phase: string;
  percent?: number;
  message: string;
}

export interface RuntimeProgressBannerProps {
  title?: string;
  progress: RuntimeProgress;
  onDismiss?: () => void;
  /** Stack offset when multiple banners show (0 = bottom). */
  stackIndex?: number;
}

const PHASE_LABELS: Record<string, string> = {
  checking: "Checking",
  starting: "Starting",
  install: "Install",
  pulling: "Pulling",
  downloading: "Downloading",
  extracting: "Extracting",
  ready: "Ready",
  error: "Error",
};

export function RuntimeProgressBanner({
  title = "Runtime",
  progress,
  onDismiss,
  stackIndex = 0,
}: RuntimeProgressBannerProps) {
  const pct = typeof progress.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : null;
  const isError = progress.phase === "error";
  const isReady = progress.phase === "ready";
  const label = PHASE_LABELS[progress.phase] ?? progress.phase;

  return (
    <div
      role="status"
      className="cal-fade-in"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 48 + stackIndex * 96,
        transform: "translateX(-50%)",
        zIndex: 350,
        width: "min(420px, calc(100vw - 32px))",
        padding: space[8],
        borderRadius: radii.xl,
        background: colors.overlay,
        border: `1px solid ${isError ? "rgba(255,107,122,0.35)" : colors.borderStrong}`,
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
        gap: space[5],
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: space[6], alignItems: "baseline" }}>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: isError ? colors.danger : isReady ? colors.success : colors.accent,
            }}
          >
            {title} · {label}
          </div>
          <div style={{ marginTop: 4, fontSize: 13.5, color: colors.textSecondary, lineHeight: 1.4 }}>
            {progress.message}
          </div>
        </div>
        {onDismiss && (isReady || isError) ? (
          <button
            type="button"
            onClick={onDismiss}
            style={{ color: colors.textMuted, fontSize: 12, background: "none", border: "none", cursor: "pointer" }}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {pct != null && !isReady ? (
        <div style={{ height: 4, borderRadius: radii.pill, background: colors.raised, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: isError
                ? colors.danger
                : `linear-gradient(90deg, ${colors.accent}, ${colors.violet})`,
              transition: `width ${motion.duration.normal} ${motion.easing.standard}`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
