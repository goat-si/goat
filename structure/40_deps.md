# 40 Dependencies

```mermaid
flowchart BT
  contracts["goat2-contracts"]
  store["goat2-thread-store"] --> contracts
  codex["goat2-engine-codex"] --> contracts
  host["goat2-host"] --> store
  host --> codex
  host --> contracts
  parity["goat2-parity"] --> contracts
  tsgen["packages/contracts-rs (generated)"] -.from.-> contracts
  web["apps/web"] --> tsgen
  desktop["apps/desktop"] -. spawns .-> host
```

- Only `goat2-host` depends on more than one crate. Store and drivers never depend on each other.
- `apps/web` reaches the host only through `packages/contracts-rs` types over WebSocket; no Node
  server, no Electron IPC for thread data.
- `apps/desktop` knows the host only as a binary path + env (data dir, port, token).
- Root `Cargo.toml`: no `[patch]`. Keep trees small; `libc` only under `cfg(unix)`.
- One shared build cache (kache) for every worktree.
