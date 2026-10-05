import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { BrowserRuntimeProgress, ControlFrame, ControlSession, FirstRunPlan, Message, ModelStatus, ToolCall, Worker, WorkerId } from "@calypso/shared";
import {
  AppShell,
  Avatar,
  ChatComposer,
  FirstRunWizard,
  LiveComputerView,
  PermissionToast,
  RuntimeProgressBanner,
  Sidebar,
  WorkerCard,
  colors,
  typography,
  type FirstRunPlanView,
  type SidebarNavId,
} from "@calypso/ui";

const SETUP_KEY = "calypso.setup.complete";

/** Offline fallback matching Angen 265e74b (qwen3:8b + qwen2.5vl:3b). */
const FALLBACK_PLAN: FirstRunPlanView = {
  gpuDetected: true,
  gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU (expected)",
  vramGb: 8,
  cpuCores: 16,
  totalMemoryGb: 32,
  modelsToDownload: [
    { model: "qwen3:0.6b", purpose: "Fast trivial replies", estimatedDownloadMb: 500, usedBy: ["simple"] },
    {
      model: "qwen3:8b",
      purpose: "Primary brain (normal / code / reasoning)",
      estimatedDownloadMb: 5200,
      usedBy: ["normal", "code", "reasoning"],
    },
    {
      model: "qwen2.5vl:3b",
      purpose: "Vision (hard-swap with chat)",
      estimatedDownloadMb: 3200,
      usedBy: ["vision"],
    },
  ],
  embedding: {
    model: "nomic-embed-text",
    estimatedDownloadMb: 274,
    notes: "CPU embeddings so chat keeps the GPU.",
  },
  notes: [
    "One resident qwen3:8b for normal/code/reasoning (think:true only for reasoning).",
    "Vision hard-swaps to qwen2.5vl:3b — do not co-reside with 8B.",
  ],
  visionSwapPolicy: "Unload qwen3:8b before loading qwen2.5vl:3b on ≤8 GB VRAM.",
};

interface ChatLine {
  id: string;
  role: "user" | "worker" | "system";
  name?: string;
  content: string;
  streaming?: boolean;
}

interface PermissionAsk {
  requestId: string;
  workerId: WorkerId;
  toolCall: ToolCall;
  reason: string;
}

