import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";

/** Built-in skills a Codex turn's GOAT context carries; computer use also needs the managed driver. */
export const codexTurnSkills = (
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
  cuaDriver: CuaDriverMcpConfiguration | undefined,
) => ({
  computerUse:
    mcpSession !== undefined &&
    cuaDriver !== undefined &&
    McpProviderSession.carriesComputerUseSkill(mcpSession),
  screenCode: McpProviderSession.carriesScreenCodeSkill(mcpSession),
});
