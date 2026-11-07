import * as Effect from "effect/Effect";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

type Session = McpProviderSession.McpProviderSessionConfig | undefined;
type Config = { readonly config: { readonly mcp_servers?: unknown } };

export function makeCodexMcpConfigReader<E, R>(
  read: (cwd: string | null) => Effect.Effect<Config, E, R>,
) {
  const userCuaDriverByCwd = new Map<string, boolean>();
  const userCuaDriver = Effect.fn("Codex.userCuaDriver")(function* (
    session: Session,
    cwd: string | null | undefined,
  ) {
    if (session?.cuaDriver === undefined || session.cuaDriverOverridesUserConfig === true)
      return false;
    const key = cwd ?? "";
    const known = userCuaDriverByCwd.get(key);
    if (known !== undefined) return known;
    const configured = yield* read(cwd ?? null).pipe(
      Effect.map((response): boolean | undefined => {
        const servers = response.config.mcp_servers;
        return (
          typeof servers === "object" &&
          servers !== null &&
          Object.hasOwn(servers, McpProviderSession.CUA_MCP_SERVER_NAME)
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read Codex config; leaving cua-driver to the user.", {
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (configured === undefined) return true;
    userCuaDriverByCwd.set(key, configured);
    return configured;
  });
  const filterGoatServers = Effect.fn("Codex.filterGoatServers")(function* (
    session: Session,
    cwd: string | null | undefined,
  ) {
    if (!session?.goatMcpServers?.length) return session;
    const configured = yield* read(cwd ?? null).pipe(
      Effect.map((response) => {
        const servers = response.config.mcp_servers;
        return servers === undefined
          ? {}
          : typeof servers === "object" && servers !== null && !Array.isArray(servers)
            ? servers
            : undefined;
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not read Codex config for GOAT MCP servers.", { cause }),
      ),
    );
    const skipped = session.goatMcpServers.filter(
      (server) => configured === undefined || Object.hasOwn(configured, server.providerName),
    );
    if (skipped.length)
      yield* Effect.logWarning(
        "GOAT MCP servers skipped: Codex configuration unavailable or name conflict",
        { names: skipped.map((server) => server.providerName) },
      );
    return {
      ...session,
      goatMcpServers: session.goatMcpServers.filter(
        (server) => configured !== undefined && !Object.hasOwn(configured, server.providerName),
      ),
    };
  });
  return { userCuaDriver, filterGoatServers };
}