function planToView(plan: FirstRunPlan): FirstRunPlanView {
  return {
    gpuDetected: plan.gpuDetected,
    gpuName: plan.gpuName,
    vramGb: plan.vramGb,
    cpuCores: plan.cpuCores,
    totalMemoryGb: plan.totalMemoryGb,
    modelsToDownload: plan.modelsToDownload,
    embedding: plan.embedding,
    notes: plan.notes,
    visionSwapPolicy: plan.visionSwapPolicy,
  };
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
  const [permissionAsk, setPermissionAsk] = useState<PermissionAsk | null>(null);
  const [controlSession, setControlSession] = useState<ControlSession | null>(null);
  const [controlFrame, setControlFrame] = useState<ControlFrame | null>(null);
  const watchingFrames = useRef(false);
  const [browserRuntimeProgress, setBrowserRuntimeProgress] = useState<BrowserRuntimeProgress | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const streamingIds = useRef(new Set<string>());
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
    if (!api) return;

    if (api.getFirstRunPlan) {
      void api
        .getFirstRunPlan()
        .then((p) => setPlan(planToView(p)))
        .catch(() => undefined);
    }

    void api.getModelStatus?.().then(setModelStatus).catch(() => undefined);
    void api.getAppInfo?.().then((info) => {
      if (info?.modelStatus) setModelStatus(info.modelStatus);
    }).catch(() => undefined);

    if (api.listWorkers) {
      void api
        .listWorkers()
        .then((list) => {
          setWorkers(list);
          if (list[0]) setSelectedWorkerId(list[0].id);
        })
        .catch(() => undefined);
    }

    const offEvent = api.onEvent?.((event) => {
      if (event.type === "worker.status" || event.type === "worker.updated") {
        void api.listWorkers?.().then(setWorkers).catch(() => undefined);
      }
      if (event.type === "message.created") {
        const m = event.message;
        if (m.author.type === "user") return;
        if (streamingIds.current.has(m.id)) return;
        setLines((prev) => {
          if (prev.some((l) => l.id === m.id)) return prev;
          return [...prev, messageToLine(m)];
        });
      }
      if (event.type === "permission.asked") {
        setPermissionAsk({
          requestId: event.requestId,
          workerId: event.workerId,
          toolCall: event.toolCall,
          reason: event.reason,
        });
      }
      if (event.type === "permission.resolved") {
        setPermissionAsk((cur) => (cur?.requestId === event.requestId ? null : cur));
      }
      if (event.type === "control.session.updated") {
        const session = event.session;
        setControlSession(session);
        const active = session.status === "running" || session.status === "paused" || session.status === "awaiting_user" || session.status === "user_controlling";
        if (active && !watchingFrames.current) {
          watchingFrames.current = true;
          void api.watchFrames?.().catch(() => {
            watchingFrames.current = false;
          });
        }
        if (!active && watchingFrames.current) {
          watchingFrames.current = false;
          setControlFrame(null);
          void api.unwatchFrames?.().catch(() => undefined);
        }
      }
      if (event.type === "control.frame") {
        setControlFrame(event.frame);
      }
      if (event.type === "browser.runtime.progress") {
        setBrowserRuntimeProgress(event.progress);
      }
      if (event.type === "browser.runtime.ready") {
        setBrowserRuntimeProgress({
          phase: "ready",
          percent: 100,
          message: event.status.installed
            ? "Chromium is ready for browsing."
            : "Browser runtime reported ready.",
        });
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

    return () => {
      offEvent?.();
      offStream?.();
      if (watchingFrames.current) {
        watchingFrames.current = false;
        void api.unwatchFrames?.().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    return window.calypso?.onTray?.((payload) => {
      if (payload.action === "new-command") {
        setNav("new");
        setSetupDone(true);
      }
    });
  }, []);

  /** Live nav: ensure frames are watched; Theriz LiveComputerView mounts on control.session.updated. */
  useEffect(() => {
    const api = window.calypso;
    if (!api || nav !== "live") return;
    if (!watchingFrames.current) {
      watchingFrames.current = true;
      void api.watchFrames?.().catch(() => {
        watchingFrames.current = false;
      });
    }
  }, [nav]);

  const selected = useMemo(
    () => workers.find((w) => w.id === selectedWorkerId) ?? null,
    [workers, selectedWorkerId]
  );

  const finishSetup = useCallback(
    async (opts: { createDefaultWorker: boolean }) => {
      try {
        localStorage.setItem(SETUP_KEY, "1");
      } catch {
        /* ignore */
      }
      setSetupDone(true);

      const api = window.calypso;
      if (api?.ensureBrowserRuntime) {
        setBrowserRuntimeProgress({
          phase: "checking",
          message: "Preparing browser runtime…",
        });
        void api.ensureBrowserRuntime().catch((err: unknown) => {
          setBrowserRuntimeProgress({
            phase: "error",
            message: err instanceof Error ? err.message : "Browser runtime install failed.",
          });
        });
      }
      if (opts.createDefaultWorker && api?.createWorker) {
        try {
          const worker = await api.createWorker({
            id: `worker-assistant-${Date.now()}`,
            name: "Assistant",
            avatar: "",
            role: "General assistant",
            personality: "Warm, concise, proactive",
            instructions: "Help Marcus get work done. Prefer local tools. Ask before destructive actions.",
            skills: ["chat", "research", "planning"],
            tools: ["windows.observe", "browser.navigate"],
            permissions: [],
            preferredModel: "normal",
            workspace: ".",
            autonomyLevel: "ask",
            status: "idle",
          });
          setWorkers((prev) => {
            if (prev.some((w) => w.id === worker.id)) return prev;
            return [...prev, worker];
          });
          setSelectedWorkerId(worker.id);
          setLines((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "system",
              content: `Created worker “${worker.name}”.`,
            },
          ]);
        } catch {
          setLines((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}`,
              role: "system",
              content: "Couldn’t create the default worker yet — core may still be starting.",
            },
          ]);
        }
      }
    },
    []
  );

  const onSend = useCallback(
    (text: string) => {
      const localId = `u-${Date.now()}`;
      setLines((prev) => [...prev, { id: localId, role: "user", content: text }]);
      const api = window.calypso;
      if (api?.sendMessage) {
        void api
          .sendMessage(conversationId, text, selectedWorkerId ?? undefined)
          .then((m) => {
            setConversationId(m.conversationId);
            setLines((prev) => {
              const withoutOptimistic = prev.filter((l) => l.id !== localId);
              if (withoutOptimistic.some((l) => l.id === m.id)) return withoutOptimistic;
              return [...withoutOptimistic, messageToLine(m)];
            });
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
    [conversationId, selectedWorkerId]
  );

  const resolvePermission = useCallback((requestId: string, allow: boolean) => {
    setPermissionAsk(null);
    void window.calypso?.resolvePermission?.(requestId, allow);
  }, []);

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
    <>
      <AppShell
        titlebar={
          <span style={{ WebkitAppRegion: "drag" } as CSSProperties}>
            Calypso
            {modelStatus && !modelStatus.ready ? (
              <span
                style={
                  {
                    marginLeft: 12,
                    color: colors.warning,
                    fontSize: 12,
                    WebkitAppRegion: "no-drag",
                  } as CSSProperties
                }
              >
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12.5,
                  color: colors.textMuted,
                }}
              >
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
              {nav === "live"
                ? (controlSession?.objective ?? "Waiting for an active control session")
                : selected
                  ? `Talking with ${selected.name}`
                  : "Home"}
              {modelStatus && !modelStatus.ready
                ? ` · ${modelStatus.message ?? "Model unavailable"}`
                : ""}
            </div>
          </div>
        </header>


        {controlSession && controlSession.status !== "stopped" ? (
          <div style={{ padding: "16px 24px 0", maxWidth: 960, width: "100%", margin: "0 auto" }}>
            <LiveComputerView
              session={controlSession}
              worker={workers.find((w) => w.id === controlSession.workerId)}
              frame={controlFrame}
              onCommand={(command) => {
                void window.calypso?.controlCommand?.(command);
              }}
            />
          </div>
        ) : null}

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
              {line.content}{line.streaming ? "▍" : ""}
            </article>
          ))}
        </div>

        <ChatComposer
          onSend={onSend}
          placeholder={selected ? `Message ${selected.name}…` : "Message Calypso…"}
        />
      </AppShell>

      {browserRuntimeProgress && browserRuntimeProgress.phase !== "ready" ? (
        <RuntimeProgressBanner
          progress={browserRuntimeProgress}
          onDismiss={
            browserRuntimeProgress.phase === "error"
              ? () => setBrowserRuntimeProgress(null)
              : undefined
          }
        />
      ) : browserRuntimeProgress?.phase === "ready" ? (
        <RuntimeProgressBanner
          progress={browserRuntimeProgress}
          onDismiss={() => setBrowserRuntimeProgress(null)}
        />
      ) : null}

      {permissionAsk ? (
        <PermissionToast
          requestId={permissionAsk.requestId}
          workerId={permissionAsk.workerId}
          workerName={workers.find((w) => w.id === permissionAsk.workerId)?.name}
          toolCall={permissionAsk.toolCall}
          reason={permissionAsk.reason}
          onAllow={(id) => resolvePermission(id, true)}
          onDeny={(id) => resolvePermission(id, false)}
        />
      ) : null}
    </>
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
    case "live":
      return "Live computer";
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
