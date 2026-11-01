import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

/** Cursor resends the compact screen code guide on every turn whose MCP session carries the skill. */
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
