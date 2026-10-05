import type { CSSProperties } from "react";
import type { WorkerStatus } from "@calypso/shared";
import { StatusDot } from "./StatusDot.js";
import { colors, radii } from "../theme/tokens.js";

export interface AvatarProps {
  name: string;
  src?: string;
  size?: number;
  status?: WorkerStatus;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function hueFromName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({ name, src, size = 32, status, className }: AvatarProps) {
  const hue = hueFromName(name);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radii.full,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    flexShrink: 0,
    fontSize: Math.max(10, Math.round(size * 0.36)),
    fontWeight: 600,
    letterSpacing: "-0.02em",
    color: colors.textPrimary,
    background: src
      ? undefined
      : `linear-gradient(145deg, hsl(${hue} 42% 28%), hsl(${(hue + 40) % 360} 48% 18%))`,
    border: `1px solid ${colors.borderStrong}`,
    overflow: "hidden",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
  };

  return (
    <span className={className} style={style} aria-label={name}>
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initials(name)
      )}
      {status ? (
        <span
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            display: "flex",
            padding: 1,
            background: colors.deep,
            borderRadius: radii.full,
          }}
        >
          <StatusDot status={status} size={Math.max(7, Math.round(size * 0.28))} />
        </span>
      ) : null}
    </span>
  );
}
