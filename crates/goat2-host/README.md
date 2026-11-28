# goat2-host

The GOAT 2 engine host (lane E). One Rust process started by Electron main (lane G) that ties
`goat2-contracts`, `goat2-thread-store` (lane A) and the engine drivers (through
`goat2-engine-api`) together.

Design sources: PRD Part 1 (`goat-si/goat2-design` `prd-src/part1/{runtime,storage,model,mcp}.md`),
`structure/` on `goat2`, `docs/lanes/PART1.md`. v1 ports are listed in `docs/PROVENANCE.md`.

## Modules

| Module | What |
|---|---|
| `api` | Internal seam: `McpHost` and `WsHost` traits the transports call, UI commands (contract `ClientFrame`) with v1 `AgentSurfaceError` reasons, the v1 result envelope |
| `store` | `ThreadStore` seam implemented over lane A's `goat2_thread_store::Store` (`LaneAStore`) |
| `engine` | Re-exports `goat2-engine-api`; `fake` scripted engine; `codex` adapter point (reports unavailable until lane B's driver lands) |
| `core` | Per-thread actor (mailbox + lane), scheduler (4 runs, 2 starts, parked waits), follow-up modes, Stop hold, wait/async children, child wake, restart wake, memory policy, commands with clientRequestId dedupe, MCP effects |
| `mcp` | `rmcp` streamable HTTP at `/mcp`: `goat_describe` + `goat_call` over the 11 Part 1 paths (registry ported from v1), per-thread tokens |
| `ws` | WebSocket at `/ws`: `subscribe_cards`, `subscribe_thread` (replay, caught up, resets, text appends), pages, commands |
| `stall` | Stall recorder: `<dataDir>/logs/stalls.ndjson` (event loop and actor handlers) |
| `server` | One 127.0.0.1 axum server: `/ws`, `/mcp`, `/health`; `host.json`; generation; ready line |

## Launch contract (lane G)

Env `GOAT2_DATA_DIR`, `GOAT2_HOST_PORT` (0 = free port; Dev app uses 3873), `GOAT2_HOST_TOKEN`
(absent: generated and written to `host.json`, mode 0600). Ready = one JSON line on stdout
`{wsUrl, mcpUrl, port, generation}` and `/health` returns 200. The host runs as its own process
group, exits when stdin closes, and kills process groups a previous host left in `host.json`.
`GOAT2_ENGINE=fake` uses the scripted fake engine. `<dataDir>/generation` counts host starts.

## Known limits

- Real Codex runs need lane B's driver behind `engine/codex.rs`; until then runs fail with
  "engine unavailable".
- `LaneAStore` keeps a per-thread fold cache until lane A's `Store::fold` (branch
  `goat2_thread_store` 9c8fcfe) is on `goat2`.
