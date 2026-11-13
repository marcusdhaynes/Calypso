# Auto-Update System — Spec

Repo: `marcusdhaynes/Calypso` · App: Calypso · Current version (at rollout): `0.2.0`
Category: **A** — Settings menu exists — implemented LIVE on the web app; shared React/TS components prepared dormant for the desktop app.

## Flow (identical in every app)

1. The app checks `https://api.github.com/repos/marcusdhaynes/Calypso/releases/latest`.
2. The release tag (semver `vX.Y.Z`) is compared with the app's current version.
3. If a newer version exists:
   - **Ribbon:** a thin ribbon at the **top center** of the app, very low height — just
     enough for short text like `Update available · vX.Y.Z`. It is styled **neutrally /
     theme-aware** so it does not clash with the app's own theme. The ribbon itself is
     the button: **clicking it executes the update**. The **X** on its right dismisses it
     **permanently for that version** (stored in local storage; it does not come back on
     the next launch). Full update information remains in Settings (below).
   - **Settings → Updates section:** permanently at the **very bottom of Settings**,
     showing current version, available version, **What's New** (release notes),
     a **Check for updates** button, and an **Update** button. It stays there until updated.
4. On **Update**: download, close the current version, install/swap, and reopen.
   Web apps simply refresh to the newly deployed version. APK/native builds still
   require the platform install tap (e.g. Android's install prompt).

## Release format

- Proper **GitHub Releases** — commits alone are not enough.
- Tag: semver `vX.Y.Z`; release notes become the **What's New** text.
- Attach the installable assets for the platform (web deploy / APK / desktop build).

## Future-proof rule

- If this app **already has a Settings menu**, the Updates section is implemented
  **live now**, at the bottom of Settings, and the ribbon is wired in the app root.
- If this app has **no Settings menu anywhere**, this code is present
  **prepared / dormant only** — it is not imported or displayed anywhere and makes
  **no visible UI change**. When a Settings menu is added later, the Updates section
  is implemented at the **bottom of that Settings menu** at that time (Marcus will
  ask Muse to wire it if a future Settings menu does not pick it up automatically).

## This repo

Classification: Category A. Evidence: `packages/ui/src/components/Sidebar.tsx` has nav item `{ id: "settings", label: "Settings" }`; `apps/web/app.js` has a `settings()` view rendering a settings grid; `apps/desktop/src/renderer/App.tsx` renders a settings view when `nav === "settings"`.

Live wiring (web, minimal): `apps/web/updates.js` loaded by `apps/web/index.html`; `apps/web/app.js` `settings()` appends `<div id="updates-section"></div>` after the settings grid (the very bottom of Settings). The script renders the Updates section there and shows the top-center ribbon when a newer release exists.

Desktop: `updates/update-check.ts`, `updates/UpdateBanner.tsx`, `updates/UpdatesSection.tsx` are the shared components, prepared **dormant** (imported nowhere). Live desktop wiring was deferred: the desktop renderer is a single very large `App.tsx` with an inline settings view and an Electron build that cannot be compiled or verified in this environment, so a surgical edit there could not be verified safely. Wire `UpdatesSection` at the bottom of the desktop settings view and `UpdateBanner` in the desktop root when the desktop app is next built. Current version from root `package.json`: `0.2.0` (web package is also `0.2.0`).
