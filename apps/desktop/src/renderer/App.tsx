import { Markdown } from "./Markdown";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Artifact, BrowserRuntimeProgress, CalypsoSettings, ControlFrame, ControlSession, FirstRunPlan, InferenceRuntimeProgress, InferenceRuntimeStatus, Message, ModelStatus, Routine, Team, ToolCall, Worker, WorkerId } from "@calypso/shared";
import {
  AppShell,
  ArtifactsPanel,
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
  type FirstRunConsentOptions,
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
  const [inferenceRuntimeProgress, setInferenceRuntimeProgress] = useState<InferenceRuntimeProgress | null>(null);
  const [chromiumDownloadMb, setChromiumDownloadMb] = useState(300);
  const [ollamaInfo, setOllamaInfo] = useState<{ installed: boolean; installUrl?: string; message?: string }>({
    installed: true,
  });
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
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [settings, setSettings] = useState<CalypsoSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsApiKeyDraft, setSettingsApiKeyDraft] = useState("");
  const [settingsBaseUrlDraft, setSettingsBaseUrlDraft] = useState("");
  const [settingsModelIdDraft, setSettingsModelIdDraft] = useState("");
  const [settingsNote, setSettingsNote] = useState<string | null>(null);

  const refreshTeams = useCallback(() => {
    void window.calypso?.listTeams?.().then(setTeams).catch(() => undefined);
  }, []);
  const refreshRoutines = useCallback(() => {
    void window.calypso?.listRoutines?.().then(setRoutines).catch(() => undefined);
  }, []);
  const refreshArtifacts = useCallback(() => {
    void window.calypso?.listArtifacts?.().then(setArtifacts).catch(() => undefined);
  }, []);

  const refreshSettings = useCallback(() => {
    void window.calypso?.getSettings?.().then((s) => {
      setSettings(s);
      setSettingsBaseUrlDraft(s.frontier.baseUrl);
      setSettingsModelIdDraft(s.frontier.modelId);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (nav === "settings") refreshSettings();
  }, [nav, refreshSettings]);

  const saveCloudSettings = useCallback(
    async (patch: {
      cloudModelsEnabled?: boolean;
      baseUrl?: string;
      modelId?: string;
      apiKey?: string;
    }) => {
      if (!window.calypso?.updateSettings) return;
      setSettingsBusy(true);
      setSettingsNote(null);
      try {
        const next = await window.calypso.updateSettings({
          cloudModelsEnabled: patch.cloudModelsEnabled,
          frontier: {
            enabled: patch.cloudModelsEnabled,
            baseUrl: patch.baseUrl,
            modelId: patch.modelId,
            ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
          },
        });
        setSettings(next);
        setSettingsBaseUrlDraft(next.frontier.baseUrl);
        setSettingsModelIdDraft(next.frontier.modelId);
        if (patch.apiKey !== undefined) setSettingsApiKeyDraft("");
        setSettingsNote(
          next.cloudModelsEnabled
            ? next.hasCloudApiKey
              ? "Cloud frontier enabled."
              : "Cloud frontier on — add OPENAI_API_KEY / CALYPSO_OPENAI_API_KEY or paste a key below (frontier falls back to local until a key is available)."
            : "Cloud frontier disabled — frontier tasks use local primary (qwen3:8b)."
        );
        void window.calypso.getModelStatus?.().then(setModelStatus).catch(() => undefined);
      } catch (err) {
        setSettingsNote(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingsBusy(false);
      }
    },
    []
  );

  useEffect(() => {
    const api = window.calypso;
    if (!api) return;

    if (api.getFirstRunPlan) {
      void api
        .getFirstRunPlan()
        .then((p) => setPlan(planToView(p)))
        .catch(() => undefined);
    }

    void api.getBrowserRuntimeStatus?.().then((s) => {
      if (typeof s?.estimatedDownloadMb === "number") setChromiumDownloadMb(s.estimatedDownloadMb);
    }).catch(() => undefined);

    void api.getInferenceRuntimeStatus?.().then((s: InferenceRuntimeStatus) => {
      setOllamaInfo({
        installed: s.state !== "notInstalled",
        installUrl: s.installUrl,
        message: s.message,
      });
    }).catch(() => undefined);

    void api.getModelStatus?.().then(setModelStatus).catch(() => undefined);
    void api.getAppInfo?.().then((info) => {
      if (info?.modelStatus) setModelStatus(info.modelStatus);
    }).catch(() => undefined);
    void api.getSettings?.().then((s) => {
      setSettings(s);
      setSettingsBaseUrlDraft(s.frontier.baseUrl);
      setSettingsModelIdDraft(s.frontier.modelId);
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
    void api.listTeams?.().then(setTeams).catch(() => undefined);
    void api.listRoutines?.().then(setRoutines).catch(() => undefined);
    void api.listArtifacts?.().then(setArtifacts).catch(() => undefined);

    const offEvent = api.onEvent?.((event) => {
      if (event.type === "worker.status" || event.type === "worker.updated") {
        void api.listWorkers?.().then(setWorkers).catch(() => undefined);
      }
      if (event.type === "message.created") {
        const m = event.message;
        if (m.conversationId !== conversationIdRef.current) return;
        if (m.author.type === "user") return;
        if (streamingIds.current.has(m.id)) return;
        setLines((prev) => {
          if (prev.some((l) => l.id === m.id)) return prev;
          return [...prev, messageToLine(m)];
        });
      }
      if (event.type === "team.updated") {
        void api.listTeams?.().then(setTeams).catch(() => undefined);
      }
      if (event.type === "artifact.created") {
        void api.listArtifacts?.().then(setArtifacts).catch(() => undefined);
      }
      if (event.type === "routine.updated" || event.type === "routine.fired") {
        void api.listRoutines?.().then(setRoutines).catch(() => undefined);
        // Routine runs post their replies into their own conversation; no extra chat line here.
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
      if (event.type === "models.runtime.progress") {
        setInferenceRuntimeProgress(event.progress);
        if (event.progress.phase === "install") {
          setOllamaInfo((cur) => ({ ...cur, installed: false, message: event.progress.message }));
        }
      }
      if (event.type === "models.runtime.ready") {
        const s = event.status;
        setOllamaInfo({
          installed: s.state !== "notInstalled",
          installUrl: s.installUrl,
          message: s.message,
        });
        setInferenceRuntimeProgress({
          phase: s.state === "ready" ? "ready" : s.state === "notInstalled" ? "install" : s.state === "error" ? "error" : "ready",
          percent: s.state === "ready" ? 100 : undefined,
          message: s.message,
        });
      }
    });

    const offStream = api.onStream?.((push) => {
      if (push.conversationId && push.conversationId !== conversationIdRef.current) return;
      streamingIds.current.add(push.messageId);
      setLines((prev) => {
        const idx = prev.findIndex((l) => l.id === push.messageId);
        if (push.done) {
          streamingIds.current.delete(push.messageId);
          if (idx >= 0) {
            const copy = [...prev];
            const cur = copy[idx];
            const delta = push.delta || "";
            copy[idx] = {
              ...cur,
              // A final delta can repeat text already delivered via message.created (e.g. errors).
              content: cur.streaming || !cur.content.endsWith(delta) ? cur.content + delta : cur.content,
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
      if (payload.action === "ptt-focus") {
        setNav("home");
        setSetupDone(true);
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="chat-ptt"]');
          el?.focus();
        });
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
  const selectedTeam = useMemo(
    () => teams.find((tm) => tm.id === selectedTeamId) ?? null,
    [teams, selectedTeamId]
  );

  const openTeamChat = useCallback(
    async (team: Team) => {
      setSelectedTeamId(team.id);
      setNav("teams");
      const convId = team.conversationId;
      if (!convId) {
        setLines([
          {
            id: `team-empty-${team.id}`,
            role: "system",
            content: `Team "${team.name}" has no group chat yet.`,
          },
        ]);
        return;
      }
      setConversationId(convId);
      const msgs = (await window.calypso?.listMessages?.(convId).catch(() => [])) ?? [];
      setLines([
        {
          id: `team-head-${team.id}`,
          role: "system",
          content: `Team chat · ${team.name} (${team.memberIds.length} members). Worker-to-worker messages show here.`,
        },
        ...msgs.map(messageToLine),
      ]);
    },
    []
  );

  const createDemoTeam = useCallback(async () => {
    const api = window.calypso;
    if (!api?.createTeam) return;
    let list = workers;
    if (list.length < 2) {
      list = (await api.listWorkers?.().catch(() => list)) ?? list;
    }
    if (list.length < 2) {
      setLines((prev) => [
        ...prev,
        {
          id: `need-workers-${Date.now()}`,
          role: "system",
          content: "Need at least two workers to form a team chat. Create another worker first.",
        },
      ]);
      return;
    }
    const a = list[0]!;
    const b = list[1]!;
    const team = await api.createTeam({
      id: `team-${Date.now()}`,
      name: "Ops",
      description: "Demo team group chat",
      memberIds: [a.id, b.id],
      leadId: a.id,
    });
    // Keep worker.teamId in sync for sendWorkerMessage resolution
    if (api.updateWorker) {
      await api.updateWorker({ ...a, teamId: team.id, updatedAt: Date.now() });
      await api.updateWorker({ ...b, teamId: team.id, updatedAt: Date.now() });
      const refreshed = await api.listWorkers();
      setWorkers(refreshed);
    }
    refreshTeams();
    await openTeamChat(team);
    // Seed a real worker-to-worker message
    if (api.sendWorkerChat) {
      await api.sendWorkerChat(a.id, [b.id], "Standing by in the team chat.", {
        teamId: team.id,
        conversationId: team.conversationId,
      });
    }
  }, [workers, refreshTeams, openTeamChat]);

  const createDemoRoutine = useCallback(async () => {
    const api = window.calypso;
    if (!api?.createRoutine) return;
    const worker = selected ?? workers[0];
    if (!worker) {
      setLines((prev) => [
        ...prev,
        { id: `need-w-${Date.now()}`, role: "system", content: "Create a worker before adding a routine." },
      ]);
      return;
    }
    const routine = await api.createRoutine({
      id: `routine-${Date.now()}`,
      name: "Quick check-in",
      description: "Interval demo routine",
      schedule: { type: "interval", ms: 60_000 },
      workerId: worker.id,
      teamId: selectedTeamId ?? undefined,
      taskTemplate: {
        title: "Routine check-in",
        description: "Say ready in one short sentence.",
        taskClass: "simple",
      },
      enabled: true,
    });
    refreshRoutines();
    setNav("routines");
    setLines((prev) => [
      ...prev,
      {
        id: `routine-created-${routine.id}`,
        role: "system",
        content: `Routine "${routine.name}" scheduled · next ${
          routine.nextRunAt ? new Date(routine.nextRunAt).toLocaleTimeString() : "soon"
        }.`,
      },
    ]);
  }, [selected, workers, selectedTeamId, refreshRoutines]);

  const finishSetup = useCallback(
    async (opts: FirstRunConsentOptions) => {
      try {
        localStorage.setItem(SETUP_KEY, "1");
      } catch {
        /* ignore */
      }
      setSetupDone(true);

      const api = window.calypso;
      if (opts.installBrowser && api?.ensureBrowserRuntime) {
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
      if (opts.installModels && api?.ensureInferenceRuntime) {
        setInferenceRuntimeProgress({
          phase: "checking",
          message: "Preparing local models…",
        });
        void api.ensureInferenceRuntime().then((status) => {
          if (status.state === "notInstalled") {
            setOllamaInfo({
              installed: false,
              installUrl: status.installUrl,
              message: status.message,
            });
            setInferenceRuntimeProgress({
              phase: "install",
              message: status.message || "Install Ollama, then retry model download from Settings.",
            });
          }
        }).catch((err: unknown) => {
          setInferenceRuntimeProgress({
            phase: "error",
            message: err instanceof Error ? err.message : "Model install failed.",
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

  const warmingPhases = new Set(["checking", "starting", "pulling", "downloading", "extracting"]);
  const modelWarming =
    !!inferenceRuntimeProgress && warmingPhases.has(inferenceRuntimeProgress.phase);

    if (!setupDone) {
    return (
      <FirstRunWizard
        plan={plan}
        chromiumDownloadMb={chromiumDownloadMb}
        ollama={ollamaInfo}
        onOpenOllamaInstall={(url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        }}
        onComplete={(opts) => {
          void finishSetup(opts);
        }}
        onSkip={() => {
          void finishSetup({
            createDefaultWorker: false,
            installBrowser: false,
            installModels: false,
          });
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
                : nav === "artifacts"
                  ? `${artifacts.length} item${artifacts.length === 1 ? "" : "s"} · screenshots, extracts, files`
                : nav === "teams"
                  ? selectedTeam
                    ? `Team chat · ${selectedTeam.name}`
                    : "Pick or create a team"
                  : nav === "routines"
                    ? `${routines.length} routine${routines.length === 1 ? "" : "s"}`
                    : nav === "settings"
                      ? "Local models · optional cloud frontier"
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

        {nav === "teams" || nav === "routines" ? (
          <div
            style={{
              padding: "12px 24px",
              borderBottom: `1px solid ${colors.border}`,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              background: colors.deep,
            }}
          >
            {nav === "teams" ? (
              <>
                <button
                  type="button"
                  onClick={() => void createDemoTeam()}
                  style={chipBtnStyle}
                >
                  New team chat
                </button>
                {teams.map((tm) => (
                  <button
                    key={tm.id}
                    type="button"
                    onClick={() => void openTeamChat(tm)}
                    style={{
                      ...chipBtnStyle,
                      borderColor: tm.id === selectedTeamId ? colors.accent : colors.border,
                      color: tm.id === selectedTeamId ? colors.accent : colors.textPrimary,
                    }}
                  >
                    {tm.name} · {tm.memberIds.length}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button type="button" onClick={() => void createDemoRoutine()} style={chipBtnStyle}>
                  New interval routine
                </button>
                {routines.map((r) => (
                  <span
                    key={r.id}
                    style={{
                      ...chipBtnStyle,
                      cursor: "default",
                      opacity: r.enabled ? 1 : 0.6,
                    }}
                    title={r.description}
                  >
                    {r.name}
                    {r.nextRunAt ? ` · next ${new Date(r.nextRunAt).toLocaleTimeString()}` : ""}
                    {r.lastRunAt ? ` · last ${new Date(r.lastRunAt).toLocaleTimeString()}` : ""}
                  </span>
                ))}
                {routines.length === 0 ? (
                  <span style={{ color: colors.textMuted, fontSize: 12.5 }}>No routines yet</span>
                ) : null}
              </>
            )}
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
            maxWidth: nav === "artifacts" ? 960 : 820,
            width: "100%",
            margin: "0 auto",
          }}
        >
          {nav === "artifacts" ? (
            <ArtifactsPanel
              artifacts={artifacts}
              selectedId={selectedArtifactId}
              onSelect={(a) => setSelectedArtifactId(a.id)}
              onDelete={(id) => {
                void window.calypso?.deleteArtifact?.(id).then(() => {
                  setArtifacts((prev) => prev.filter((x) => x.id !== id));
                  setSelectedArtifactId((cur) => (cur === id ? null : cur));
                });
              }}
            />
          ) : null}
          {nav === "settings" ? (
            <section
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                padding: 16,
                borderRadius: 14,
                border: `1px solid ${colors.border}`,
                background: colors.raised,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 6 }}>
                  Use cloud frontier models
                </div>
                <p style={{ margin: 0, fontSize: 12.5, color: colors.textMuted, lineHeight: 1.5 }}>
                  Optional OpenAI-compatible cloud for TaskClass <code>frontier</code> (default{" "}
                  <code>gpt-4o</code>). Off by default — when disabled, frontier silently uses the local
                  primary (<code>qwen3:8b</code>). API keys are read from{" "}
                  <code>OPENAI_API_KEY</code> / <code>CALYPSO_OPENAI_API_KEY</code> or the field below;
                  keys are never logged.
                </p>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13.5,
                  cursor: settingsBusy ? "wait" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={!!settings?.cloudModelsEnabled}
                  disabled={settingsBusy || !settings}
                  onChange={(e) => {
                    void saveCloudSettings({ cloudModelsEnabled: e.target.checked });
                  }}
                />
                Enable cloud frontier
              </label>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                API key:{" "}
                {settings?.hasCloudApiKey ? (
                  <span style={{ color: colors.accent }}>available (env or saved)</span>
                ) : (
                  <span>not set — frontier falls back to local while enabled</span>
                )}
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
                Base URL
                <input
                  type="text"
                  value={settingsBaseUrlDraft}
                  disabled={settingsBusy}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setSettingsBaseUrlDraft(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    background: colors.deep,
                    color: colors.textPrimary,
                    fontFamily: typography.fontSans,
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
                Model id
                <input
                  type="text"
                  value={settingsModelIdDraft}
                  disabled={settingsBusy}
                  placeholder="gpt-4o"
                  onChange={(e) => setSettingsModelIdDraft(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    background: colors.deep,
                    color: colors.textPrimary,
                    fontFamily: typography.fontSans,
                  }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
                API key (optional; leave blank to keep env / existing)
                <input
                  type="password"
                  value={settingsApiKeyDraft}
                  disabled={settingsBusy}
                  placeholder={settings?.hasCloudApiKey ? "•••••••• (saved or from env)" : "sk-…"}
                  autoComplete="off"
                  onChange={(e) => setSettingsApiKeyDraft(e.target.value)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    background: colors.deep,
                    color: colors.textPrimary,
                    fontFamily: typography.fontSans,
                  }}
                />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  disabled={settingsBusy}
                  style={chipBtnStyle}
                  onClick={() => {
                    void saveCloudSettings({
                      cloudModelsEnabled: settings?.cloudModelsEnabled,
                      baseUrl: settingsBaseUrlDraft.trim() || undefined,
                      modelId: settingsModelIdDraft.trim() || undefined,
                      ...(settingsApiKeyDraft.trim()
                        ? { apiKey: settingsApiKeyDraft.trim() }
                        : {}),
                    });
                  }}
                >
                  Save frontier settings
                </button>
                <button
                  type="button"
                  disabled={settingsBusy || (!settingsApiKeyDraft && !settings?.hasCloudApiKey)}
                  style={chipBtnStyle}
                  onClick={() => {
                    setSettingsApiKeyDraft("");
                    void saveCloudSettings({
                      cloudModelsEnabled: settings?.cloudModelsEnabled,
                      apiKey: "",
                    });
                  }}
                >
                  Clear saved key
                </button>
              </div>
              {settingsNote ? (
                <div style={{ fontSize: 12.5, color: colors.textSecondary, lineHeight: 1.45 }}>
                  {settingsNote}
                </div>
              ) : null}
            </section>
          ) : null}
          {nav === "artifacts" || nav === "settings" ? null : lines.map((line) => (
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
                  {workers.find((w) => w.id === line.name)?.name ?? line.name}
                </div>
              ) : null}
              {line.role === "system" ? line.content : <Markdown text={line.content} />}
              {line.streaming ? <span style={{ opacity: 0.6 }}>▍</span> : null}
            </article>
          ))}
        </div>

        {nav === "artifacts" || nav === "settings" ? null : (
        <ChatComposer
          onSend={onSend}
          disabled={modelWarming}
          enableVoice
          onVoiceError={(message) => {
            setLines((prev) => [
              ...prev,
              { id: `sys-${Date.now()}`, role: "system", content: message },
            ]);
          }}
          placeholder={
            modelWarming
              ? "Warming up local model…"
              : nav === "teams" && selectedTeam
                ? `Message team ${selectedTeam.name}…`
                : selected
                  ? `Message ${selected.name}…`
                  : "Message Calypso…"
          }
        />
        )}
      </AppShell>

      {browserRuntimeProgress ? (
        <RuntimeProgressBanner
          title="Browser runtime"
          progress={browserRuntimeProgress}
          stackIndex={inferenceRuntimeProgress ? 1 : 0}
          onDismiss={
            browserRuntimeProgress.phase === "ready" || browserRuntimeProgress.phase === "error"
              ? () => setBrowserRuntimeProgress(null)
              : undefined
          }
        />
      ) : null}
      {inferenceRuntimeProgress ? (
        <RuntimeProgressBanner
          title="Local models"
          progress={inferenceRuntimeProgress}
          stackIndex={0}
          onDismiss={
            inferenceRuntimeProgress.phase === "ready" ||
            inferenceRuntimeProgress.phase === "error" ||
            inferenceRuntimeProgress.phase === "install"
              ? () => setInferenceRuntimeProgress(null)
              : undefined
          }
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

const chipBtnStyle: CSSProperties = {
  fontSize: 12.5,
  padding: "6px 12px",
  borderRadius: 999,
  border: `1px solid ${colors.border}`,
  background: colors.raised,
  color: colors.textPrimary,
  cursor: "pointer",
};

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
    case "artifacts":
      return "Artifacts";
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
