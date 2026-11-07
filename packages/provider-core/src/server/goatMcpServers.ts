import type { GoatMcpServerLaunch } from "@goat/contracts";

type Servers = ReadonlyArray<GoatMcpServerLaunch> | undefined;

export function goatSdkServers(servers: Servers) {
  return Object.fromEntries(
    (servers ?? []).map((server) => [
      server.providerName,
      server.transport === "stdio"
        ? {
            type: "stdio" as const,
            command: server.command,
            args: [...server.args],
            env: { ...server.env },
          }
        : { type: "http" as const, url: server.url, headers: { ...server.headers } },
    ]),
  );
}

export function goatCodexServers(servers: Servers, configured: object | undefined) {
  if (configured === undefined) return {};
  return Object.fromEntries(
    (servers ?? [])
      .filter((server) => !Object.hasOwn(configured, server.providerName))
      .map((server) => [
        `mcp_servers.${server.providerName}`,
        server.transport === "stdio"
          ? { command: server.command, args: [...server.args], env: { ...server.env } }
          : { url: server.url, http_headers: { ...server.headers } },
      ]),
  );
}

export function goatAcpServers(servers: Servers) {
  return (servers ?? []).flatMap((server) =>
    server.transport === "stdio"
      ? [
          {
            name: server.providerName,
            command: server.command,
            args: [...server.args],
            env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
          },
        ]
      : [],
  );
}
