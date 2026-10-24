import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import { COMPUTER_USE_INSTRUCTIONS } from "@goat/provider-core/server/runtimeInstructions";

/** A process launched with the driver and the skill already has the skill in its system prompt. */
export const launchedWithComputerUseSkill = (
  cuaKey: string,
  config: McpProviderSession.McpProviderSessionConfig | undefined,
) => cuaKey !== "" && McpProviderSession.carriesComputerUseSkill(config);

/**
 * The computer use skill a live Claude process still needs on this prompt, if any. Its system
 * prompt is fixed at launch, so a process that predates the driver, or the skill being switched
 * back on in Settings, learns the skill from the first prompt after that, once.
 */
export function pendingComputerUseNotice(
  query: { readonly cuaDriverKey: string; computerUseInstructed: boolean },
  config: McpProviderSession.McpProviderSessionConfig | undefined,
): string | undefined {
  if (
    !McpProviderSession.carriesComputerUseSkill(config) ||
    query.cuaDriverKey === "" ||
    query.cuaDriverKey === "blocked" ||
    query.computerUseInstructed
  )
    return undefined;
  query.computerUseInstructed = true;
  return COMPUTER_USE_INSTRUCTIONS;
}
