import { contextBridge, ipcRenderer } from "electron";
import type {
  CalypsoEvent,
  CalypsoIpcApi,
  ControlSessionCommand,
  ConversationId,
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
  listWorkers: () => ipcRenderer.invoke("calypso:listWorkers"),
  getTaskGraph: () => ipcRenderer.invoke("calypso:getTaskGraph"),
  sendMessage: (conversationId: ConversationId, content: string) =>
    ipcRenderer.invoke("calypso:sendMessage", conversationId, content),
  resolvePermission: (requestId: string, allow: boolean) =>
    ipcRenderer.invoke("calypso:resolvePermission", requestId, allow),
  controlCommand: (command: ControlSessionCommand) =>
    ipcRenderer.invoke("calypso:controlCommand", command),
  getAppInfo: () => ipcRenderer.invoke("calypso:getAppInfo"),
};

contextBridge.exposeInMainWorld("calypso", api);
