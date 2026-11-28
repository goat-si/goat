# 00 Map

State: `real` = has working code, `stub` = placeholder, `legacy` = superseded, to remove.

| Path | Lang | Purpose | Lane | State |
|---|---|---|---|---|
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | - | Rust workspace (edition 2024, toolchain 1.95), no `[patch]`; `Cargo.lock` committed (binary workspace) | owner | real |
| `crates/goat2-contracts` | Rust | Wire + disk types (card, 14 log events, frames, TurnItem subset, capability flags, limits). Generates TS + JSON Schema into `packages/contracts-rs/` | C | done: 15 events, frames, commands, BotProfile, v1 names, freeze rule, 73+ fixtures |
| `crates/goat2-thread-store` | Rust | `~/.goat2*/threads/<id>/` folders, `goat.jsonl` append, card fold, `cards.sqlite` index, `(epoch, seq)` reads, pages, blobs | A | **done for Part 1** (`13fd36b`, reviews 11-14 PASS): format v1 frozen; 1,000 threads warm 2.9 ms / rebuild 104 ms / unclean 236 ms (quiet M5 Max); in-run append 3.8 ms, 20 threads 8.0 ms / ~2,350/s (group commit); 91 tests |
| `crates/goat2-engine-api` | Rust | Engine seam: trait + types every driver implements (start, start_turn, steer, interrupt, answer_request, group RSS, events) | E | real (`ff774d5`, `007fbfb` RequestOpened.item + TurnSettings) |
| `crates/goat2-engine-codex` | Rust | Codex app-server driver on pinned JSON Schema (`schema/codex-0.167.0/`), process group, steer/turn results | B | stub on goat2 |
| `crates/goat2-parity` | Rust | v1 behaviour scenarios (recorded sessions) runnable against v1 and GOAT 2 | D | stub on goat2 |
| `crates/goat2-host` | Rust (bin `goat2-host`) | The host: mailbox/lane, caps, follow-ups, child wake, restart settlement, MCP (`rmcp`), WebSocket API | E | stub |
| `packages/contracts-rs` | TS (generated) | TS types + JSON Schema from goat2-contracts. Never hand-edit | C | generated (`a2c6b7c`) |
| `apps/web` | TS/React | UI: Paper look 1:1 (bot home, thread view), talks only to the host WebSocket; generated parts `src/paper/parts.tsx`, Planned shells `src/planned/` | F | real: bot home slice `f880c2d` (2R-1, FF-1, U8-1, 12P-1, 1KL4-1); thread mode next |
| `apps/desktop` | TS/Electron | Window shell; spawns and supervises `goat2-host`; packages GOAT 2 (Dev) | G | real (`1212962`): v1 desktop lift (recovery, window, menu, protocol, single instance, Info.plist, osx-sign ad-hoc + hardened runtime) |
| ~~`apps/server`~~ | - | removed `5d9368c` | - | gone |
| `packages/contracts` | TS | v1-lifted provider/model/bot types used by the UI | F | real, keep until UI only needs contracts-rs |
| `packages/provider-icons` | TS | Real provider marks from v1 + `ProviderChip` | F | real |
| `packages/runtime-stamp` | TS | RuntimeStamp schema | F | real |
| `packages/bot-face` | TS | Face poses + motion tokens | F | real |
| `design/paper/part1/` | - | Paper exports (JSX + jpg + manifest) the UI follows | owner | generated |
| `scripts/paper-parts.py` | Py | Paper export → `apps/web/src/paper/parts.tsx` | F | real |
| `scripts/build-dev-app.sh` | sh | Build + install GOAT 2 (Dev), only from `goat2`, gate: `pnpm -r typecheck` + `cargo test --workspace --locked` | G | real (`1212962`) |
| `docs/` | md | DECISIONS, PAPER, DESIGN, MOTION, PROVENANCE, lanes, parity (D) | owner + lanes | real |
| `structure/` | md | This SSOT | owner | real |

## Part 2 additions (planned, lane P2-S, 2026-11-28)
| Path | Lang | Role | Lane | State |
|---|---|---|---|---|
| `crates/goat2-engine-sdk` | Rust | Driver for Cursor, OpenCode (1.x and 2 via v1's version selector), Muse over `apps/engine-helper`; Pi/OmO RPC driven directly | P2-S | on `goat2_engine_sdk` |
| `apps/engine-helper` | Node/TS | One helper process per thread wrapping the Node-only SDKs; protocol `apps/engine-helper/PROTOCOL.md` | P2-S | on `goat2_engine_sdk` |
