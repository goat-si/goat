/** Providers whose local agent process can spawn the desktop driver's stdio server. */
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
