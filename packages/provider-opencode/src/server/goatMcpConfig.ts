/**
 * The remote MCP entry OpenCode connects to for a thread's GOAT server. Both adapters send it, so
 * what OpenCode is offered is whatever GOAT's /mcp lists for that credential.
 */
export const goatRemoteMcpConfig = (session: {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}) => ({
  type: "remote" as const,
  url: session.endpoint,
  headers: { Authorization: session.authorizationHeader },
  oauth: false as const,
});
