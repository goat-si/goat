import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import { shouldRetryThreadOutboxDelivery, type QueuedThreadMessage } from "./thread-outbox-model";

function queuedMessage(input: { messageId: string; createdAt: string }): QueuedThreadMessage {
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

describe("shared upload outbox", () => {
  it("composes concurrent modifications of one message instead of rejecting the later one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-two-uploads",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(message);

    // Two attachments finishing together each record their upload on the same message.
    const results = await Promise.all([
      manager.modify(message.messageId, (current) => ({ ...current, text: `${current.text} a` })),
      manager.modify(message.messageId, (current) => ({ ...current, text: `${current.text} b` })),
    ]);

    expect(results).toEqual([true, true]);
    const composed = { ...message, text: `${message.text} a b` };
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [composed],
    });
    expect(stored.get(message.messageId)).toEqual(composed);
    await manager.remove(composed);
    await expect(manager.modify(message.messageId, (current) => current)).resolves.toBe(false);
    registry.dispose();
  });

  it("retries shared upload failures only when their cause is retryable", () => {
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ComposerAttachmentUploadError",
        cause: { _tag: "EnvironmentRpcUnavailableError" },
      }),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ComposerAttachmentUploadError",
        cause: { _tag: "EnvironmentAuthorizationError" },
      }),
    ).toBe(false);
  });
});
