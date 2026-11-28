# 00 Map

State: `real` = has working code, `stub` = placeholder, `legacy` = superseded, to remove.

| Path | Lang | Purpose | Lane | State |
|---|---|---|---|---|
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | - | Rust workspace (edition 2024, toolchain 1.95), no `[patch]`; `Cargo.lock` committed (binary workspace) | owner | real |
| `crates/goat2-contracts` | Rust | Wire + disk types (card, 14 log events, frames, TurnItem subset, capability flags, limits). Generates TS + JSON Schema into `packages/contracts-rs/` | C | real |
| `crates/goat2-thread-store` | Rust | `~/.goat2*/threads/<id>/` folders, `goat.jsonl` append, card fold, `cards.sqlite` index, `(epoch, seq)` reads, pages, blobs | A | stub on goat2 (work on `goat2_thread_store`) |
| `crates/goat2-engine-api` | Rust | Engine seam: trait + types every driver implements (start, start_turn, steer, interrupt, answer_request, group RSS, events) | E | planned (moving out of goat2-host) |
| `crates/goat2-engine-codex` | Rust | Codex app-server driver on pinned JSON Schema (`schema/codex-0.167.0/`), process group, steer/turn results | B | stub on goat2 |
| `crates/goat2-parity` | Rust | v1 behaviour scenarios (recorded sessions) runnable against v1 and GOAT 2 | D | stub on goat2 |
| `crates/goat2-host` | Rust (bin `goat2-host`) | The host: mailbox/lane, caps, follow-ups, child wake, restart settlement, MCP (`rmcp`), WebSocket API | E | stub |
| `packages/contracts-rs` | TS (generated) | TS types + JSON Schema from goat2-contracts. Never hand-edit | C | generated (`a2c6b7c`) |
| `apps/web` | TS/React | UI: Paper look 1:1 (bot home, thread view), talks only to the host WebSocket | F | prototype (Paper SSOT parts, placeholder data) |
| `apps/desktop` | TS/Electron | Window shell; spawns and supervises `goat2-host`; packages GOAT 2 (Dev) | G | real (`5d9368c`) |
| ~~`apps/server`~~ | - | removed `5d9368c` | - | gone |
| `packages/contracts` | TS | v1-lifted provider/model/bot types used by the UI | F | real, keep until UI only needs contracts-rs |
| `packages/provider-icons` | TS | Real provider marks from v1 + `ProviderChip` | F | real |
| `packages/runtime-stamp` | TS | RuntimeStamp schema | F | real |
| `packages/bot-face` | TS | Face poses + motion tokens | F | real |
| `design/paper/part1/` | - | Paper exports (JSX + jpg + manifest) the UI follows | owner | generated |
| `scripts/paper-to-parts.py` | Py | Paper export → `apps/web/src/bot-home/ssotParts.tsx` | F | real |
| `scripts/build-dev-app.sh` | sh | Build + install GOAT 2 (Dev), only from `goat2` | G | real |
| `docs/` | md | DECISIONS, PAPER, DESIGN, MOTION, PROVENANCE, lanes, parity (D) | owner + lanes | real |
| `structure/` | md | This SSOT | owner | real |
