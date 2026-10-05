import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Message, Worker } from "@calypso/shared";
import {
  AppShell,
  Avatar,
  ChatComposer,
  FirstRunWizard,
  Sidebar,
  WorkerCard,
  colors,
  typography,
  type FirstRunPlanView,
  type SidebarNavId,
} from "@calypso/ui";

const SETUP_KEY = "calypso.setup.complete";

/** Fallback plan when main hasn't probed hardware yet (mirrors Angen RTX 4060 table). */
const FALLBACK_PLAN: FirstRunPlanView = {
  gpuDetected: true,
  gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU (expected)",
  vramGb: 8,
  cpuCores: 16,
  totalMemoryGb: 32,
  modelsToDownload: [
    { model: "qwen2.5:0.5b", purpose: "Fast trivial replies", estimatedDownloadMb: 400, usedBy: ["simple"] },
    { model: "qwen2.5:7b", purpose: "Primary interactive brain", estimatedDownloadMb: 4700, usedBy: ["normal"] },
    { model: "qwen2.5-coder:7b", purpose: "Code generation", estimatedDownloadMb: 4700, usedBy: ["code"] },
    { model: "qwen2-vl:2b", purpose: "Vision (swap with chat)", estimatedDownloadMb: 1800, usedBy: ["vision"] },
    { model: "deepseek-r1:7b", purpose: "Harder reasoning", estimatedDownloadMb: 4700, usedBy: ["reasoning"] },
  ],
  embedding: {
    model: "nomic-embed-text",
    estimatedDownloadMb: 274,
    notes: "CPU embeddings so chat keeps the GPU.",
  },
  notes: [
    "Target: RTX 4060 Laptop 8 GB — one resident ~7B Q4 at a time.",
    "Vision hard-swaps; do not co-load two 7B models.",
  ],
  visionSwapPolicy: "Unload text model before loading VL on ≤8 GB VRAM.",
};

interface ChatLine {
  id: string;
  role: "user" | "worker" | "system";
  name?: string;
  content: string;
}

export function App() {
  const [setupDone, setSetupDone] = useState(() => {
    try {
      return localStorage.getItem(SETUP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [nav, setNav] = useState<SidebarNavId>("home");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([
    {
      id: "welcome",
      role: "system",
      content: "Calypso is online. Create workers, form teams, or just ask.",
    },
  ]);
  const [conversationId, setConversationId] = useState<string>("local-preview");

  useEffect(() => {
    const api = window.calypso;
    if (!api?.listWorkers) return;
    void api.listWorkers().then((list) => {
      setWorkers(list);
      if (list[0]) setSelectedWorkerId(list[0].id);
    }).catch(() => {
      /* core may not be up in vite-only preview */
    });
    return api.onEvent?.((event) => {
      if (event.type === "worker.status" || event.type === "worker.updated") {
        void api.listWorkers().then(setWorkers).catch(() => undefined);
      }
      if (event.type === "message.created") {
        const m = event.message;
        setLines((prev) => [...prev, messageToLine(m)]);
      }
    });
  }, []);

  const selected = useMemo(
    () => workers.find((w) => w.id === selectedWorkerId) ?? null,
    [workers, selectedWorkerId]
  );

  const finishSetup = useCallback((opts: { createDefaultWorker: boolean }) => {
    try {
      localStorage.setItem(SETUP_KEY, "1");
    } catch {
      /* ignore */
    }
    setSetupDone(true);
    if (opts.createDefaultWorker && workers.length === 0) {
      setLines((prev) => [
        ...prev,
        {
          id: `sys-${Date.now()}`,
          role: "system",
          content: "Default Assistant worker will be created once core persistence is connected.",
        },
      ]);
    }
  }, [workers.length]);

  const onSend = useCallback(
    (text: string) => {
      setLines((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: text },
      ]);
      const api = window.calypso;
      if (api?.sendMessage) {
        void api
          .sendMessage(conversationId, text)
          .then((m) => {
            /* message.created event should also fire; avoid dup if it does */
            setConversationId(m.conversationId);
          })
          .catch(() => {
            setLines((prev) => [
              ...prev,
              {
                id: `sys-${Date.now()}`,
                role: "system",
                content: "Core isn't reachable yet — message stayed local.",
              },
            ]);
          });
      }
    },
    [conversationId]
  );

  if (!setupDone) {
    return (
      <FirstRunWizard
        plan={FALLBACK_PLAN}
        onComplete={finishSetup}
        onSkip={() => finishSetup({ createDefaultWorker: false })}
      />
    );
  }

  return (
    <AppShell
      titlebar={
        <span style={{ WebkitAppRegion: "drag" } as CSSProperties}>
          Calypso
        </span>
      }
      sidebar={
        <Sidebar
          activeId={nav}
          onNavigate={setNav}
          workersSlot={
            workers.length === 0 ? (
              <div style={{ padding: "8px 12px", color: colors.textMuted, fontSize: 12.5 }}>
                No workers yet — they'll appear here live.
              </div>
            ) : (
              workers.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  selected={w.id === selectedWorkerId}
                  onClick={() => {
                    setSelectedWorkerId(w.id);
                    setNav("workers");
                  }}
                />
              ))
            )
          }
          footer={
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: colors.textMuted }}>
              <Avatar name={selected?.name ?? "You"} size={24} status={selected?.status} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selected ? `${selected.name} · ${selected.role}` : "Ready"}
              </span>
            </div>
          }
        />
      }
    >
      <header
        style={{
          padding: "16px 24px",
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: colors.deep,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.02em" }}>
            {navLabel(nav)}
          </div>
          <div style={{ fontSize: 12.5, color: colors.textMuted }}>
            {selected ? `Talking with ${selected.name}` : "Home"}
          </div>
        </div>
      </header>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxWidth: 820,
          width: "100%",
          margin: "0 auto",
        }}
      >
        {lines.map((line) => (
          <article
            key={line.id}
            className="cal-fade-in"
            style={{
              alignSelf: line.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              padding: "10px 14px",
              borderRadius: 14,
              background:
                line.role === "user"
                  ? colors.accentSoft
                  : line.role === "system"
                    ? "transparent"
                    : colors.raised,
              border:
                line.role === "system"
                  ? "none"
                  : `1px solid ${line.role === "user" ? "rgba(56,210,193,0.25)" : colors.border}`,
              color: line.role === "system" ? colors.textMuted : colors.textPrimary,
              fontSize: line.role === "system" ? 13 : 14.5,
              lineHeight: 1.5,
              fontFamily: typography.fontSans,
            }}
          >
            {line.name ? (
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, marginBottom: 4 }}>
                {line.name}
              </div>
            ) : null}
            {line.content}
          </article>
        ))}
      </div>

      <ChatComposer onSend={onSend} placeholder={selected ? `Message ${selected.name}…` : "Message Calypso…"} />
    </AppShell>
  );
}

function navLabel(id: SidebarNavId): string {
  switch (id) {
    case "home":
      return "Home";
    case "new":
      return "New conversation";
    case "workers":
      return "Workers";
    case "teams":
      return "Teams";
    case "projects":
      return "Projects";
    case "recent":
      return "Recent";
    case "routines":
      return "Routines";
    case "settings":
      return "Settings";
  }
}

function messageToLine(m: Message): ChatLine {
  if (m.author.type === "user") {
    return { id: m.id, role: "user", content: m.content };
  }
  if (m.author.type === "worker") {
    return { id: m.id, role: "worker", name: m.author.workerId, content: m.content };
  }
  return { id: m.id, role: "system", content: m.content };
}
