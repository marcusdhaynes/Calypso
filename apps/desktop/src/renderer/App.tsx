import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Message, ModelStatus, Worker } from "@calypso/shared";
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

/** Fallback plan when core hasn't probed hardware yet. */
const FALLBACK_PLAN: FirstRunPlanView = {
  gpuDetected: false,
  cpuCores: 8,
  totalMemoryGb: 16,
  modelsToDownload: [
    { model: "qwen3:8b", purpose: "Primary interactive brain", estimatedDownloadMb: 5200, usedBy: ["normal", "code", "reasoning"] },
    { model: "qwen2.5:0.5b", purpose: "Fast trivial replies", estimatedDownloadMb: 400, usedBy: ["simple"] },
    { model: "qwen2.5vl:3b", purpose: "Vision (hard-swap)", estimatedDownloadMb: 3200, usedBy: ["vision"] },
  ],
  embedding: {
    model: "nomic-embed-text",
    estimatedDownloadMb: 274,
    notes: "CPU embeddings so chat keeps the GPU.",
  },
  notes: [
    "Target: one resident qwen3:8b; think:true only for reasoning.",
    "Vision hard-swaps qwen2.5vl:3b — do not co-load with 8B.",
  ],
  visionSwapPolicy: "Unload text model before loading VL on ≤8 GB VRAM.",
};

interface ChatLine {
  id: string;
  role: "user" | "worker" | "system";
  name?: string;
  content: string;
  streaming?: boolean;
}

