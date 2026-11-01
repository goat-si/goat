import {
  ORCHESTRATION_V2_MAX_COMMAND_ACTIONS,
  type OrchestrationV2CommandAction,
} from "@goat/contracts";
import { isCommandActions, parseCommandActions } from "@goat/shared/commandActions";
import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexCommandAction =
  | CodexSchema.V2ItemStartedNotification__CommandAction
  | CodexSchema.V2ItemCompletedNotification__CommandAction;

/**
 * Codex parses each exec command into read, list, and search steps. One
 * unknown step makes it a plain command, returned as an empty list so the
 * server does not reclassify it.
 */
export function codexCommandActions(
  actions: ReadonlyArray<CodexCommandAction>,
): OrchestrationV2CommandAction[] {
  if (actions.length > ORCHESTRATION_V2_MAX_COMMAND_ACTIONS) return [];
  const mapped: OrchestrationV2CommandAction[] = [];
  for (const action of actions) {
    switch (action.type) {
      case "read": {
        const path = action.path.trim();
        mapped.push({ type: "read", path });
        break;
      }
      case "listFiles": {
        // Codex may shorten display paths; recover only an unambiguous matching target.
        const inferred = parseCommandActions(action.command);
        const target =
          inferred.length === 1 && inferred[0]?.type === "list" ? inferred[0] : undefined;
        const path = target?.path ?? action.path?.trim();
        mapped.push({ type: "list", ...(path === undefined ? {} : { path }) });
        break;
      }
      case "search": {
        const query = action.query?.trim();
        const inferred = parseCommandActions(action.command);
        const target =
          inferred.length === 1 && inferred[0]?.type === "search" ? inferred[0] : undefined;
        const path = target?.path ?? action.path?.trim();
        mapped.push({
          type: "search",
          ...(query === undefined ? {} : { query }),
          ...(path === undefined ? {} : { path }),
        });
        break;
      }
      case "unknown":
        return [];
    }
  }
  return isCommandActions(mapped) ? mapped : [];
}
