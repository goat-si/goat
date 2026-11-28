// Adapted from provider-opencode/src/server/goatMcpConfig.ts:1-10 at 916b5ccc1b2.
// The remote MCP entry OpenCode connects to for a thread's GOAT server.
export const goatRemoteMcpConfig = (endpoint: string, authorization: string) => ({
  type: "remote" as const,
  url: endpoint,
  headers: { Authorization: authorization },
  oauth: false as const,
});
