import type { ControlSession, ControlSessionCommand, Worker } from "@calypso/shared";
import { Avatar } from "./Avatar.js";
import { Button } from "./Button.js";
import { colors, motion, radii, shadows, space } from "../theme/tokens.js";

export interface LiveComputerViewProps {
  session: ControlSession;
  worker?: Worker;
  /**
   * Latest frame from Trice's capture loop.
   * Prefer a blob:/data: URL or a resolved ScreenshotRef URL from IPC.
   * Until `control.frame` lands in contracts, the desktop shell passes this in.
   */
  frameUrl?: string | null;
  onCommand: (command: ControlSessionCommand) => void;
  className?: string;
}

const statusLabel: Record<ControlSession["status"], string> = {
  running: "Running",
  paused: "Paused",
  stopped: "Stopped",
  awaiting_user: "Waiting for you",
  user_controlling: "You have control",
};

export function LiveComputerView({
  session,
  worker,
  frameUrl,
  onCommand,
  className,
}: LiveComputerViewProps) {
  const busy = session.status === "running";
  const paused = session.status === "paused";
  const userHasControl = session.status === "user_controlling";

  return (
    <section
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space[6],
        padding: space[8],
        borderRadius: radii.xl,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        boxShadow: shadows.md,
        minHeight: 0,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: space[6],
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space[6], minWidth: 0 }}>
          {worker ? (
            <Avatar name={worker.name} src={worker.avatar || undefined} status={worker.status} size={36} />
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14.5, color: colors.textPrimary }}>
              {worker?.name ?? "Worker"} · {session.kind === "computer" ? "Computer" : "Browser"}
            </div>
            <div
              style={{
                fontSize: 12,
                color: colors.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {statusLabel[session.status]}
              {session.currentAction ? ` · ${session.currentAction}` : ""}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: space[3], flexShrink: 0 }}>
          {busy ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onCommand({ type: "pause", sessionId: session.id })}
            >
              Pause
            </Button>
          ) : null}
          {paused ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => onCommand({ type: "resume", sessionId: session.id })}
            >
              Resume
            </Button>
          ) : null}
          {!userHasControl && session.status !== "stopped" ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onCommand({ type: "takeControl", sessionId: session.id })}
            >
              Take Control
            </Button>
          ) : null}
          {userHasControl ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => onCommand({ type: "returnControl", sessionId: session.id })}
            >
              Return Control
            </Button>
          ) : null}
          {session.status !== "stopped" ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => onCommand({ type: "stop", sessionId: session.id })}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </header>

      <div style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 1.45 }}>
        <span style={{ color: colors.textMuted }}>Objective · </span>
        {session.objective}
      </div>

      {typeof session.progressPercent === "number" ? (
        <div
          style={{
            height: 4,
            borderRadius: radii.pill,
            background: colors.raised,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.max(0, Math.min(100, session.progressPercent))}%`,
              background: `linear-gradient(90deg, ${colors.accent}, ${colors.violet})`,
              transition: `width ${motion.duration.normal} ${motion.easing.standard}`,
            }}
          />
        </div>
      ) : null}

      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: 220,
          borderRadius: radii.lg,
          overflow: "hidden",
          background: colors.abyss,
          border: `1px solid ${colors.borderStrong}`,
        }}
      >
        {frameUrl ? (
          <img
            src={frameUrl}
            alt="Live computer view"
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              background: colors.abyss,
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              color: colors.textMuted,
              fontSize: 13,
            }}
          >
            Waiting for frames…
          </div>
        )}
        {busy ? (
          <div
            style={{
              position: "absolute",
              top: space[4],
              left: space[4],
              padding: `${space[2]} ${space[5]}`,
              borderRadius: radii.pill,
              background: colors.glass,
              backdropFilter: `blur(8px)`,
              border: `1px solid ${colors.border}`,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: colors.accent,
            }}
          >
            Live
          </div>
        ) : null}
      </div>
    </section>
  );
}
