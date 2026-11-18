import { CommandId, EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveQueuedThreadSettings, type QueuedThreadMessage } from "./thread-outbox-model";

function queuedMessage(input: {
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  // regression: #29729 Cursor runs its own Fast default when the turn carries no fastMode
  it("sends the Fast off the picker shows for a model without a Fast selection", () => {
    const cursor = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const providers = [
      {
        instanceId: cursor.instanceId,
        showInteractionModeToggle: true,
        models: [
          {
            slug: cursor.model,
            capabilities: {
              optionDescriptors: [
                { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
              ],
            },
          },
        ],
      },
    ];
    const thread = {
      modelSelection: cursor,
      runtimeMode: "full-access",
      interactionMode: "default",
    } as const;
    const message = queuedMessage({ messageId: "fast", createdAt: "2026-11-03T10:00:00.000Z" });
    const fastOn = { ...cursor, options: [{ id: "fastMode", value: true }] };

    expect(resolveQueuedThreadSettings(message, thread, providers).modelSelection.options).toEqual([
      { id: "fastMode", value: false },
    ]);
    expect(
      resolveQueuedThreadSettings({ ...message, modelSelection: fastOn }, thread, providers)
        .modelSelection,
    ).toEqual(fastOn);
  });
});
