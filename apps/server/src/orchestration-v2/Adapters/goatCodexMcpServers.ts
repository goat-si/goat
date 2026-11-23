import * as Effect from "effect/Effect";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import type { GoatMcpServerLaunch, ThreadId } from "@goat/contracts";

type Session = McpProviderSession.McpProviderSessionConfig | undefined;
type Config = { readonly config: { readonly mcp_servers?: unknown } };

export function codexGoatServersWithThreadId(
  servers: ReadonlyArray<GoatMcpServerLaunch> | undefined,
  threadId: ThreadId | undefined,
) {
  if (threadId === undefined) return servers;
  return servers?.map((server) =>
    server.transport === "stdio"
      ? { ...server, env: { ...server.env, GOAT_THREAD_ID: threadId, T3CODE_THREAD_ID: threadId } }
      : server,
  );
}

export const codexGoatServerConfig = (
  servers: ReadonlyArray<GoatMcpServerLaunch> | undefined,
  threadId: ThreadId | undefined,
) => McpProviderSession.goatCodexServers(codexGoatServersWithThreadId(servers, threadId), {});

export function codexStdioThreadEnvironment(servers: unknown, threadId: ThreadId) {
  if (typeof servers !== "object" || servers === null) return {};
  return Object.fromEntries(
    Object.entries(servers)
      .filter(
        ([name, server]) =>
          !name.includes(".") &&
          typeof server === "object" &&
          server !== null &&
          typeof Reflect.get(server, "command") === "string",
      )
      .flatMap(([name]) => [
        [`mcp_servers.${name}.env.GOAT_THREAD_ID`, threadId],
        [`mcp_servers.${name}.env.T3CODE_THREAD_ID`, threadId],
      ]),
  );
}

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
  const stdioEnvironment = Effect.fn("Codex.stdioEnvironment")(function* (
    threadId: ThreadId | null | undefined,
    cwd: string | null | undefined,
  ) {
    if (threadId == null) return {};
    const result = yield* read(cwd ?? null).pipe(
      Effect.map((response) => codexStdioThreadEnvironment(response.config.mcp_servers, threadId)),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read Codex stdio MCP configuration.", { cause }).pipe(
          Effect.as({}),
        ),
      ),
    );
    return result;
  });
  return { userCuaDriver, filterGoatServers, stdioEnvironment };
}
