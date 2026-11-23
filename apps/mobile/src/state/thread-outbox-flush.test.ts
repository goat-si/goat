import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { enqueueThreadOutboxMessage, flushThreadOutbox } from "./thread-outbox";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

it("rejects update flush when a queued outbox write fails (#3830)", async () => {
  const write = Promise.withResolvers<void>();
  using _spy = vi.spyOn(expoThreadOutboxStorage, "write").mockReturnValueOnce(write.promise);
  using _remove = vi.spyOn(expoThreadOutboxStorage, "remove").mockResolvedValueOnce();
  const enqueue = enqueueThreadOutboxMessage({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    commandId: CommandId.make("command"),
    text: "message",
    attachments: [],
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const failedEnqueue = expect(enqueue).rejects.toBeDefined();
  const flush = expect(flushThreadOutbox()).rejects.toBeDefined();
  write.reject(new Error("disk failed"));
  await Promise.all([failedEnqueue, flush]);
});
