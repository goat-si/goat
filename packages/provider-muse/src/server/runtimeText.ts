import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import * as RuntimeInstructions from "@goat/provider-core/server/runtimeInstructions";

/** The text a Muse turn starts with; the thread's MCP session decides the screen guide and its file. */
export const museRuntimeText = (input: {
  readonly model: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly skills: McpProviderSessionConfig | undefined;
}) =>
  `${RuntimeInstructions.buildRuntimeInstructions({
    harness: "Muse Code",
    ...input,
  })}\n\n${RuntimeInstructions.GOAT_PULL_REQUEST_INSTRUCTIONS}`;
