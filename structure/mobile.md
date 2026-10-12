# Mobile

`apps/mobile` is the React Native app. It is not a wrapped `apps/web`. Navigation is React
Navigation: `apps/mobile/src/App.tsx` builds `createStaticNavigation(RootStack)`, and
`apps/mobile/src/Stack.tsx` is that stack. Pairing and saved environments are screens under
`apps/mobile/src/features/connection/`, using `apps/mobile/src/features/connection/pairing.ts`.
The connection commands go through `@goat/client-runtime/connection`, the same package the web
app uses. See [`client-runtime.md`](client-runtime.md).

`apps/mobile/app.config.ts` is the Expo config. `slug` is `"goat"`. Names, URL schemes, and store
ids come from `MOBILE_APP_IDENTITY` in `packages/shared/src/mobileAppIdentity.ts`:

| Variant     | App name     | Scheme         | iOS and Android id       |
| ----------- | ------------ | -------------- | ------------------------ |
| production  | GOAT         | `goat`         | `si.goat.mobile`         |
| development | GOAT Dev     | `goat-dev`     | `si.goat.mobile.dev`     |
| preview     | GOAT Preview | `goat-preview` | `si.goat.mobile.preview` |

GOAT Bot on this surface is `apps/mobile/src/features/goat-bot/GoatBotScreen.tsx`. The screen reads
`GoatBotRow` values from `@goat/client-runtime/goatBot` and sends through
`useMobileGoatBotSession`. Home remembers thread mode versus bot mode in
`apps/mobile/src/features/goat-bot/goatBotHomeMode.ts`. The bot's server, and the rule that worker
threads are separate from the bot transcript, are [`channels.md`](channels.md).

The app talks to a server the user pairs. It does not bundle `apps/server`. Local Android builds
and the EAS path are `apps/mobile/README.md` and `docs/operations/mobile-testflight.md`.
