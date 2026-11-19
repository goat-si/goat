import type { OrchestrationV2Command, OrchestrationV2Notification } from "@goat/contracts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

export function manualResumeCommand(command: MessageDispatch): MessageDispatch {
  if (command.manualContinuationOfRunId === undefined) return command;
  // Legacy clients still send synthetic text over this command for older servers.
  const { context: _context, titleSeed: _titleSeed, ...resume } = command;
  return { ...resume, text: "", attachments: [] };
}

export function manualResumeNotification(
  command: MessageDispatch,
): OrchestrationV2Notification | undefined {
  return command.manualContinuationOfRunId === undefined
    ? command.notification
    : { source: { kind: "system" }, outcome: "updated", summary: "Resumed thread" };
}

export function manualResumeRunFields(command: MessageDispatch) {
  return command.manualContinuationOfRunId === undefined
    ? {}
    : { manualContinuationOfRunId: command.manualContinuationOfRunId };
}
