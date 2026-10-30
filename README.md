# Calypso

**A whole crew behind every idea.**

[Live app](https://marcusdhaynes.github.io/Calypso/) · [GitHub Actions](https://github.com/marcusdhaynes/Calypso/actions) · [Feature map and verification](docs/FEATURES.md)

Calypso combines a lightweight workspace with OpenClaw and free local AI. Projects, agents, teams, saved conversations, routines, browser tasks, computer use, artifacts, and memory share an ocean-and-teal interface. The web shell is about 93 KB uncompressed, with zero runtime dependencies.

## Run locally

Install Node.js 22.13+ (24 recommended), Ollama with a downloaded local model, and OpenClaw with its gateway running.

The locally verified recommendation for this machine is `qwen3.5:4b` (`ollama pull qwen3.5:4b`, about 3.3 GB of local weights). Its build-and-review check created a real project file and independently read it back. LFM2.5 remains selectable, but its tool-use checks were less reliable here.

```sh
git clone https://github.com/marcusdhaynes/Calypso.git
cd Calypso
npm start
```

Open **http://127.0.0.1:18791/**. The web app and bridge need no dependency installation. The local engine continues working after its browser tab is closed. It must remain running while the computer is awake for scheduled work.

Custom installs can set `OPENCLAW_CLI` to `openclaw.mjs`, `CALYPSO_NODE` to the Node executable, `CALYPSO_DATA_DIR` to a private data folder, or `PORT` to a different listening port.

## Updating the local engine

Changes to this GitHub repository and the published web interface do not automatically update a Calypso engine already running on your computer. To install fixes to chat, search, and other local features, stop the existing Calypso process (Ctrl+C in its terminal, or quit the desktop app), update the source with `git pull` in the Calypso repository folder, then restart it with `npm start`. Refresh the web app and pair the browser again if prompted. On packaged desktop installs, install a newly built desktop release instead of running `git pull` inside the package. The Conversations screen warns when the paired engine does not advertise updated live search support.

Live searches use public RSS/news feeds. Sources can be missing, delayed or unreachable, and no-feed results are not proof that a reported event never occurred. Direct conversation uses local Ollama models for most questions; background project tools use OpenClaw.

## Live GitHub app

GitHub Actions tests and publishes the app on every push to `main`. The hosted interface saves project drafts, agent profiles, teams, paused routines, and memories in that browser. It does not pretend to run agents while disconnected.

To use local models and tools from the hosted app, keep the local engine running, choose **Settings → Connect local engine**, and approve the connection in its local window. Browser local-network permission may also be needed. Pairing resets when the bridge restarts. **Import browser drafts** imports draft projects and memories; they remain drafts until started. Browser-only conversations, teams, and routines are not merged automatically.

GitHub Pages is static hosting. It cannot execute Ollama, OpenClaw, desktop actions, or always-on background agents. On a phone, loopback refers to that phone, not your desktop. No remote relay or internet-exposed desktop bridge is included.

## Free models only

The bridge connects only to loopback Ollama, accepts downloaded local weights, rejects cloud-tagged and remote-backed models, and explicitly selects a local model for OpenClaw runs. Paid/cloud settings and fallback are blocked in both the new bridge and original native router. No model API key, subscription, analytics, or CDN is needed.

Ordinary chat streams directly from Ollama. Projects use OpenClaw tools. Work phases run sequentially to avoid GPU contention; hardware and model quality still determine actual speed and task success.

## Workspace features

- **Projects:** describe an outcome, choose a crew, start automatically, follow progress, download files, pause/stop/resume, review, and request follow-up work.
- **Agents and teams:** editable roles/instructions, real OpenClaw agent creation when connected, reusable member groups, and shared conversations with selectable speakers.
- **Conversations:** separate saved histories, streamed text, formatted replies, browser dictation where supported, and optional on-device speech output.
- **Computer and browser:** project-based OpenClaw work, private screen preview, actual managed browser tabs and page opening.
- **Routines:** persistent recurring projects, saved paused until enabled.
- **Artifacts and memory:** project uploads/downloads, phase reports, and explicit context scoped to a workspace or project.
- **Settings:** free local model selection, light/dark mode, connection, installation, and workspace export.

Private data, credentials, model files, and historical databases are excluded from the public app. The earlier Projects dashboard is imported locally when found. Original Calypso packages and contracts remain in the repository; historical SQLite files are not overwritten or automatically migrated. See [original architecture](docs/ORIGINAL-ARCHITECTURE.md) and [specific parity limits](docs/FEATURES.md).

## Desktop and PWA

Install the web app through your browser's **Install app** or **Add to Home Screen** command. For the optional desktop shell:

```sh
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run desktop
```

The sandboxed Electron shell uses the same interface. Closing its window keeps the engine in the tray; choose **Quit Calypso** to exit. The **Desktop packages** workflow builds Windows, macOS, and Linux packages on a version tag or manual run. They are unsigned and require platform verification. No OS startup task is installed.

## Development

```sh
npm run test:web
npm run build:web
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test -w @calypso/core
npm test -w @calypso/windows-control
node packages/models/test/free-only.mjs
```

The static site is written to `dist/web`. The native core retains its SQLite schema and can fall back to Node's built-in SQLite when the optional native binary is unavailable. Windows-control tests use a simulated host; unit tests do not establish arbitrary desktop automation reliability. Voice, screen sharing, PWA installation, and native tools depend on browser and platform support.
