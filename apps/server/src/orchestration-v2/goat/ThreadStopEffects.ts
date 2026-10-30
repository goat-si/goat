import type { CommandId, ThreadId } from "@goat/contracts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";

export function delegatedTasksStopEffect(command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly reason?: string | undefined;
  readonly childThreadIds?: ReadonlyArray<ThreadId>;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${command.commandId}:delegated-tasks.stop`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "delegated-tasks.stop",
      ...(command.childThreadIds === undefined ? {} : { childThreadIds: command.childThreadIds }),
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  };
}

export const computerUseStopEffect = (command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}): PendingOrchestrationEffectV2 => ({
  id: `effect:${command.commandId}:computer-use.stop`,
  commandId: command.commandId,
  threadId: command.threadId,
  request: { type: "computer-use.stop" },
});
