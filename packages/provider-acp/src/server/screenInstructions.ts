import type { GoatAcpInstructionState } from "@goat/provider-core/server/orchestrationInstructions";
import type { ProviderAdapterV2TurnInput } from "@goat/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";
import type { AcpMcpContext } from "./mcpContext.ts";

export const acpInstructionState = (
  turnInput: Pick<ProviderAdapterV2TurnInput, "runtimePolicy">,
  mcpContext: AcpMcpContext,
) =>
  ({
    interactionMode: turnInput.runtimePolicy.interactionMode,
    hasGoatMcp: mcpContext.servers.length > 0,
    screenCodeSkill: mcpContext.screenCodeSkill === true,
  }) satisfies GoatAcpInstructionState;

/** ACP resends the compact screen code guide on every turn whose MCP session carries the skill. */
export const buildAcpRuntimeInstructions = (
  mcpContext: AcpMcpContext,
  runtime: Parameters<typeof buildRuntimeInstructions>[0],
) =>
  buildRuntimeInstructions({
    ...runtime,
    screenCode: mcpContext.screenCodeSkill === true,
    screenCodeSkillPath: mcpContext.screenCodeSkillPath,
    screenCodeCompact: true,
  });
