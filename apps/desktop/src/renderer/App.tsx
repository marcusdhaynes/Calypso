import { useEffect, useState } from "react";
import { Button, colors, typography } from "@calypso/ui";

interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const api = window.calypso;
    if (api?.getAppInfo) {
      void api
        .getAppInfo()
        .then(setInfo)
        .catch(() => {
          setInfo({ name: "Calypso", version: "0.1.0", platform: "renderer-only" });
        });
    } else {
      setInfo({ name: "Calypso", version: "0.1.0", platform: "web-dev" });
    }
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        background: colors.abyss,
        color: colors.textPrimary,
        fontFamily: typography.fontSans,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <section
        style={{
          maxWidth: 480,
          width: "100%",
          background: colors.surface,
          borderRadius: 12,
          padding: 20,
          border: `1px solid ${colors.border}`,
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: typography.size["2xl"] }}>Calypso</h1>
        <p style={{ marginTop: 0, color: colors.textSecondary, fontSize: typography.size.base }}>
          Windows desktop agent orchestration shell. Placeholder UI — Theriz owns polish.
        </p>
        <dl style={{ fontFamily: typography.fontMono, fontSize: typography.size.sm }}>
          <dt style={{ color: colors.textMuted }}>App</dt>
          <dd style={{ margin: "0 0 8px" }}>{info?.name ?? "…"}</dd>
          <dt style={{ color: colors.textMuted }}>Version</dt>
          <dd style={{ margin: "0 0 8px" }}>{info?.version ?? "…"}</dd>
          <dt style={{ color: colors.textMuted }}>Platform</dt>
          <dd style={{ margin: "0 0 8px" }}>{info?.platform ?? "…"}</dd>
        </dl>
        <Button
          variant="primary"
          onClick={() => {
            void window.calypso?.getTaskGraph().then((g) => {
              console.log("task graph", g);
            });
          }}
        >
          Ping task graph
        </Button>
      </section>
    </div>
  );
}
