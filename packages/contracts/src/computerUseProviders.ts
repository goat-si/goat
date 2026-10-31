/**
 * Providers whose agent process runs on this host and can spawn the driver's
 * stdio MCP server. Cloud providers run elsewhere, and the driver would
 * operate this host's desktop on their behalf; Muse only accepts HTTP session
 * servers. See ADR-0022 for the per-adapter table. Clients read it to say why
 * `@computer` cannot run before a turn is sent.
 */
export const COMPUTER_USE_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "fx",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);
