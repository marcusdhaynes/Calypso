# Calypso

Windows desktop agent orchestration platform. Electron + React + TypeScript (Vite) shell, TypeScript core with a persistent task graph, local/cloud model routing, and tool packages for Windows control, browser, and system ops.

Packaged with **electron-builder** into NSIS + portable (`Calypso-Setup-*.exe` / `Calypso-Portable-*.exe`). Target: Windows x64, `productName` / `executableName`: **Calypso**. Pack on Windows — see [`apps/desktop/PACKAGING.md`](apps/desktop/PACKAGING.md).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main (thin shell)                                 │
│    windows, lifecycle, bridges MessagePort ↔ IPC            │
├─────────────────────────────────────────────────────────────┤
│  Renderer (React + @calypso/ui)                             │
│    talks to core over typed CoreRequest/Response/Push       │
├─────────────────────────────────────────────────────────────┤
│  utilityProcess: @calypso/core                              │
│    orchestrator, task graph, workers, teams, bus, memory,   │
│    scheduler, PermissionGate                                │
│    (same protocol can later ride localhost WebSocket)       │
├──────────────┬──────────────────┬───────────────────────────┤
│ @calypso/    │ @calypso/        │ @calypso/models           │
│ windows-     │ browser          │ ModelProvider + Router    │
│ control      │ (Playwright)     │                           │
└──────────────┴──────────────────┴───────────────────────────┘
         ▲ all cross-talk via @calypso/shared contracts only
