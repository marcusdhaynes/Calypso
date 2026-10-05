import { contextBridge, ipcRenderer } from "electron";
import type {
  CalypsoEvent,
  CalypsoIpcApi,
  ControlSessionCommand,
  Conversation,
  ConversationId,
  ConversationInput,
  CoreStreamPush,
  Project,
  ProjectInput,
  Team,
  TeamInput,
  Worker,
  WorkerId,
  WorkerInput,
} from "@calypso/shared";

const api: CalypsoIpcApi = {
  onEvent(handler) {
    const listener = (_event: Electron.IpcRendererEvent, payload: CalypsoEvent) => {
      handler(payload);
    };
    ipcRenderer.on("calypso:event", listener);
    return () => {
      ipcRenderer.removeListener("calypso:event", listener);
    };
  },
  onStream(handler) {
    const listener = (_event: Electron.IpcRendererEvent, payload: CoreStreamPush) => {
      handler(payload);
    };
    ipcRenderer.on("calypso:stream", listener);
    return () => {
      ipcRenderer.removeListener("calypso:stream", listener);
    };
  },
  listWorkers: () => ipcRenderer.invoke("calypso:listWorkers"),
  createWorker: (worker: WorkerInput) => ipcRenderer.invoke("calypso:createWorker", worker),
  updateWorker: (worker: Worker) => ipcRenderer.invoke("calypso:updateWorker", worker),
  listTeams: () => ipcRenderer.invoke("calypso:listTeams"),
  createTeam: (team: TeamInput) => ipcRenderer.invoke("calypso:createTeam", team),
  updateTeam: (team: Team) => ipcRenderer.invoke("calypso:updateTeam", team),
  listProjects: () => ipcRenderer.invoke("calypso:listProjects"),
  createProject: (project: ProjectInput) => ipcRenderer.invoke("calypso:createProject", project),
  updateProject: (project: Project) => ipcRenderer.invoke("calypso:updateProject", project),
  listConversations: () => ipcRenderer.invoke("calypso:listConversations"),
  createConversation: (conversation: ConversationInput) =>
    ipcRenderer.invoke("calypso:createConversation", conversation),
  updateConversation: (conversation: Conversation) =>
    ipcRenderer.invoke("calypso:updateConversation", conversation),
  listMessages: (conversationId: ConversationId) =>
    ipcRenderer.invoke("calypso:listMessages", conversationId),
  getTaskGraph: () => ipcRenderer.invoke("calypso:getTaskGraph"),
  sendMessage: (conversationId: ConversationId, content: string, workerId?: WorkerId) =>
    ipcRenderer.invoke("calypso:sendMessage", conversationId, content, workerId),
  resolvePermission: (requestId: string, allow: boolean) =>
    ipcRenderer.invoke("calypso:resolvePermission", requestId, allow),
  controlCommand: (command: ControlSessionCommand) =>
    ipcRenderer.invoke("calypso:controlCommand", command),
  watchFrames: () => ipcRenderer.invoke("calypso:watchFrames"),
  unwatchFrames: () => ipcRenderer.invoke("calypso:unwatchFrames"),
  stopAll: () => ipcRenderer.invoke("calypso:stopAll"),
  pauseWorkers: () => ipcRenderer.invoke("calypso:pauseWorkers"),
  resumeWorkers: () => ipcRenderer.invoke("calypso:resumeWorkers"),
  getFirstRunPlan: () => ipcRenderer.invoke("calypso:getFirstRunPlan"),
  getModelStatus: () => ipcRenderer.invoke("calypso:getModelStatus"),
  getAppInfo: () => ipcRenderer.invoke("calypso:getAppInfo"),
};

contextBridge.exposeInMainWorld("calypso", api);

ipcRenderer.on("calypso:tray", (_e, payload: { action: string }) => {
  window.dispatchEvent(new CustomEvent("calypso:tray", { detail: payload }));
});
