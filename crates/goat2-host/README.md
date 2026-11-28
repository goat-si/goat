# goat2-host

The GOAT 2 engine host (lane E). One Rust process started by Electron main (lane G) that ties
`goat2-contracts`, the thread store and the engine drivers together.

Design sources: PRD Part 1 (`goat-si/goat2-design` `prd-src/part1/{runtime,storage,model,mcp}.md`),
`structure/` on `goat2`, `docs/lanes/PART1.md`.

## Modules

| Module | What |
|---|---|
| `api` | Internal seam: `McpHost` and `WsHost` traits the transports call, UI `Command`s, the v1 result envelope |
| `store` | `ThreadStore` trait + interim `FsStore` (same disk layout as lane A's crate; replaced when it lands) |
| `engine` | `EngineFactory` / `EngineSession` traits, `fake` scripted engine, `codex` adapter point for lane B |
| `core` | Per-thread actor (mailbox + lane), scheduler (caps), follow-up modes, child wake, restart settlement, memory policy |
| `mcp` | `rmcp` streamable HTTP at `/mcp`: `goat_describe` + `goat_call` over the 11 Part 1 paths, per-thread tokens |
| `ws` | WebSocket at `/ws`: `subscribe_cards`, `subscribe_thread` (replay, caught up, resets, text appends), pages, commands |
| `stall` | Stall recorder: `<dataDir>/logs/stalls.ndjson` |
| `server` | One 127.0.0.1 axum server: `/ws`, `/mcp`, `/health`; `host.json`; ready line |

## Launch contract (lane G)

Env `GOAT2_DATA_DIR`, `GOAT2_HOST_PORT` (0 = free port; Dev app uses 3873), `GOAT2_HOST_TOKEN`
(absent: generated and written to `host.json`, mode 0600). Ready = one JSON line on stdout
`{wsUrl, mcpUrl, port, generation}` and `/health` returns 200. The host runs as its own process
group and exits when stdin closes. `GOAT2_ENGINE=fake` uses the scripted fake engine.
