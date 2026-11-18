import type { CommandId, MessageId, ThreadId } from "@goat/contracts";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

export function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}
