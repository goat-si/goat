import type { McpProviderSessionConfig } from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

type RuntimeInstructionsInput = Parameters<typeof buildRuntimeInstructions>[0];

/** The thread's MCP session decides whether the turn carries the screen code guide. */
export const buildSessionRuntimeInstructions = (
  skills: McpProviderSessionConfig | undefined,
  runtime: Omit<RuntimeInstructionsInput, "skills">,
) =>
  buildRuntimeInstructions({
    ...runtime,
    skills,
    screenCodeSkillPath: skills?.screenCodeSkillPath,
  });
