# Web

`apps/web` (`@goat/web`) is the React client. `apps/web/package.json` runs it with Vite+
(`vp dev`, `vp build`). `apps/web/vite.config.ts` registers TanStack Router, React, and Tailwind.
In single-origin dev the Vite server proxies `/api` and `/ws` (and the rest of the dev proxy
table) to the local server, so the bundle does not bake in an origin.

Routes live under `apps/web/src/routes/`. Pairing is `apps/web/src/routes/pair.tsx` (`/pair`).
`apps/web/src/routes/_chat.tsx` sends an unauthenticated session there. Token handling is
`apps/web/src/environments/primary/auth.ts`.

The socket is not implemented in the web app. `apps/web/src/connection/runtime.ts` wires
`@goat/client-runtime/connection`, and `packages/client-runtime/src/rpc/session.ts` opens the
WebSocket RPC session. `apps/web/src/lib/runtime.ts` supplies the browser socket constructor.
GOAT Connect is coming soon; `apps/web/src/cloud/publicConfig.ts` disables cloud config through `@goat/shared/goatConnect`.

`apps/web/src/branding.ts` sets `APP_BASE_NAME` to `"GOAT"` unless the desktop preload injected a
branding object. `apps/web/src/env.ts` treats the page as Electron when `window.desktopBridge` is
set. That bridge is `apps/desktop/src/preload.ts`. The desktop shell is [`desktop.md`](desktop.md).

GOAT Bot screens in this app are `apps/web/src/components/goatBot/`. They call the shared helpers
in `packages/client-runtime/src/goatBot/`. Settings screens, including
`apps/web/src/components/settings/GoatBotSettings.tsx`, are the web surface for server settings.
The stored document is still the server's `settings.json`.
