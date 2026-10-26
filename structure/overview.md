# Overview

GOAT is a desktop, web, and mobile control surface for coding agents that already run on a
machine. The server wraps those agents. Clients send typed WebSocket RPC. The server commits
orchestration intent, then runs provider processes and checkpoints as effects.

The [command commit](server.md#command-commit) is the boundary between intent and side effects.
The [state roots](settings-and-storage.md#state-roots) say which directory each process writes.

```text
web / desktop renderer / mobile
  -> WebSocket RPC (/ws)
  -> OrchestratorV2 plans events
  -> EventSink commits events, projections, receipt, outbox
  -> effect worker starts the provider turn and captures a checkpoint
  -> provider CLI (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, and the other built-in drivers)
```

`apps/web` is the React client. `apps/desktop` is the Electron shell around that client and a
bundled server. `apps/mobile` is a separate React Native app. Shared client behavior lives in
`packages/client-runtime`. Wire types live in `packages/contracts`.

User workflows stay in `docs/user/`. The longer architectural constraints stay in
`docs/internals/overview.md`. This folder is the current-shape map.

## Product boundary

The command the repository ships is `goat`. `apps/server/src/binCli.ts` builds
`Command.make("goat")`, and the default handler starts the server. `apps/server/package.json`
also exposes a legacy `t3` bin at the same `./dist/bin.mjs`; the workspace package name is `goat`.

A local server speaks HTTP from `apps/server/src/server.ts` and accepts WebSocket RPC on `GET /ws`
from `apps/server/src/ws.ts`. Dispatch enters orchestration through
`ORCHESTRATION_V2_WS_METHODS.dispatchCommand`.

Agents also reach the same server over MCP. The HTTP MCP server is named `GOAT` and is mounted at
`/mcp` (`layerMcpTransport` in `apps/server/src/mcp/McpHttpServer.ts`). Tool names are not all
`goat_*`; see [`mcp-toolkits.md`](mcp-toolkits.md).

GOAT is a fork of T3 Code and shares its git history. [`README.md`](../README.md) states that.
New checkpoint refs use `refs/goat/`, with legacy `refs/t3/` readers. Tracing sent to the
T3 Connect relay from `apps/server/src/cloud/relayTracing.ts` retains relay-owned names.
Local state defaults to `~/.goat`, with a legacy `~/.t3` fallback. Where each process writes
is the [state roots](settings-and-storage.md#state-roots) contract.

## Invariants

These are the rules this map treats as non-negotiable. None of them is bound to a test comment.
The nearby tests exercise the behavior; they do not name these ids. See `grace.unboundInvariants`
in [`manifest.json`](manifest.json).

- **INV-ORCH-01** — `commitCommand` reserves a receipt, appends events, applies projections, and
  enqueues outbox effects inside one database transaction. Subscribers are published after that
  transaction commits. See [command commit](server.md#command-commit).
- **INV-HOME-01** — An empty server base directory resolves to `~/.t3`. `GOAT_HOME` and
  `--base-dir` override it. See [state roots](settings-and-storage.md#state-roots).
- **INV-DESKTOP-01** — A packaged desktop build stores its server state under `~/.goat/desktop`.
  A development desktop build uses `~/.t3` unless `GOAT_HOME` is set.
- **INV-SSH-01** — Scripts that launch GOAT on an SSH host set the remote server home to
  `$HOME/.goat` and do not use `$HOME/.t3`.
- **INV-CKPT-01** — Orchestration v2 checkpoint refs use the prefix
  `refs/goat/orchestration-v2/checkpoints`, with legacy `refs/t3/` readers.
- **INV-MCP-01** — The HTTP MCP server name is `GOAT` and its path is `/mcp`.
- **INV-CHAN-01** — A channel kind is `goat`, `slack`, or `mcp`.
