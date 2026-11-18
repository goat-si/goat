import type { ThreadManagementProvenance } from "./ThreadManagementService.ts";
import type { OrchestrationV2Command } from "@goat/contracts";

type Create = Extract<OrchestrationV2Command, { readonly type: "thread.create" }>;

export function threadCreateMessage(
  command: Create,
  initialMessage: NonNullable<Create["initialMessage"]>,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  const { workspaceStrategy, ...message } = initialMessage;
  return {
    ...message,
    type: "message.dispatch",
    commandId: command.commandId,
    threadId: command.threadId,
    modelSelection: command.modelSelection,
    dispatchMode:
      workspaceStrategy === undefined
        ? { type: "start_immediately" }
        : { type: "defer_start", workspaceStrategy },
    createdBy: command.createdBy,
    creationSource: command.creationSource,
  };
}

export function stampThreadCreate(command: Create, provenance: ThreadManagementProvenance): Create {
  const { initialMessage: _initialMessage, ...create } = command;
  if (provenance.createdBy !== "user") return { ...create, ...provenance };
  const { launchedBy: _launcher, externalLauncher: _externalLauncher, ...userCommand } = create;
  return { ...userCommand, memoryGrantCeiling: "none", ...provenance };
}
