# @goat2/web — GOAT 2 UI

The GOAT 2 renderer: the Paper boards in `design/paper/part1/` drawn 1:1, wired to `goat2-host` over the
WebSocket API with the generated types in `packages/contracts-rs` (structure/30_wire.md).

## Run

| Command | What it does |
|---|---|
| `pnpm --filter @goat2/web dev` | Prototype mode (`VITE_GOAT2_MODE=prototype`): demo host in the page, "Demo" tag in the top bar |
| `pnpm --filter @goat2/web dev:host` | No demo: `?host=ws://127.0.0.1:<port>/ws&token=<t>` connects to a real host; without it the app shows "Not connected" |
| `pnpm --filter @goat2/web build` | Desktop build (lane G loads `dist/`; the preload sets `window.goat2Host = {wsUrl, token, build}`) |
| `pnpm --filter @goat2/web build:prototype` | Build for goat2-design `app/` |
| `pnpm --filter @goat2/web test` | Vitest: host store, outbox, fake host, host selection |
| `pnpm --filter @goat2/web shots` | Playwright: every board at its manifest size, side by side with the board jpg in `e2e/out/<id>-sbs.png`, plus click-throughs |

## Host selection (src/host/HostProvider.tsx)

`?fake=<board id>` → fake host with that board's scene (verification only); `window.goat2Host` or `?host=` → real
host; the prototype build flag → demo fake host; anything else → the real disconnected state (cached cards, outbox
holds messages, nothing fake).

## Paper parts

`python3 scripts/paper-parts.py design/paper/part1 > apps/web/src/paper/parts.tsx` regenerates every static part
(generator and part list in one file; `--tree <board.jsx>` prints element paths). Never edit parts.tsx by hand.
Interactive pieces (App.tsx, bot-home/*, threads/*) copy values from the exports only.

## Shells

Surfaces without a Part 1 backend use `planned/Planned.tsx` + `planned/registry.ts` (ids from
structure/60_planned.md): disabled control, "Planned" tag, one-line tooltip.
