import type { Tool } from "@calypso/shared";
import { fsReadTool, fsWriteTool } from "./fs.js";
import { terminalExecTool } from "./terminal.js";
import { codeExecTool } from "./code.js";

export { fsReadTool, fsWriteTool, terminalExecTool, codeExecTool };

export function createSystemTools(): Tool[] {
  return [fsReadTool, fsWriteTool, terminalExecTool, codeExecTool];
}