```

### Process model

- **`packages/core` runs in an Electron `utilityProcess`**, separate from the main process.
- The renderer never imports core directly; it uses the typed message channel (`CoreRequest` / `CoreResponse` / `CorePush` in `@calypso/shared`), bridged by main via IPC today.
- That channel is designed so it can also be served over **localhost WebSocket** later — keeping the UI shell swappable and the UI responsive while core does heavy work.

### Persistence

SQLite via **better-sqlite3** in `@calypso/core` (`CalypsoDatabase` + `SqliteMemoryStore`):

- Workers, teams, projects, tasks, routines, conversations, messages, and memory share one `calypso.sqlite` file.
- `new Orchestrator({ databasePath })` or `{ persist: true, userDataRoot }` opens the DB; omit both for in-memory (tests).
- Memory `retrieve()` is scoped + limited (keyword + optional cosine via Angen's `createLocalEmbeddingProvider` / `nomic-embed-text` on CPU). Never dump the whole store into a prompt.
- Smoke: `node packages/core/test/sqlite-smoke.mjs` (after `npm run build -w @calypso/core`).
- Agent runtime tests: `npm test -w @calypso/core` (fake ModelProvider; no Ollama required).

### Agent runtime (Anky / `@calypso/core`)

- **`WorkerRuntime`**: Plan → Execute → Observe → Verify loop with bounded context (instructions, memory scopes, recent messages, tool schemas), `ModelRouter.resolve`, streaming via `provider.stream`, gated `executeToolCall`, max-iteration / timeout / AbortSignal, retry-once on transient model errors. Publishes `worker.status` and `CoreStreamPush` tokens; writes worker Messages + episode memory on completion.
- **`Planner`**: Leader produces structured Plan JSON → validate/repair → `materializePlan` → assign steps by `suggestedRole` / skills. Root task waits; children run when deps complete.
- **`TaskDispatcher`**: Background concurrency-limited queue (default 2), one task per worker, `cancel` / `retry` / `pause` / `resume`, parent completion when all children succeed (fail if a child fails). Routine scheduler fires create tasks that flow into the dispatcher.
- **Worker messaging**: `sendWorkerMessage` → `bus.chat` + persisted Message (auto-resolves team group conversation via `ensureTeamConversation` / `Team.conversationId`); built-in tools `team.message` (read) and `team.delegate` (write). Desktop Teams nav shows the shared chat; `createTeam` wires it.
- **Routines E2E**: `createRoutine` fills `nextRunAt`, scheduler tick enqueues tasks, desktop Routines nav lists/creates interval routines; IPC `list/create/update/deleteRoutine`.
- **Desktop entry**: prefer `orchestrator.handleUserMessage({ conversationId, content, workerId? })` + `orchestrator.setStreamHandler(push => …)` instead of a monolithic one-shot prompt. Also: `pauseWorkers` / `resumeWorkers` / `cancelTask` / `retryTask` on the Orchestrator.

**Contract additions (Anky, additive):** `Team.conversationId?`; `RoutineInput`; CoreRequest/IPC `listRoutines`/`createRoutine`/`updateRoutine`/`deleteRoutine`/`sendWorkerChat`; events `routine.updated`/`team.updated`.  `Task.conversationId?` / `teamId?` / `retryCount?`; `PlanStep.suggestedRole?` / `suggestedWorkerId?`; `ChatMessage.tool_calls?` + `ChatToolCall`; CoreRequest / CalypsoIpcApi `cancelTask` / `retryTask` (wired through desktop IPC).

### Models

`ModelProvider` speaks the OpenAI-compatible chat API (streaming). `ModelRouter` picks by `TaskClass`: `simple | normal | code | vision | reasoning | frontier`. Pluggable: Ollama, llama.cpp server, optional cloud.

### Tools & permissions

Every `Tool` declares a `ToolClass` and **must** call `PermissionGate.check` before side effects. Default policy: `AutonomyLevel × ToolClass → allow | ask | deny` (see `DEFAULT_PERMISSION_POLICY` in contracts). `ask` publishes `permission.asked` so the UI can prompt; resolve via `permission.resolved` / `resolvePermission` IPC.

## Packages

| Package | Name | Owner | Responsibility |
|---------|------|-------|----------------|
| `packages/shared` | `@calypso/shared` | (contracts) | **Only** cross-package API surface |
| `packages/core` | `@calypso/core` | **Anky** | Orchestrator, task graph, workers, teams, bus, memory, scheduler, PermissionGate |
| `packages/windows-control` | `@calypso/windows-control` | **Trice** | Long-lived PowerShell host (stdin/stdout JSON), UI Automation, SendInput, windows/processes, files, screenshots |
| `packages/browser` | `@calypso/browser` | **Spin** | Playwright + managed Chromium, persistent context per worker |
| `packages/tools-system` | `@calypso/tools-system` | (shared / Tyran) | Filesystem, terminal, code exec |
| `packages/models` | `@calypso/models` | **Angen** | Providers, ModelRouter, hardware benchmark stub |
| `packages/ui` | `@calypso/ui` | **Theriz** | Design system |
| `apps/desktop` | `@calypso/desktop` | **Theriz** (shell/packaging/QA) + **Tyran** (integration) | Electron main, preload, renderer, utilityProcess entry, electron-builder |

**Voice, packaging, QA:** Theriz · **Integration:** Tyran

## Rule: contracts only

> Subsystems talk **only** through `@calypso/shared` contracts.  
> Do not import implementation details across package boundaries.

## Dev commands

```bash
# from repo root
npm install
npm run build          # build all packages + desktop (main/preload/core/renderer)
npm run typecheck      # tsc --noEmit across workspaces
npm run dev -w @calypso/desktop   # vite + electron (after a main/preload/core build)

