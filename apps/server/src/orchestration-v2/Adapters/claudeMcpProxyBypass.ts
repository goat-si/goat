// Claude Code sends HTTP MCP traffic, even to loopback, through any HTTPS_PROXY (also one in
// Claude's settings.json); a proxy cannot reach this server (CONNECT answers 405), so the goat
// server would silently fail to attach. Exempting the endpoint host keeps the proxy for the
// rest; a NO_PROXY in Claude's own settings env still wins over the process environment.
export function claudeMcpProxyBypassEnvironment(
  endpoint: string,
  environment: NodeJS.ProcessEnv | undefined,
): Readonly<Record<string, string>> {
  const host = new URL(endpoint).hostname.replace(/^\[(.*)\]$/u, "$1");
  const existing = environment?.NO_PROXY ?? environment?.no_proxy ?? "";
  const entries = existing
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.includes("*") || entries.includes(host)) return {};
  const value = [...entries, host].join(",");
  return environment?.no_proxy === undefined
    ? { NO_PROXY: value }
    : { NO_PROXY: value, no_proxy: value };
}
