import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { goatBrowserInstructions } from "@goat/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

export const skillOptions = (
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
) => ({
  browserToolsAvailable: mcpSession?.browserToolsAvailable === true,
  computerUseSkill: McpProviderSession.carriesComputerUseSkill(mcpSession),
  screenCodeSkill: McpProviderSession.carriesScreenCodeSkill(mcpSession),
  screenCodeSkillPath: mcpSession?.screenCodeSkillPath,
});

export const runtimeInstructions = (input: {
  readonly browserToolsAvailable?: boolean | undefined;
  readonly computerUseSkill?: boolean | undefined;
  readonly screenCodeSkill?: boolean | undefined;
  readonly screenCodeSkillPath?: string | undefined;
  readonly mcpServers?: Readonly<Record<string, unknown>> | undefined;
}) =>
  buildRuntimeInstructions({
    harness: "Claude Code",
    screenCode: input.screenCodeSkill === true,
    screenCodeSkillPath: input.screenCodeSkillPath,
    computerUse:
      input.computerUseSkill !== false &&
      input.mcpServers?.[McpProviderSession.CUA_MCP_SERVER_NAME] !== undefined &&
      !McpProviderSession.isBlockedCuaServer(
        input.mcpServers[McpProviderSession.CUA_MCP_SERVER_NAME],
      ),
  }) + goatBrowserInstructions(input.browserToolsAvailable);
