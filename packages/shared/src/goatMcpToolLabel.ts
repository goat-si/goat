/** A tool label without a completion suffix, and the MCP name inside Antigravity's "Run mcp_<server>_<tool>". */
export function normalizeGoatMcpToolLabel(value: string): string {
  const label = value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  // Antigravity also asks "Run ...?" to approve a call.
  return /^(?:Run|Running|Ran) (?<name>mcp_\S+?)\??$/.exec(label)?.groups?.name ?? label;
}
