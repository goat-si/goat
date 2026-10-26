/**
 * The remote MCP entry OpenCode connects to for a thread's GOAT server. Both adapters send it, so
 * what OpenCode is offered is whatever GOAT's /mcp lists for that credential.
 */
export const goatRemoteMcpConfig = (endpoint: string, authorization: string) => ({
  type: "remote" as const,
  url: endpoint,
  headers: { Authorization: authorization },
  oauth: false as const,
});
