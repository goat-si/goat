# Contracts

`packages/contracts` (`@t3tools/contracts`) is the wire and persisted-schema package. It is Effect
Schema plus small helpers. It does not start a server, open a socket, or run a provider.

`packages/contracts/package.json` exports `"."` from `packages/contracts/src/index.ts`, plus
`./settings` and `./relay`. `packages/contracts/src/index.ts` re-exports the domain modules. A
change to a schema here is a change for `apps/server`, `apps/web`, `apps/desktop`, and
`apps/mobile` together, because they import this package rather than declaring a private copy of
the same struct.

Representative modules:

| Module                                      | What it defines                                             |
| ------------------------------------------- | ----------------------------------------------------------- |
| `packages/contracts/src/orchestrationV2.ts` | `OrchestrationV2Command` and the dispatch result schemas    |
| `packages/contracts/src/rpc.ts`             | `WS_METHODS` and the RPC definitions, built with `Rpc.make` |
| `packages/contracts/src/settings.ts`        | `ServerSettings`, including `GoatBotHomeClaim`              |
| `packages/contracts/src/channelCommon.ts`   | `ChannelKind` (`goat`, `slack`, `mcp`) and the channel ids  |
| `packages/contracts/src/channelGateway.ts`  | Inbound channel messages and `CHANNEL_MCP_TOOL_NAMES`       |
| `packages/contracts/src/ipc.ts`             | Desktop IPC, including `DesktopDiscoveredSshHost`           |

The [command commit](server.md#command-commit) persists values decoded with these schemas.
Replay has to keep decoding events that were written by older servers. Compatibility belongs in
the schema and in the server migration, not in a client-only fallback.

`docs/internals/overview.md` records the pull-request linking negotiation that rides on the
environment descriptor. This page does not restate it.
