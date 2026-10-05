import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  Notification,
  ipcMain,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CalypsoEvent, CorePush, CoreRequest, CoreResponse } from "@calypso/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let coreProc: UtilityProcess | null = null;
let tray: Tray | null = null;
let quitting = false;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqSeq = 0;

function coreScriptPath(): string {
  return path.join(__dirname, "../core-process/index.js");
}

function databasePath(): string {
  return path.join(app.getPath("userData"), "calypso.sqlite");
}

function startCoreProcess(): void {
  coreProc = utilityProcess.fork(coreScriptPath(), [], {
    serviceName: "calypso-core",
    stdio: "pipe",
    env: {
      ...process.env,
      CALYPSO_DATABASE_PATH: databasePath(),
    },
  });

  coreProc.on("message", (msg: CoreResponse | CorePush) => {
    if ("channel" in msg) {
      if (msg.channel === "event") {
        const event = msg.event as CalypsoEvent;
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("calypso:event", event);
        }
        maybeNotify(event);
        return;
      }
      if (msg.channel === "stream") {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("calypso:stream", msg);
        }
        return;
      }
    }
    const res = msg as CoreResponse;
    const waiter = pending.get(res.id);
    if (!waiter) return;
    pending.delete(res.id);
    if (res.ok) waiter.resolve(res.result);
    else waiter.reject(new Error(res.error));
  });

  coreProc.on("exit", (code) => {
    console.error(`calypso-core exited with code ${code}`);
    coreProc = null;
  });

  coreProc.stdout?.on("data", (buf: Buffer) => {
    console.log(`[core] ${buf.toString().trimEnd()}`);
  });
  coreProc.stderr?.on("data", (buf: Buffer) => {
    console.error(`[core] ${buf.toString().trimEnd()}`);
  });
}

function callCore<T = unknown>(method: CoreRequest["method"], params?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!coreProc) {
      reject(new Error("core utilityProcess not running"));
      return;
    }
    const id = `req_${++reqSeq}_${Date.now()}`;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    const req = { id, method, params } as CoreRequest;
    coreProc.postMessage(req);
  });
}

