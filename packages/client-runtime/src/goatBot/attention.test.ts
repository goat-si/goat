import { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import type {
  ChannelAttentionEvent,
  ChannelAttentionFeedResult,
} from "@goat/contracts/channel-bot-attention";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import type { createChannelEnvironmentAtoms } from "../state/channels.ts";
import { watchGoatBotAttention } from "./attention.ts";

const environmentId = EnvironmentId.make("attention-env");
const event = (sequence: number): ChannelAttentionEvent => ({
  sequence,
  eventId: String(sequence),
  environmentId,
  botId: BotId.make("main"),
  taskId: ChannelTaskId.make("task"),
  kind: "question",
  generation: 1,
  occurredAt: "2026-11-21T00:00:00Z",
  botName: "Scout",
});

it("serializes replacement readers through presentation and preserves the newer cursor", async () => {
  const registry = AtomRegistry.make();
  const revisions = Atom.make(AsyncResult.success({ value: 0 }));
  let latest = 1;
  let cursor = 0;
  const writes: number[] = [];
  const channels = {
    listBotAttention: {
      permissionAtom: () => Atom.make(true),
      run: async (_registry: unknown, { input }: { input: { cursor: number } }) =>
        AsyncResult.success({
          cursor: latest,
          hasMore: false,
          mode: "needs_you",
          events: input.cursor < latest ? [event(latest)] : [],
        } satisfies ChannelAttentionFeedResult),
    },
    taskChanges: () => revisions,
  } as unknown as ReturnType<typeof createChannelEnvironmentAtoms>;
  const firstPresented = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const secondPresented = Promise.withResolvers<void>();
  const presented: number[] = [];
  const onError = vi.fn();
  const options = {
    registry,
    channels,
    environmentId,
    readCursor: async () => cursor,
    writeCursor: async (value: number) => {
      cursor = value;
      writes.push(value);
    },
    present: async ({ sequence }: ChannelAttentionEvent) => {
      presented.push(sequence);
      if (sequence === 1) {
        firstPresented.resolve();
        await finishFirst.promise;
      } else {
        secondPresented.resolve();
      }
    },
    onError,
  };
  const stop = watchGoatBotAttention(options);
  let stopReplacement = () => {};
  try {
    await firstPresented.promise;
    stop();
    latest = 2;
    let replacementRead = false;
    stopReplacement = watchGoatBotAttention({
      ...options,
      readCursor: async () => {
        replacementRead = true;
        return cursor;
      },
    });
    // The old reader is still presenting; a drain outside the lock reads here synchronously.
    const overtook = replacementRead;
    if (overtook) await secondPresented.promise;
    finishFirst.resolve();
    await secondPresented.promise;

    expect(overtook).toBe(false);
    expect(presented).toEqual([1, 2]);
    expect(writes).toEqual([1, 2]);
    expect(cursor).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    finishFirst.resolve();
    stop();
    stopReplacement();
    registry.dispose();
  }
});
