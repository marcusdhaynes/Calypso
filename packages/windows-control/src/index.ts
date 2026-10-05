/**
 * @calypso/windows-control (owner: Trice)
 *
 * Usage from core:
 *   const wc = createWindowsControl({ bus });
 *   registry.register(...wc.tools);
 *   // IPC controlCommand → wc.controller.handleCommand(cmd)
 *   // live view opened → const stop = wc.controller.watchFrames(); closed → stop()
 *   // global stop hotkey / tray → wc.controller.stopAll() / pauseAll() / resumeAll()
 */
import type { Tool } from "@calypso/shared";
import { ComputerController, type ControllerOptions, type EventPublisher } from "./control.js";
import { createDefaultHost, type PowerShellHost, type ProcessPowerShellHostOptions } from "./host.js";
import {
  createCloseTool,
  createComputerTool,
  createLaunchTool,
  createObserveTool,
  createPowerShellTool,
} from "./tools.js";

export * from "./protocol.js";
export {
  ProcessPowerShellHost,
  StubPowerShellHost,
  createDefaultHost,
  defaultHostScriptPath,
  nextRequestId,
  type PowerShellHost,
  type ProcessPowerShellHostOptions,
} from "./host.js";
export {
  ComputerController,
  ControlInterruptedError,
  describeAction,
  type ControllerOptions,
  type EventPublisher,
  type ExecuteOptions,
} from "./control.js";
export {
  createCloseTool,
  createComputerTool,
  createLaunchTool,
  createObserveTool,
  createPowerShellTool,
  runComputerAction,
  runPowerShell,
  type PowerShellRunResult,
} from "./tools.js";

export interface WindowsControl {
  host: PowerShellHost;
  controller: ComputerController;
  tools: Tool[];
  dispose(): Promise<void>;
}

export function createWindowsControl(
  deps: { bus?: EventPublisher; host?: PowerShellHost; hostOptions?: ProcessPowerShellHostOptions; controller?: ControllerOptions } = {}
): WindowsControl {
  const host = deps.host ?? createDefaultHost(deps.hostOptions);
  const controller = new ComputerController(host, deps.bus, deps.controller);
  return {
    host,
    controller,
    tools: [
      createComputerTool(controller),
      createObserveTool(controller),
      createLaunchTool(controller),
      createCloseTool(controller),
      createPowerShellTool(),
    ],
    async dispose() {
      await controller.dispose();
      await host.stop();
    },
  };
}

/** Back-compat with the scaffold signature. */
export function createWindowsControlTools(host?: PowerShellHost, bus?: EventPublisher): Tool[] {
  return createWindowsControl({ host, bus }).tools;
}
