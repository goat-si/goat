import type { OrchestrationV2TurnItem } from "@goat/contracts";

export const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

export function withoutPreparationResult(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
}
