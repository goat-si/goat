# GOAT 2

Bot-first, lightweight rewrite of [GOAT](https://github.com/goat-si/goat). Not clean-room: code is
lifted from goat origin/dev and tracked in [docs/PROVENANCE.md](docs/PROVENANCE.md). GOAT itself is
an MIT fork of T3 Code; `LICENSE` and `NOTICE` are carried over unchanged.

- People see bots first; worker threads fold under each bot and open the existing coding view.
- Every run carries a **runtime stamp**: which CLI (and its version at run start), model, machine,
  account, permissions and workspace. See `packages/runtime-stamp`.
- Official CLIs are the engines (codex, claudeAgent, cursor, opencode, antigravity, pi, grok, muse,
  ACP registry, ...). Avatars show the real provider mark as a bottom-right chip.
- Lightweight: no transcript copy in the DB, engine host separate from Electron main.

## Layout

```
apps/desktop          Electron shell (windows + in-app browser only)
apps/server           engine host (separate process)
apps/web              React UI: BotHome (Roster | Chat | Overview)
packages/contracts    subset of goat's @goat/contracts (effect/Schema)
packages/provider-icons  real provider marks from goat + ProviderChip
packages/runtime-stamp   RuntimeStamp schema (new)
docs/                 PRD, provenance
```

## Run

```sh
pnpm install
pnpm typecheck
pnpm dev:web      # http://127.0.0.1:5733
pnpm dev:server   # http://127.0.0.1:5734/health
```

Design workflow: [docs/PAPER.md](docs/PAPER.md). Live: https://goat-si.github.io/goat2-design/