export function App() {
  const [setupDone, setSetupDone] = useState(() => {
    try {
      return localStorage.getItem(SETUP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [plan, setPlan] = useState<FirstRunPlanView>(FALLBACK_PLAN);
  const [nav, setNav] = useState<SidebarNavId>("home");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([
    {
      id: "welcome",
      role: "system",
      content: "Calypso is online. Create workers, form teams, or just ask.",
    },
  ]);
  const [conversationId, setConversationId] = useState<string>(() => `conv_${Date.now().toString(36)}`);
  const streamingIds = useRef(new Set<string>());

  useEffect(() => {
    const api = window.calypso;
    if (!api) return;

    void api.getFirstRunPlan?.().then((p) => {
      if (p) setPlan(p);
    }).catch(() => undefined);

    void api.getModelStatus?.().then(setModelStatus).catch(() => undefined);
    void api.getAppInfo?.().then((info) => {
      if (info?.modelStatus) setModelStatus(info.modelStatus);
    }).catch(() => undefined);

    void api.listWorkers().then((list) => {
      setWorkers(list);
      if (list[0]) setSelectedWorkerId(list[0].id);
    }).catch(() => undefined);

    const offEvent = api.onEvent?.((event) => {
      if (event.type === "worker.status" || event.type === "worker.updated") {
        void api.listWorkers().then(setWorkers).catch(() => undefined);
      }
      if (event.type === "message.created") {
        const m = event.message;
        // Skip user messages we already appended locally; skip streaming worker msgs until done.
        if (m.author.type === "user") return;
        if (streamingIds.current.has(m.id)) return;
        setLines((prev) => {
          if (prev.some((l) => l.id === m.id)) return prev;
          return [...prev, messageToLine(m)];
        });
      }
      if (event.type === "permission.asked") {
        setLines((prev) => [
          ...prev,
          {
            id: `perm-${event.requestId}`,
            role: "system",
            content: `Permission needed: ${event.reason} (${event.toolCall.toolName}). Approve from the prompt when shown.`,
          },
        ]);
      }
    });

    const offStream = api.onStream?.((push) => {
      streamingIds.current.add(push.messageId);
      setLines((prev) => {
        const idx = prev.findIndex((l) => l.id === push.messageId);
        if (push.done) {
          streamingIds.current.delete(push.messageId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = {
              ...copy[idx],
              content: copy[idx].content + (push.delta || ""),
              streaming: false,
            };
            return copy;
          }
          return [
            ...prev,
            {
              id: push.messageId,
              role: push.workerId ? "worker" : "system",
              name: push.workerId,
              content: push.delta || "",
              streaming: false,
            },
          ];
        }
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = {
            ...copy[idx],
            content: copy[idx].content + push.delta,
            streaming: true,
          };
          return copy;
        }
        return [
          ...prev,
          {
            id: push.messageId,
            role: push.workerId ? "worker" : "system",
            name: push.workerId,
            content: push.delta,
            streaming: true,
          },
        ];
      });
    });

    const onTray = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string }>).detail;
      if (detail?.action === "new-command") {
        setNav("new");
        setConversationId(`conv_${Date.now().toString(36)}`);
        setLines([
          {
            id: "welcome-new",
            role: "system",
            content: "New conversation — type a command below.",
          },
        ]);
      }
    };
    window.addEventListener("calypso:tray", onTray);

    return () => {
      offEvent?.();
      offStream?.();
      window.removeEventListener("calypso:tray", onTray);
    };
  }, []);

  const selected = useMemo(
    () => workers.find((w) => w.id === selectedWorkerId) ?? null,
    [workers, selectedWorkerId]
  );

  const finishSetup = useCallback(async (opts: { createDefaultWorker: boolean }) => {
    try {
      localStorage.setItem(SETUP_KEY, "1");
    } catch {
      /* ignore */
    }
    setSetupDone(true);
    const api = window.calypso;
    if (opts.createDefaultWorker && api?.createWorker) {
      try {
        const worker = await api.createWorker({
          id: `worker_${Date.now().toString(36)}`,
          name: "Assistant",
          avatar: "assistant",
          role: "general assistant",
          personality: "helpful, concise",
          instructions: "Help the user get work done on their computer.",
          skills: ["chat", "planning"],
          tools: [],
          permissions: [],
          preferredModel: "normal",
          workspace: ".",
          autonomyLevel: "ask",
        });
        setWorkers((prev) => {
          if (prev.some((w) => w.id === worker.id)) return prev;
          return [...prev, worker];
        });
        setSelectedWorkerId(worker.id);
        setConversationId(`conv_${Date.now().toString(36)}`);
        setLines((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: `Created default worker “${worker.name}”.`,
          },
        ]);
      } catch (err) {
        setLines((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: `Could not create default worker: ${err instanceof Error ? err.message : String(err)}`,
          },
        ]);
      }
    }
  }, []);

  const onSend = useCallback(
    (text: string) => {
      setLines((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: text },
      ]);
      const api = window.calypso;
      if (!api?.sendMessage) {
        setLines((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}`,
            role: "system",
            content: "Core isn't reachable yet — message stayed local.",
          },
        ]);
        return;
      }
      void api
        .sendMessage(conversationId, text, selectedWorkerId ?? undefined)
        .then((m) => {
          setConversationId(m.conversationId);
        })
        .catch((err) => {
          setLines((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "system",
              content: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        });
    },
    [conversationId, selectedWorkerId]
  );

  if (!setupDone) {
    return (
      <FirstRunWizard
        plan={plan}
        onComplete={(opts) => {
          void finishSetup(opts);
        }}
        onSkip={() => {
          void finishSetup({ createDefaultWorker: false });
        }}
      />
    );
  }

  return (
    <AppShell
      titlebar={
        <span style={{ WebkitAppRegion: "drag" } as CSSProperties}>
          Calypso
          {modelStatus && !modelStatus.ready ? (
            <span style={{ marginLeft: 12, color: colors.warning ?? "#e8a838", fontSize: 12, WebkitAppRegion: "no-drag" } as CSSProperties}>
              Model unavailable
            </span>
          ) : null}
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
            {modelStatus && !modelStatus.ready
              ? ` · ${modelStatus.message ?? "Model unavailable"}`
              : ""}
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
              opacity: line.streaming ? 0.9 : 1,
            }}
          >
            {line.name ? (
              <div style={{ fontSize: 11, fontWeight: 600, color: colors.accent, marginBottom: 4 }}>
                {line.name}
              </div>
            ) : null}
            {line.content}
            {line.streaming ? "▍" : ""}
          </article>
        ))}
      </div>

      <ChatComposer
        onSend={onSend}
        placeholder={selected ? `Message ${selected.name}…` : "Message Calypso…"}
      />
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
