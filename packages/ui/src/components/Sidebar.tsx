import type { ReactNode } from "react";
import { colors, motion, radii, space } from "../theme/tokens.js";

export type SidebarNavId =
  | "home"
  | "new"
  | "workers"
  | "teams"
  | "projects"
  | "recent"
  | "routines"
  | "settings";

export interface SidebarNavItem {
  id: SidebarNavId;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
}

export interface SidebarProps {
  items?: SidebarNavItem[];
  activeId: SidebarNavId;
  onNavigate: (id: SidebarNavId) => void;
  footer?: ReactNode;
  brand?: ReactNode;
  workersSlot?: ReactNode;
}

const DEFAULT_ITEMS: SidebarNavItem[] = [
  { id: "home", label: "Home" },
  { id: "new", label: "New conversation" },
  { id: "workers", label: "Workers" },
  { id: "teams", label: "Teams" },
  { id: "projects", label: "Projects" },
  { id: "recent", label: "Recent" },
  { id: "routines", label: "Routines" },
  { id: "settings", label: "Settings" },
];

export function Sidebar({
  items = DEFAULT_ITEMS,
  activeId,
  onNavigate,
  footer,
  brand,
  workersSlot,
}: SidebarProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: `${space[8]} ${space[6]} ${space[6]}` }}>
        {brand ?? (
          <div style={{ display: "flex", alignItems: "center", gap: space[5] }}>
            <span
              aria-hidden
              style={{
                width: 28,
                height: 28,
                borderRadius: radii.md,
                background: `linear-gradient(145deg, ${colors.accent}, ${colors.violet})`,
                boxShadow: `0 0 20px rgba(56, 210, 193, 0.35)`,
              }}
            />
            <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" }}>Calypso</span>
          </div>
        )}
      </div>

      <nav style={{ padding: `0 ${space[4]}`, display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              className="cal-focus-ring"
              onClick={() => onNavigate(item.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space[5],
                padding: `${space[5]} ${space[6]}`,
                borderRadius: radii.md,
                textAlign: "left",
                fontSize: 13.5,
                fontWeight: active ? 600 : 500,
                color: active ? colors.textPrimary : colors.textSecondary,
                background: active ? colors.accentSoft : "transparent",
                border: `1px solid ${active ? "rgba(56, 210, 193, 0.22)" : "transparent"}`,
                transition: `background ${motion.duration.fast} ${motion.easing.standard}`,
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = colors.raised;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.badge != null ? (
                <span style={{ fontSize: 11, color: colors.textMuted }}>{item.badge}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {workersSlot ? (
        <div
          style={{
            marginTop: space[6],
            padding: `0 ${space[4]}`,
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            borderTop: `1px solid ${colors.border}`,
            paddingTop: space[6],
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: colors.textMuted,
              padding: `0 ${space[6]} ${space[4]}`,
            }}
          >
            Workers
          </div>
          {workersSlot}
        </div>
      ) : (
        <div style={{ flex: 1 }} />
      )}

      {footer ? (
        <div style={{ padding: space[6], borderTop: `1px solid ${colors.border}` }}>{footer}</div>
      ) : null}
    </div>
  );
}

export { DEFAULT_ITEMS as defaultSidebarItems };
