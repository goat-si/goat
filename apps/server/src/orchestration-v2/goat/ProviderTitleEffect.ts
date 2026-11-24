import type { CommandId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";

export const enqueueProviderTitleEffect = (
  command: { readonly type: string; readonly commandId: CommandId; readonly threadId: ThreadId },
  oldTitle: string,
  title: string,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) => {
  if (
    oldTitle === title ||
    ![
      "thread.metadata.update",
      "thread.title.regeneration.complete",
      "thread.title.regeneration.complete.internal",
    ].includes(command.type)
  )
    return Effect.void;
  return Ref.update(effects, (existing) => [
    ...existing,
    {
      id: `effect:${command.commandId}:provider-session.apply-thread-title`,
      commandId: command.commandId,
      threadId: command.threadId,
      request: { type: "provider-session.apply-thread-title", title },
    } satisfies PendingOrchestrationEffectV2,
  ]);
};
