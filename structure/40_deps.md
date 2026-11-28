# 40 Dependencies

```mermaid
flowchart BT
  contracts["goat2-contracts"]
  store["goat2-thread-store"] --> contracts
  api["goat2-engine-api (trait + types)"] --> contracts
  codex["goat2-engine-codex"] --> api
  host["goat2-host"] --> store
  host --> api
  host --> codex
  host --> contracts
  parity["goat2-parity"] --> contracts
  tsgen["packages/contracts-rs (generated)"] -.from.-> contracts
  web["apps/web"] --> tsgen
  desktop["apps/desktop"] -. spawns .-> host
```

- Only `goat2-host` combines crates. Store and drivers never depend on each other or on the host.
- Engines plug in through `goat2-engine-api` (`EngineFactory` / `EngineSession` / `EngineEvent`, owned by lane E); every driver (Codex now, Claude/ACP in Part 2) implements it.
- `apps/web` reaches the host only through `packages/contracts-rs` types over WebSocket; no Node
  server, no Electron IPC for thread data.
- `apps/desktop` knows the host only as a binary path + env (data dir, port, token).
- Root `Cargo.toml`: no `[patch]`. Keep trees small; `libc` only under `cfg(unix)`.
- One shared build cache (kache) for every worktree.
