import { CommandId, EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  enqueueThreadOutboxMessage,
  flushThreadOutbox,
  threadOutboxManager,
} from "./thread-outbox";
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

it("drains a write enqueued while a load is in progress (#3830)", async () => {
  const load = Promise.withResolvers<{ messages: []; errors: [] }>();
  const write = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  using _load = vi.spyOn(expoThreadOutboxStorage, "load").mockReturnValueOnce(load.promise);
  using _write = vi.spyOn(expoThreadOutboxStorage, "write").mockImplementationOnce(() => {
    started.resolve();
    return write.promise;
  });
  const loading = threadOutboxManager.load();
  const flushing = flushThreadOutbox();
  const enqueue = enqueueThreadOutboxMessage({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("later"),
    commandId: CommandId.make("command"),
    text: "later",
    attachments: [],
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  load.resolve({ messages: [], errors: [] });
  await started.promise;
  let flushed = false;
  void flushing.then(() => {
    flushed = true;
  });
  await loading;
  await Promise.resolve();
  await Promise.resolve();
  const prematurelyFlushed = flushed;
  write.resolve();
  await Promise.all([enqueue, flushing]);
  expect(prematurelyFlushed).toBe(false);
});

it("does not block a flush on a failed read (#3830)", async () => {
  const load = Promise.withResolvers<{ messages: []; errors: [] }>();
  using _load = vi.spyOn(expoThreadOutboxStorage, "load").mockReturnValueOnce(load.promise);
  using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const clearing = threadOutboxManager.clearEnvironment(EnvironmentId.make("environment"));
  const failedClear = expect(clearing).rejects.toBeDefined();
  const flushing = expect(flushThreadOutbox()).resolves.toBeUndefined();
  load.reject(new Error("read failed"));
  await Promise.all([failedClear, flushing]);
});

it("keeps a write failure that lands while file writes drain (#3830)", async () => {
  const writes = Promise.withResolvers<void>();
  const write = Promise.withResolvers<void>();
  using _write = vi.spyOn(expoThreadOutboxStorage, "write").mockReturnValueOnce(write.promise);
  using _remove = vi.spyOn(expoThreadOutboxStorage, "remove").mockResolvedValueOnce();
  const flushing = threadOutboxManager.flush(() => writes.promise);
  const failedFlush = expect(flushing).rejects.toThrow("operation enqueue failed");
  const enqueue = enqueueThreadOutboxMessage({
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("during-drain"),
    commandId: CommandId.make("command"),
    text: "during drain",
    attachments: [],
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const failedEnqueue = expect(enqueue).rejects.toBeDefined();
  write.reject(new Error("disk failed"));
  await failedEnqueue;
  writes.resolve();
  await failedFlush;
});
