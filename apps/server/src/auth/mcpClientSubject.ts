/** The session subject `/mcp` admits from outside a thread; only the MCP endpoint accepts it. */
export const MCP_CLIENT_SUBJECT = "mcp-client";

/** These sessions reach a host through an SSH tunnel, so the origin they reach means nothing to the caller. */
export const SSH_DISPATCH_SESSION_LABEL = "GOAT SSH dispatch";
