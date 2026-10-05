# Calypso Design System

Owned by **Theriz**. Consumed by `apps/desktop` renderer.

## Identity

Ocean-dark premium UI: deep abyss surfaces, lagoon teal accent (`#38D2C1`), soft violet secondary (`#8B7CFF`). Dark-mode first. Feels closer to ChatGPT / Apple / xAI than a developer dashboard.

## Tokens

- `src/theme/tokens.ts` — colors, type, space, radii, shadows, motion, layout
- `src/theme/status.ts` — `WorkerStatus` → color / label / pulse
- `src/styles/global.css` — CSS vars + base reset (import once via `@calypso/ui/styles.css`)

## Primitives (v0)

- `Avatar` — initials gradient or image + optional live status badge
- `StatusDot` — pulsing status indicator
- `Button` — primary / secondary / ghost / danger
- `WorkerCard` — sidebar / workers list row
- `LiveComputerView` — section 14 mirror: frame + objective + Pause / Stop / Take Control

## Live computer view

Subscribes to `control.session.updated` / `control.action*` from contracts.
Frames: until a `control.frame` event exists, the desktop shell passes `frameUrl` from Trice’s capture loop (ScreenshotRef → blob/data URL).

## Rules

1. No Bootstrap / generic admin kits.
2. Prefer CSS variables for theming; keep TS tokens as source of truth.
3. Motion under 320ms for interactions; respect performance on 4060 laptops.
4. Build only against `@calypso/shared` contracts for domain types.
5. Glass / blur sparingly — never over opaque content the user needs to read.

## Next

App shell (sidebar, chat stream, composer), permission toast for `permission.asked`, artifacts panel, voice UI, tray, first-run, electron-builder packaging.
