# Client runtime

`packages/client-runtime` (`@goat/client-runtime`) is the client code that `apps/web` and
`apps/mobile` both import. `apps/desktop` does not reimplement it. The desktop renderer is the web
app, so it uses the same package. Platform services (sockets, navigation, storage) stay in the app.
Connection state, RPC session setup, and environment-scoped commands stay here.

`packages/client-runtime/package.json` exports subpaths, not one barrel. The directories under
`packages/client-runtime/src/` and what they own:

| Directory        | Role                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `rpc/`           | WebSocket RPC session (`RpcSession` in `packages/client-runtime/src/rpc/session.ts`)                        |
| `connection/`    | Connection registry, driver, and pairing onboarding                                                         |
| `state/`         | Effect Atom state for threads, shell, and server config. Mutations go through `createEnvironmentRpcCommand` |
| `environment/`   | Environment descriptor and endpoint identity                                                                |
| `authorization/` | Remote-environment authorization and token storage                                                          |
| `operations/`    | Shared project and command operations                                                                       |
| `platform/`      | Capabilities, persistence, and the orchestration cache the apps supply                                      |
| `goatBot/`       | Timeline rows, send queue, ensure, and home-claim resolution shared by web and mobile                       |
| `relay/`         | Managed relay client state                                                                                  |
| `preview/`       | Preview stream paths                                                                                        |
| `device/`        | Device hub access and streams                                                                               |
| `voice-input/`   | Voice input controller                                                                                      |
| `work-log/`      | Work-log presentation helpers                                                                               |
| `mcpApps/`       | MCP Apps host surface                                                                                       |
| `notes/`         | Offline note outbox rules, checkbox toggling, and the compare line diff; `notes/rpc` subscribes to notes    |

`packages/client-runtime/src/goatBot/index.ts` re-exports rows, readers, ensure, and the send
queue. Home resolution stays on its own export, `packages/client-runtime/src/goatBot/home.ts`
(`resolveGoatBotHome`). Web UI around those helpers is `apps/web/src/components/goatBot/`. Mobile
UI is `apps/mobile/src/features/goat-bot/`. The server side of the same bot is
[`channels.md`](channels.md).

The [command commit](server.md#command-commit) is server-side. This package sends the command and
reads the projections. It does not append orchestration events itself.

A node a client reaches through a hub stays its own environment with a `hub-proxy` route. The route
borrows the hub route's credential through
`packages/client-runtime/src/connection/hubProxyAuthSource.ts`, and
`packages/client-runtime/src/connection/hubProxyDiscovery.ts` keeps those routes in step with the
hub's node list. See [server.md](server.md#hub-proxy).
