# Calypso integration map

The existing Calypso repository was inspected before this rebuild. Original packages and contracts remain in the repository; no historical app database is overwritten. The new interface connects to OpenClaw through a private local bridge.

| Calypso capability | Unified implementation |
| --- | --- |
| Agents/workers | Names, roles, editable instructions; real OpenClaw agent creation when connected; browser-local profiles when offline |
| Teams | Reusable member groups, project assignment, and shared conversations with selectable speakers |
| Projects | Create-and-start form, private workspace folders, dependency-ordered assignments, activity and results |
| Conversations | Saved individual and team chats, direct local token streaming, escaped formatting, separate histories |
| Model routing | Installed local models only, readiness checks, manual selection; native cloud settings and paid fallback blocked |
| Task graph and recovery | Sequential execution, phase receipts, pause/stop through OpenClaw, explicit resume, review and follow-up |
| Routines | Persistent recurring project schedules; saved paused until enabled; no browser window required after starting the local engine |
| Memory | Explicit global/project/agent/team context; local persistence; original SQLite and vector-memory APIs retained |
| Browser | Actual OpenClaw browser tabs/open actions and tool-enabled web projects; original Playwright package retained |
| Computer use | Project-based tasks through installed OpenClaw tools, pause/stop, optional private local screen preview; original Windows host, input takeover/FIFO and frame APIs retained |
| Artifacts | Project files, phase reports, downloads, bounded uploads without overwrites; original artifact registry retained |
| Voice | Browser dictation when supported and optional on-device speech output; no paid transcription API |
| Permission gate | Original native gate retained; OpenClaw tasks use its configured tool/approval policy; hosted browsers require local pairing |
| Desktop | Sandboxed Electron shell, background tray behavior and Windows/macOS/Linux packaging workflow |
| Design and portability | Calypso ocean palette, light/dark modes, responsive layout, keyboard search, installable PWA, offline draft authoring and JSON export |

## Verified checks

- New bridge suite: project execution and files, saved results, false-success prevention, failure boundaries, schedules, memory/teams, streamed chat, free-only enforcement, origin/pairing protection, idempotent draft import, upload restrictions and reasoning-tag filtering.
- Original core: 14 checks covering execution, team plans, cancellation, retry, worker messages, restart persistence, routines, artifacts, and check/retry behavior.
- Windows control: 9 simulated-host checks pass; one optional real-PowerShell check skips in this environment.
- All original workspace TypeScript checks pass after building package declarations.
- A real chat response was obtained from the installed local LFM2.5 8B model; real OpenClaw agents and the earlier test project appear in the new workspace.

## Practical limits

GitHub Pages serves the interface, not Ollama or an always-on agent server. Models and computer tools need the local bridge, OpenClaw, and an awake computer. There is no remote desktop relay or internet-exposed bridge. On a phone, loopback refers to that phone; remote access to a desktop is not configured.

The web UI covers the user-facing workspace sections above. Some advanced original native APIs, automatic model downloading/benchmarking, and low-level control-session controls remain in the preserved packages rather than being reimplemented as web controls. Original SQLite history is preserved but not automatically imported; the previous Projects dashboard is imported when present. Offline import currently brings draft projects, profiles, and memories into the local workspace; browser-only conversations, teams, and routines are not merged automatically.

Arbitrary desktop automation, browser dictation, screen capture, and unsigned platform packages depend on system support and are not guaranteed by unit tests. Local model reasoning quality and throughput remain hardware-dependent. This is a working integration with these explicit limits, not a guarantee of flawless execution for every task.
