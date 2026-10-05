import type { Tool } from "@calypso/shared";
import { StubPowerShellHost, type PowerShellHost } from "./host.js";
import { createComputerActionTool } from "./computer.js";

export {
  StubPowerShellHost,
  type PowerShellHost,
  type HostRequest,
  type HostResponse,
} from "./host.js";
export { runComputerAction, createComputerActionTool } from "./computer.js";

export function createWindowsControlTools(host?: PowerShellHost): Tool[] {
  const h = host ?? new StubPowerShellHost();
  return [createComputerActionTool(h)];
}
