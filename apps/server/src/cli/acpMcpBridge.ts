import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { runAcpMcpBridgeFastPath } from "../mcp/AcpMcpStdioBridge.ts";
import { agentSurfaceInvocation, nodeInputReader } from "./agentSurfaceCommand.ts";
import { runAgentSurfaceCliMain } from "./agentSurfaceCli.ts";

/**
 * The credential stays in the environment, never on the command line.
 */
export const acpMcpBridgeCommand = Command.make("acp-mcp-bridge").pipe(
  Command.withDescription("Bridge GOAT's MCP endpoint to stdio for ACP agents."),
  Command.unlisted,
  Command.withHandler(() => Effect.promise(() => runAcpMcpBridgeFastPath())),
);

/**
 * bin.ts answers these before this CLI loads; they are listed here so goat --help names them,
 * and only see argv this parser accepted.
 */
const viaAgentSurface = (argv: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const invocation = agentSurfaceInvocation(argv, nodeInputReader);
    if (invocation !== undefined) process.exitCode = await runAgentSurfaceCliMain(invocation);
  });

const words = Argument.String("arguments").pipe(Argument.variadic());

export const acpMcpCallCommand = Command.make("acp-mcp-call", { words }).pipe(
  Command.withDescription("Alias of goat call that always prints the result envelope."),
  Command.unlisted,
  Command.withHandler(({ words }) => viaAgentSurface(["acp-mcp-call", ...words])),
);

export const callCommand = Command.make("call", { words }).pipe(
  Command.withDescription(
    "Call any GOAT capability by path through goat_call. See goat call --help.",
  ),
  Command.withHandler(({ words }) => viaAgentSurface(["call", ...words])),
);

export const describeCommand = Command.make("describe", { words }).pipe(
  Command.withDescription(
    "Find GOAT capabilities and their input schemas. See goat describe --help.",
  ),
  Command.withHandler(({ words }) => viaAgentSurface(["describe", ...words])),
);