function maybeNotify(event: CalypsoEvent): void {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  if (!Notification.isSupported()) return;

  if (event.type === "task.status" && event.status === "completed") {
    new Notification({ title: "Calypso", body: `Task completed: ${event.taskId}` }).show();
  } else if (event.type === "task.updated" && event.task.status === "completed") {
    new Notification({
      title: "Calypso",
      body: `Task completed: ${event.task.title}`,
    }).show();
  } else if (event.type === "task.updated" && event.task.status === "failed") {
    new Notification({
      title: "Calypso",
      body: `Task failed: ${event.task.title}${event.task.error ? ` — ${event.task.error}` : ""}`,
    }).show();
  } else if (event.type === "permission.asked") {
    new Notification({
      title: "Calypso — approval needed",
      body: event.reason || `Worker wants to run ${event.toolCall.toolName}`,
    }).show();
  }
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: "Calypso",
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.ELECTRON_RENDERER_URL;
  const rendererHtml = path.join(__dirname, "../renderer/index.html");
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else if (
    !app.isPackaged &&
    process.env.NODE_ENV !== "production" &&
    process.env.CALYPSO_USE_VITE === "1"
  ) {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(rendererHtml);
  }

  mainWindow.on("close", (e) => {
    if (quitting) return;
    // Close-to-tray: keep core running in the background.
    e.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray(): void {
  // 1x1 transparent PNG fallback; Electron accepts empty image on Linux/CI.
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Calypso");
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => showMainWindow(),
    },
    {
      label: "Pause workers",
      click: () => {
        void callCore("pauseWorkers").catch((err) => console.error(err));
      },
    },
    {
      label: "Resume workers",
      click: () => {
        void callCore("resumeWorkers").catch((err) => console.error(err));
      },
    },
    {
      label: "New command",
      click: () => {
        showMainWindow();
        mainWindow?.webContents.send("calypso:tray", { action: "new-command" });
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => showMainWindow());
}

function registerHotkeys(): void {
  const ok = globalShortcut.register("CommandOrControl+Alt+Escape", () => {
    void callCore("stopAll").catch((err) => console.error("stopAll failed", err));
  });
  if (!ok) {
    console.warn("Failed to register global stop hotkey Ctrl+Alt+Esc");
  }
}

function registerIpc(): void {
  const bridge = (method: CoreRequest["method"]) => (_e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
    // Map invoke args → params object per method
    switch (method) {
      case "sendMessage":
        return callCore(method, {
          conversationId: args[0],
          content: args[1],
          workerId: args[2],
        });
      case "resolvePermission":
        return callCore(method, { requestId: args[0], allow: args[1] });
      case "controlCommand":
        return callCore(method, { command: args[0] });
      case "createWorker":
        return callCore(method, { worker: args[0] });
      case "updateWorker":
        return callCore(method, { worker: args[0] });
      case "createTeam":
        return callCore(method, { team: args[0] });
      case "updateTeam":
        return callCore(method, { team: args[0] });
      case "createProject":
        return callCore(method, { project: args[0] });
      case "updateProject":
        return callCore(method, { project: args[0] });
      case "createConversation":
        return callCore(method, { conversation: args[0] });
      case "updateConversation":
        return callCore(method, { conversation: args[0] });
      case "listMessages":
        return callCore(method, { conversationId: args[0] });
      case "openBrowserSession":
        return callCore(method, { workerId: args[0], projectId: args[1] });
      default:
        return callCore(method);
    }
  };

  const methods: CoreRequest["method"][] = [
    "getAppInfo",
    "getModelStatus",
    "getFirstRunPlan",
    "ensureBrowserRuntime",
    "getBrowserRuntimeStatus",
    "listWorkers",
    "createWorker",
    "updateWorker",
    "listTeams",
    "createTeam",
    "updateTeam",
    "listProjects",
    "createProject",
    "updateProject",
    "listConversations",
    "createConversation",
    "updateConversation",
    "listMessages",
    "getTaskGraph",
    "sendMessage",
    "resolvePermission",
    "controlCommand",
    "watchFrames",
    "unwatchFrames",
    "stopAll",
    "pauseWorkers",
    "resumeWorkers",
    "openBrowserSession",
    "shutdown",
  ];
  for (const m of methods) {
    ipcMain.handle(`calypso:${m}`, bridge(m));
  }
}

app.whenReady().then(async () => {
  startCoreProcess();
  registerIpc();
  createTray();
  registerHotkeys();
  createWindow();
  app.on("activate", () => {
    showMainWindow();
  });

  // Headless e2e helpers (CALYPSO_E2E_SMOKE / CALYPSO_E2E_VERIFY).
  if (process.env.CALYPSO_E2E_SMOKE === "1" || process.env.CALYPSO_E2E_VERIFY === "1") {
    void runE2eProbe();
  }
});

async function runE2eProbe(): Promise<void> {
  const outPath = process.env.CALYPSO_E2E_OUT ?? "/tmp/calypso-e2e.json";
  const shotPath = process.env.CALYPSO_E2E_SHOT ?? "/tmp/calypso-e2e.png";
  // Wait for core to come up.
  for (let i = 0; i < 40; i++) {
    try {
      await callCore("getAppInfo");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  try {
    if (process.env.CALYPSO_E2E_SMOKE === "1") {
      const worker = await callCore("createWorker", {
        worker: {
          id: "e2e_worker_1",
          name: "E2E Worker",
          avatar: "e2e",
          role: "tester",
          personality: "precise",
          instructions: "Persist across restarts",
          skills: ["test"],
          tools: [],
          permissions: [],
          preferredModel: "normal",
          workspace: ".",
          autonomyLevel: "ask",
          status: "idle",
        },
      });
      const workers = (await callCore("listWorkers")) as unknown[];
      // Give the window a moment to paint.
      await new Promise((r) => setTimeout(r, 1500));
      if (mainWindow && !mainWindow.isDestroyed()) {
        const img = await mainWindow.webContents.capturePage();
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        mkdirSync(dirname(shotPath), { recursive: true });
        writeFileSync(shotPath, img.toPNG());
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        outPath,
        JSON.stringify({ ok: true, phase: "smoke", worker, workers: workers.length, shotPath }, null, 2)
      );
      quitting = true;
      app.quit();
      return;
    }

    if (process.env.CALYPSO_E2E_VERIFY === "1") {
      const workers = (await callCore("listWorkers")) as Array<{ id: string; name: string }>;
      const found = workers.some((w) => w.id === "e2e_worker_1");
      await new Promise((r) => setTimeout(r, 1000));
      if (mainWindow && !mainWindow.isDestroyed()) {
        const img = await mainWindow.webContents.capturePage();
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        mkdirSync(dirname(shotPath), { recursive: true });
        writeFileSync(shotPath, img.toPNG());
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        outPath,
        JSON.stringify({ ok: found, phase: "verify", workers, shotPath }, null, 2)
      );
      quitting = true;
      app.quit();
    }
  } catch (err) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      outPath,
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }, null, 2)
    );
    quitting = true;
    app.quit();
  }
}

app.on("before-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  const proc = coreProc;
  if (proc) {
    void callCore("shutdown")
      .catch(() => undefined)
      .finally(() => {
        proc.kill();
        if (coreProc === proc) coreProc = null;
      });
  }
});

app.on("window-all-closed", () => {
  // Keep running in tray on all platforms while not quitting.
  if (quitting && process.platform !== "darwin") {
    app.quit();
  }
});
