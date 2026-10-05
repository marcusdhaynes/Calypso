# Calypso Windows packaging (v0.1)

Run these on a Windows x64 machine (DESKTOP-J47PDQK). Do **not** rely on Wine.

## Prerequisites

- Node 20+ and repo dependencies (`npm install` at monorepo root)
- Native rebuild: `npm run rebuild:native -w @calypso/desktop`

## Build + pack

```bat
npm run build -w @calypso/ui
npm run build -w @calypso/desktop
npm run pack:win -w @calypso/desktop
```

Artifacts land in `apps/desktop/release/`:

| File | Purpose |
|------|---------|
| `Calypso-Setup-0.1.0.exe` | NSIS installer (choose dir, Start Menu + desktop shortcuts) |
| `Calypso-Portable-0.1.0.exe` | Portable single-file exe |

Single-target:

```bat
npm run pack:win:nsis -w @calypso/desktop
npm run pack:win:portable -w @calypso/desktop
```

Dir unpack (faster iterate): `npm run pack:win:dir -w @calypso/desktop`

## Tray / notifications smoke (after install)

1. Launch Calypso → close the window (should stay in tray).
2. Tray → **Open** restores the window; **New command** focuses chat.
3. Tray → **Pause workers** / **Resume workers**.
4. With the window unfocused, complete a task or trigger `permission.asked` → Windows toast; click toast → focuses Calypso.
5. Global: `Ctrl+Alt+Esc` stop-all; `Ctrl+Shift+Space` focuses composer for push-to-talk.

## Voice PTT prototype

Hold the **Hold** button in the composer (or focus it via `Ctrl+Shift+Space`). Uses Chromium Web Speech API when the OS grants mic access. Release to stop; edit the transcript, then Send.
