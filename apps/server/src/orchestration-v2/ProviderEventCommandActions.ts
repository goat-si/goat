import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { isCommandActions, parseCommandActions } from "@goat/shared/commandActions";

/**
 * Providers that report only a raw shell command get a conservative read,
 * list, or search classification once, as the item arrives. Items a provider
 * already classified (Codex) keep that classification if it fits the wire.
 */
export function withCommandActions(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution") return item;
  const commandActions = item.commandActions ?? parseCommandActions(item.input);
  // Classification is optional; invalid metadata must never fail the provider run.
  if (!isCommandActions(commandActions)) return { ...item, commandActions: [] };
  return item.commandActions !== undefined || commandActions.length === 0
    ? item
    : { ...item, commandActions };
}
