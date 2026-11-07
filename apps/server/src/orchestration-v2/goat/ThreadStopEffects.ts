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

export const deviceReleaseEffect = (command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}): PendingOrchestrationEffectV2 => ({
  id: `effect:${command.commandId}:device.release`,
  commandId: command.commandId,
  threadId: command.threadId,
  request: { type: "device.release" },
});

/** Archiving closes the thread's terminals; archiving and settling end its device sessions. */
export const threadCloseEffects = (command: {
  readonly type: "thread.archive" | "thread.settle";
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
}): ReadonlyArray<PendingOrchestrationEffectV2> => [
  ...(command.type === "thread.archive"
    ? [
        {
          id: `effect:${command.commandId}:terminal.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "terminal.cleanup" },
        } satisfies PendingOrchestrationEffectV2,
      ]
    : []),
  deviceReleaseEffect(command),
];
