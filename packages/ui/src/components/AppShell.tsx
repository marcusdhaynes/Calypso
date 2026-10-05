import type { CSSProperties, ReactNode } from "react";
import { colors, layout } from "../theme/tokens.js";

export interface AppShellProps {
  sidebar: ReactNode;
  children: ReactNode;
  rail?: ReactNode;
  titlebar?: ReactNode;
  className?: string;
}

export function AppShell({ sidebar, children, rail, titlebar, className }: AppShellProps) {
  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateRows: titlebar ? `${layout.titlebarHeight} 1fr` : "1fr",
        gridTemplateColumns: rail
          ? `${layout.sidebarWidth} minmax(0, 1fr) ${layout.workerRailWidth}`
          : `${layout.sidebarWidth} minmax(0, 1fr)`,
        height: "100%",
        width: "100%",
        background: colors.abyss,
        color: colors.textPrimary,
        overflow: "hidden",
      }}
    >
      {titlebar ? (
        <div
          style={{
            gridColumn: "1 / -1",
            WebkitAppRegion: "drag",
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.deep,
            fontSize: 12,
            color: colors.textMuted,
          } as CSSProperties}
        >
          {titlebar}
        </div>
      ) : null}
      <aside
        style={{
          background: colors.deep,
          borderRight: `1px solid ${colors.border}`,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {sidebar}
      </aside>
      <main style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </main>
      {rail ? (
        <aside
          style={{
            background: colors.deep,
            borderLeft: `1px solid ${colors.border}`,
            minHeight: 0,
            overflow: "auto",
          }}
        >
          {rail}
        </aside>
      ) : null}
    </div>
  );
}
