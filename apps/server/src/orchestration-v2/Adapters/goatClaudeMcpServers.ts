import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

// An unattended turn takes the name so the user's own driver cannot start.
export function blockedClaudeCuaServers(
  session: McpProviderSession.McpProviderSessionConfig,
  cuaServers: object,
) {
  return session.cuaDriverBlocked === true && Object.keys(cuaServers).length === 0
    ? {
        [McpProviderSession.CUA_MCP_SERVER_NAME]: {
          type: "stdio" as const,
          command: McpProviderSession.BLOCKED_CUA_STDIO_SERVER.command,
          args: [...McpProviderSession.BLOCKED_CUA_STDIO_SERVER.args],
          env: { ...McpProviderSession.BLOCKED_CUA_STDIO_SERVER.env },
        },
      }
    : {};
}
