import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

export const skillOptions = (
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
) => ({
  computerUseSkill: McpProviderSession.carriesComputerUseSkill(mcpSession),
  screenCodeSkill: McpProviderSession.carriesScreenCodeSkill(mcpSession),
});

export const runtimeInstructions = (input: {
  readonly computerUseSkill?: boolean | undefined;
  readonly screenCodeSkill?: boolean | undefined;
  readonly mcpServers?: Readonly<Record<string, unknown>> | undefined;
}) =>
  buildRuntimeInstructions({
    harness: "Claude Code",
    screenCode: input.screenCodeSkill === true,
    computerUse:
      input.computerUseSkill !== false &&
      input.mcpServers?.[McpProviderSession.CUA_MCP_SERVER_NAME] !== undefined &&
      !McpProviderSession.isBlockedCuaServer(
        input.mcpServers[McpProviderSession.CUA_MCP_SERVER_NAME],
      ),
  });