# Windows packaging (run on Windows CI / machine)
npm run pack:win -w @calypso/desktop
```

Workspace layout uses npm workspaces (`apps/*`, `packages/*`). `pnpm-workspace.yaml` is present if you prefer pnpm.

## Key contracts (`packages/shared/src/contracts.ts`)

Worker, WorkerStatus, AutonomyLevel, Team, Project, Artifact, Conversation, Message, Task / TaskGraph, Plan, Tool / ToolCall / ToolResult, ToolClass, ToolPermission, PermissionGate / PermissionDecision, DEFAULT_PERMISSION_POLICY, ModelProvider, ModelRouter, TaskClass, MemoryStore / MemoryEntry / MemoryScope, Routine, BrowserSession / BrowserAction, ComputerAction, ActionResult, ControlSession / ControlSessionCommand, CalypsoEvent, CoreRequest / CoreResponse / CorePush, CalypsoIpcApi.

## Windows control (`@calypso/windows-control`, Trice)

- `createWindowsControl({ bus })` returns `{ host, controller, tools }`. Register `tools` with core, route the `controlCommand` IPC to `controller.handleCommand(cmd)`, call `controller.watchFrames()` while the live view is open (returns an unsubscribe), and wire the global stop hotkey / tray to `controller.stopAll()`, `pauseAll()`, `resumeAll()`.
- Tools: `windows.computer` (input_control), `windows.observe` (read), `windows.launch_app` (process), `windows.close_app` (process, or destructive with `force`), `windows.powershell` (process). All call the PermissionGate first.
- One long-lived `powershell.exe` runs `packages/windows-control/host/calypso-host.ps1` over stdin/stdout JSON lines. It must stay outside the asar (`build.asarUnpack` covers it), or set `CALYPSO_PS_HOST_SCRIPT`.
- Real user mouse/keyboard input, or Pause/Stop/Take Control, aborts the in-flight action immediately and sets the session to `user_controlling` / `paused` / `stopped`. Only one worker drives the mouse at a time; others wait in order.
- Contract addition: `ControlFrame` and the `control.frame` event (live view frames, JPEG data URLs, ~2 fps while watched).
- Off Windows the package uses `StubPowerShellHost`, which returns `host_unavailable`. Tests: `npm test -w @calypso/windows-control`.

## Browser (`@calypso/browser`, Spin)

- `createBrowserControl({ dataRoot, browsersPath })` returns `{ manager, tools, ensureRuntime, getRuntimeStatus }`. Register `tools` with core; call `await browser.ensureRuntime()` (or open a session — it ensures first) before a worker browses; pass `sessionId` into every tool call; `await browser.dispose()` on quit.
- **Chromium is not bundled in Calypso.exe.** First-run / first browse downloads it into `userData/ms-playwright` via `PLAYWRIGHT_BROWSERS_PATH`. Progress events: `browser.runtime.progress` / `browser.runtime.ready`. IPC: `ensureBrowserRuntime`, `getBrowserRuntimeStatus` (includes `estimatedDownloadMb: 300` for the consent step).
- Tools: `browser.navigate` (network / `browser_offorigin_nav` when leaving the allow-list), `browser.click` / `browser.type` (write), `browser.extract` / `browser.snapshot` (read), `browser.newTab` (network), `browser.upload` / `browser.download` (dedicated classes). All call the PermissionGate first.
- DomLocator-first (`role` / `label` / `text` / `css` / `testId` / `xpath`). Each `BrowserAction` returns an `ActionResult` with verify-after-act.
- One Chromium process, persistent storage per session under `dataRoot/<sessionId>/`. Headless by default; set `CALYPSO_BROWSER_HEADED=1` for a visible window.
- Smoke: `node packages/browser/test/smoke.mjs` (after `npm run build -w @calypso/browser`). Runtime smoke: `node packages/browser/test/runtime-smoke.mjs`.
- **Contract note (Spin):** added `BrowserRuntimeProgress` / `BrowserRuntimeStatus`, events `browser.runtime.progress` + `browser.runtime.ready`, and CoreRequest methods `ensureBrowserRuntime` / `getBrowserRuntimeStatus`.

## Artifacts panel (Spin)

Screenshots (`browser.snapshot`), extracts (`browser.extract`), and downloads (`browser.download`) are persisted to SQLite (`artifacts` table, schema v2) and files under `userData/artifacts/`. UI: sidebar **Artifacts** → `ArtifactsPanel`. IPC: `listArtifacts` / `createArtifact` / `deleteArtifact`; event `artifact.created`.

**Contract note (Spin):** added `ArtifactInput`, CoreRequest methods `listArtifacts` / `createArtifact` / `deleteArtifact`.

