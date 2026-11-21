import {
  BotId,
  ChannelTaskId,
  EnvironmentId,
  pendingDecisionId,
  RuntimeRequestId,
  ThreadId,
  type ChannelTask,
  type DecisionItem,
} from "@goat/contracts";
import type {
  ChannelAttentionEvent,
  ChannelAttentionFeedResult,
  ChannelAttentionRequest,
} from "@goat/contracts/channel-bot-attention";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import type { createChannelEnvironmentAtoms } from "../state/channels.ts";
import {
  answerBotAttentionApproval,
  resolveBotAttentionDecision,
  watchGoatBotAttention,
} from "./attention.ts";

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

const workerEnvironment = EnvironmentId.make("worker");
const workerRequest = {
  kind: "runtime",
  host: "box",
  threadId: ThreadId.make("remote-child"),
  requestId: RuntimeRequestId.make("approval:42"),
} satisfies ChannelAttentionRequest;
const localTask = {
  generation: 1,
  openQuestions: [],
  worker: { environmentId, threadId: ThreadId.make("local-worker") },
  observed: { needsYou: [{ kind: "approval", approval: workerRequest }] },
} as ChannelTask;
const item = {
  id: pendingDecisionId(workerRequest.threadId, workerRequest.requestId),
  status: "open",
  from: { environmentId: workerEnvironment, host: workerRequest.host },
  pending: {
    threadId: workerRequest.threadId,
    requestId: workerRequest.requestId,
    approval: { kind: "command" },
  },
} as DecisionItem;

it.each(["paired", "unpaired", "cleared"] as const)(
  "checks the destination before routing a local worker's remote child request (%s)",
  async (state) => {
    const registry = AtomRegistry.make();
    try {
      const run = vi
        .fn()
        .mockResolvedValueOnce(AsyncResult.success(item))
        .mockResolvedValueOnce(
          AsyncResult.success({
            ...item,
            from: { environmentId: workerEnvironment },
            status: state === "cleared" ? "answered" : "open",
          }),
        );
      const services = {
        decisions: { getDecision: { run } },
        orchestration: {},
        connected: () => state !== "unpaired",
      } as unknown as Parameters<typeof resolveBotAttentionDecision>[1];
      expect(
        await resolveBotAttentionDecision(
          registry,
          services,
          environmentId,
          localTask,
          workerRequest,
        ),
      ).toEqual(
        state === "paired"
          ? {
              environmentId: workerEnvironment,
              threadId: workerRequest.threadId,
              requestId: workerRequest.requestId,
            }
          : null,
      );
      expect(run).toHaveBeenNthCalledWith(1, registry, {
        environmentId,
        input: { id: item.id, host: workerRequest.host },
      });
      expect(run).toHaveBeenCalledTimes(state === "unpaired" ? 1 : 2);
    } finally {
      registry.dispose();
    }
  },
);

it("answers a current approval through its origin and refuses a host whose identity changed", async () => {
  const registry = AtomRegistry.make();
  try {
    const allowed = Atom.make(true);
    const target = { ...event(1), request: workerRequest };
    const channels = {
      listBotAttention: { permissionAtom: () => allowed },
      readAttentionTask: { run: async () => AsyncResult.success(localTask) },
    } as unknown as Parameters<typeof answerBotAttentionApproval>[1];
    const answer = vi.fn().mockResolvedValue(AsyncResult.success(item));
    const decisions = {
      getDecision: { run: async () => AsyncResult.success(item) },
      answerDecision: { run: answer },
    } as unknown as Parameters<typeof answerBotAttentionApproval>[2];
    expect(
      await answerBotAttentionApproval(
        registry,
        channels,
        decisions,
        target,
        "accept",
        EnvironmentId.make("other"),
      ),
    ).toBe(false);
    expect(
      await answerBotAttentionApproval(
        registry,
        channels,
        decisions,
        target,
        "accept",
        workerEnvironment,
      ),
    ).toBe(true);
    expect(answer).toHaveBeenCalledExactlyOnceWith(registry, {
      environmentId,
      input: {
        id: item.id,
        host: workerRequest.host,
        decision: "accept",
        reason: "Approved in GOAT Bot.",
      },
    });
  } finally {
    registry.dispose();
  }
});
