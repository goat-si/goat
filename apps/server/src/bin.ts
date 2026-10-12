/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `goat acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `goat acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import { adoptLegacyEnv } from "@goat/contracts/legacyT3Names";

import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Shells, service units and shims written before the GOAT rename still set legacy names.
  // They stay set: the service launcher dispatched below starts retained older builds.
  adoptLegacyEnv(process.env);
  const command = process.argv[2];
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
