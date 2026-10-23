/**
 * Every ACP agent spawns `goat acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `goat call` (or its alias `goat acp-mcp-call`) per tool call, so their startup sits
 * on first-message latency. They, `goat describe` and the registry's `goat <resource> <verb>`
 * commands dispatch here before the full CLI module graph (seconds of evaluation) loads;
 * everything else defers to the real CLI in ./binCli.ts.
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
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "acp-mcp-bridge") {
    const { runAcpMcpBridgeFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpBridgeFastPath();
  } else if (command === "cua-lease-proxy") {
    // Spawned by providers for an unattended thread's approved computer use; see ComputerUseLeaseProxy.
    const { runLeaseProxyCli } = await import("./cua/ComputerUseLeaseProxyCli.ts");
    await runLeaseProxyCli(process.argv.slice(3));
  } else {
    const { agentSurfaceInvocation, nodeInputReader } =
      await import("./cli/agentSurfaceCommand.ts");
    const invocation = agentSurfaceInvocation(process.argv.slice(2), nodeInputReader);
    if (invocation !== undefined) {
      const { runAgentSurfaceCliMain } = await import("./cli/agentSurfaceCli.ts");
      process.exitCode = await runAgentSurfaceCliMain(invocation);
    } else {
      // Before anything reads stdin: the desktop app's Windows launcher starts
      // the CLI without one. Never for the fast paths, whose stdin is a pipe.
      const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
      attachConsoleStdin();
      const { runCli } = await import("./binCli.ts");
      runCli();
    }
  }
}
