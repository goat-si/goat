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
  screenCodeSkillPath: mcpSession?.screenCodeSkillPath,
});

/**
 * The managed driver this thread's Codex config carries. A `cua-driver` the
 * user configured wins, so a thread never runs two drivers, unless the
 * session's decision overrides user config.
 */
export function codexManagedCuaDriver(
  mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
  userCuaDriver: boolean,
): CuaDriverMcpConfiguration | undefined {
  return mcpSession?.cuaDriver !== undefined &&
    (!userCuaDriver || mcpSession.cuaDriverOverridesUserConfig === true)
    ? mcpSession.cuaDriver
    : undefined;
}
