import type { BrowserRuntimeProgress } from "@calypso/shared";
import { colors, motion, radii, space } from "../theme/tokens.js";

export interface RuntimeProgressBannerProps {
  title?: string;
  progress: BrowserRuntimeProgress;
  onDismiss?: () => void;
}

const phaseLabel: Record<BrowserRuntimeProgress["phase"], string> = {
  checking: "Checking",
  downloading: "Downloading",
  extracting: "Extracting",
  ready: "Ready",
  error: "Error",
};

export function RuntimeProgressBanner({
  title = "Browser runtime",
  progress,
  onDismiss,
}: RuntimeProgressBannerProps) {
  const pct = typeof progress.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : null;
  const isError = progress.phase === "error";
  const isReady = progress.phase === "ready";

  return (
    <div
      role="status"
      className="cal-fade-in"
      style={{
        position: "fixed",
        left: "50%",
        bottom: space[12],
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
            {title} · {phaseLabel[progress.phase]}
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
