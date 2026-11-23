import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

/** The compact screen code guide follows the session's tool availability. */
export const buildCursorRuntimeInstructions = (
  config: McpProviderSession.McpProviderSessionConfig | undefined,
  runtime: Parameters<typeof buildRuntimeInstructions>[0],
) =>
  buildRuntimeInstructions({
    ...runtime,
    screenCode: McpProviderSession.carriesScreenCodeSkill(config),
    screenCodeSkillPath: config?.screenCodeSkillPath,
    screenCodeCompact: true,
  });
