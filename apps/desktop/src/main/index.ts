import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CalypsoEvent, CorePush, CoreRequest, CoreResponse } from "@calypso/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let coreProc: UtilityProcess | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqSeq = 0;

function coreScriptPath(): string {
  return path.join(__dirname, "../core-process/index.js");
}

function startCoreProcess(): void {
  coreProc = utilityProcess.fork(coreScriptPath(), [], {
    serviceName: "calypso-core",
    stdio: "pipe",
  });

  coreProc.on("message", (msg: CoreResponse | CorePush) => {
    if ("channel" in msg && msg.channel === "event") {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("calypso:event", msg.event as CalypsoEvent);
      }
      return;
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
}

function callCore<T = unknown>(
  method: CoreRequest["method"],
  params?: unknown
): Promise<T> {
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Calypso",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else if (!app.isPackaged && process.env.NODE_ENV !== "production") {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("calypso:getAppInfo", () => callCore("getAppInfo"));
  ipcMain.handle("calypso:listWorkers", () => callCore("listWorkers"));
  ipcMain.handle("calypso:getTaskGraph", () => callCore("getTaskGraph"));
  ipcMain.handle(
    "calypso:sendMessage",
    (_e, conversationId: string, content: string) =>
      callCore("sendMessage", { conversationId, content })
  );
  ipcMain.handle(
    "calypso:resolvePermission",
    (_e, requestId: string, allow: boolean) =>
      callCore("resolvePermission", { requestId, allow })
  );
  ipcMain.handle("calypso:controlCommand", (_e, command: unknown) =>
    callCore("controlCommand", { command })
  );
}

app.whenReady().then(() => {
  startCoreProcess();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    coreProc?.kill();
    app.quit();
  }
});
