import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  OrchestrationV2RpcSchemas,
} from "@goat/contracts";
import {
  makeThreadTextAppendDecoder,
  makeThreadTextAppendEncoder,
} from "@goat/shared/threadTextAppend";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
  makeThreadLiveEventCoalescer,
} from "./ThreadLiveEventCoalescer.ts";

import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
const threadId = ThreadId.make("thread-coalescer-test");
const runId = RunId.make("run-coalescer-test");
const now = DateTime.makeUnsafe("2026-01-01T00:00:01.000Z");
const encodeEvent = JSON.stringify;

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: "tool.updated" | "tool.completed";
    readonly toolCallId?: string;
    readonly turnId?: RunId;
  } = {},
): ThreadEvent {
  const itemRunId = options.turnId ?? runId;
  const status = options.kind === "tool.completed" ? "completed" : "running";
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "turn-item.updated",
      threadId,
      runId: itemRunId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(options.toolCallId ?? "call-edit"),
        type: "command_execution",
        threadId,
        runId: itemRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status,
        title: "Editing app.ts",
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
        input: "echo app.ts",
        output: `output-${sequence}`,
      },
    },
  };
}

function makeMessage(sequence: number, text = "Still working"): ThreadEvent {
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-${sequence}`),
      type: "message.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`message-${sequence}`),
        threadId,
        runId,
        nodeId: null,
        createdBy: "agent",
        creationSource: "provider",
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

function makeStreamingMessage(
  sequence: number,
  options: {
    readonly id?: string;
    readonly text?: string;
    readonly streaming?: boolean;
  } = {},
): ThreadEvent {
  const message = makeMessage(sequence, options.text ?? `text-${sequence}`);
  if (message.event.type !== "message.updated") throw new Error("Expected message");
  return {
    ...message,
    event: {
      ...message.event,
      payload: {
        ...message.event.payload,
        id: MessageId.make(options.id ?? "message"),
        streaming: options.streaming ?? true,
      },
    },
  };
}

function makeTextItem(
  sequence: number,
  options: {
    readonly id?: string;
    readonly text?: string;
    readonly type?: "assistant_message" | "reasoning";
    readonly status?: OrchestrationV2TurnItem["status"];
    readonly streaming?: boolean;
  } = {},
): ThreadEvent {
  const tool = makeToolActivity(sequence);
  if (tool.event.type !== "turn-item.updated" || tool.event.payload.type !== "command_execution")
    throw new Error("Expected command item");
  const { input: _input, output: _output, ...base } = tool.event.payload;
  return {
    ...tool,
    event: {
      ...tool.event,
      payload: {
        ...base,
        id: TurnItemId.make(options.id ?? "item"),
        type: options.type ?? "assistant_message",
        messageId: MessageId.make("message"),
        text: options.text ?? `text-${sequence}`,
        status: options.status ?? "running",
        streaming: options.streaming ?? true,
      },
    },
  };
}

const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
} satisfies OrchestrationV2ThreadProjection;

describe("ThreadLiveEventCoalescer", () => {
  it("preserves tool-call identity switches as insertion-order boundaries", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "call-a" }),
      makeToolActivity(2, { toolCallId: "call-b" }),
      makeToolActivity(3, { toolCallId: "call-a" }),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("does not coalesce stable tool calls across turns", () => {
    const events = [
      makeToolActivity(1, { turnId: RunId.make("turn-old") }),
      makeToolActivity(2, { turnId: RunId.make("turn-new") }),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("flushes a stable update run before a completion boundary", () => {
    const events = [
      makeToolActivity(1),
      makeToolActivity(2),
      makeToolActivity(3, { kind: "tool.completed" }),
      makeToolActivity(4),
    ];

    expect(coalesceLiveUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("keeps the latest full text in sequence order and preserves state after every survivor cursor", () => {
    const events = [
      makeStreamingMessage(1, { id: "shared", text: "H" }),
      makeTextItem(2, { id: "shared", text: "H" }),
      makeTextItem(3, { id: "reasoning", type: "reasoning", text: "Think" }),
      makeToolActivity(4),
      makeTextItem(5, { id: "unique", text: "Keep me" }),
      makeStreamingMessage(6, { id: "shared", text: "Hello" }),
      makeTextItem(7, { id: "shared", text: "Hello" }),
      makeTextItem(8, { id: "reasoning", type: "reasoning", text: "Thinking done" }),
      makeToolActivity(9),
      makeStreamingMessage(10, { id: "shared", streaming: false, text: "Hello!" }),
      makeTextItem(11, { id: "shared", streaming: false, status: "completed", text: "Hello!" }),
    ];
    const survivors = coalesceLiveUpdatedEvents(events);
    expect(survivors).toEqual(events);

    const latestStates = (input: ReadonlyArray<ThreadEvent>) =>
      Object.fromEntries(
        input.map(({ event }) => [
          `${event.type}:${"id" in event.payload ? event.payload.id : ""}`,
          event.payload,
        ]),
      );
    for (let index = 0; index < survivors.length; index += 1) {
      const received = survivors.slice(0, index + 1);
      const cursor = received.at(-1)!.sequence;
      const resumed = coalesceLiveUpdatedEvents(events.filter((event) => event.sequence > cursor));
      expect(latestStates([...received, ...resumed])).toEqual(latestStates(events));
    }
  });

  it("preserves assistant-message identity changes as insertion-order boundaries", () => {
    const events = [
      makeStreamingMessage(1, { id: "message-a" }),
      makeTextItem(2, { id: "item-a" }),
      makeStreamingMessage(3, { id: "message-b" }),
      makeTextItem(4, { id: "item-b" }),
      makeStreamingMessage(5, { id: "message-a" }),
      makeTextItem(6, { id: "item-a" }),
    ];
    expect(coalesceLiveUpdatedEvents(events)).toEqual(events);
  });

  it.effect(
    "preserves turn-item insertion and partial timeline state after every survivor cursor",
    () =>
      Effect.gen(function* () {
        const item = (
          sequence: number,
          id: string,
          text: string,
          completed = false,
        ): ThreadEvent => {
          const input = makeTextItem(sequence, {
            id,
            text,
            type: "reasoning",
            status: completed ? "completed" : "running",
            streaming: !completed,
          });
          if (input.event.type !== "turn-item.updated") throw new Error("Expected turn item");
          return {
            ...input,
            event: {
              ...input.event,
              runId: undefined,
              payload: {
                ...input.event.payload,
                runId: null,
                ordinal: id === "a" ? 1 : 2,
                completedAt: completed ? now : null,
              },
            },
          };
        };
        const events = [
          item(1, "a", "A"),
          item(2, "b", "B"),
          item(3, "a", "AA"),
          item(4, "a", "Final A", true),
          item(5, "b", "Final B", true),
        ];
        const apply = (inputs: ReadonlyArray<ThreadEvent>, partialTimeline: boolean) => {
          let projection: OrchestrationV2ThreadProjection = emptyProjection;
          let latestLocalTurnOrdinal = 0;
          for (const { event } of inputs) {
            const next = applyOrchestrationV2ProjectionEvent(projection, event, {
              partialTimeline,
              latestLocalTurnOrdinal,
            });
            if (next === null || next === projection) continue;
            projection = next;
            if (partialTimeline && event.type === "turn-item.updated") {
              latestLocalTurnOrdinal = Math.max(latestLocalTurnOrdinal, event.payload.ordinal);
            }
          }
          return projection;
        };
        const survivors = yield* Stream.fromIterable(events).pipe(
          coalesceThreadLiveStream,
          Stream.filter((input): input is ThreadEvent => input.kind === "event"),
          Stream.runCollect,
        );
        for (const partialTimeline of [true, false]) {
          const expected = apply(events, partialTimeline);
          expect(
            expected.turnItems.map((item) => [item.id, "text" in item ? item.text : null]),
          ).toEqual([
            ["a", "Final A"],
            ["b", "Final B"],
          ]);
          expect(apply(survivors, partialTimeline)).toEqual(expected);
          for (const [index, survivor] of survivors.entries()) {
            const received = survivors.slice(0, index + 1);
            const replay = yield* Stream.fromIterable(
              events.filter((event) => event.sequence > survivor.sequence),
            ).pipe(
              coalesceThreadLiveStream,
              Stream.filter((input): input is ThreadEvent => input.kind === "event"),
              Stream.runCollect,
            );
            expect(apply([...received, ...replay], partialTimeline)).toEqual(expected);
          }
        }
      }),
  );

  it.effect("flushes text at synchronization and completion boundaries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer();
        const events = [
          makeStreamingMessage(1),
          makeTextItem(2, { type: "reasoning" }),
          makeStreamingMessage(3),
          makeTextItem(4, { type: "reasoning" }),
          { kind: "synchronized" } as const,
          makeStreamingMessage(5),
          makeTextItem(6, { type: "reasoning" }),
          makeStreamingMessage(7, { streaming: false, text: "Final answer" }),
          makeTextItem(8, {
            type: "reasoning",
            streaming: false,
            status: "completed",
            text: "Final answer",
          }),
          makeStreamingMessage(9),
          makeTextItem(10, { type: "reasoning" }),
        ];
        yield* coalescer.offerAll(events);
        yield* coalescer.end;
        expect(yield* Stream.runCollect(coalescer.stream)).toEqual(events.slice(2));
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );

  it.effect(
    "flushes growing text on the fixed window and charges only unacknowledged survivors",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const coalescer = yield* makeThreadLiveEventCoalescer();
          const first = [makeStreamingMessage(1, { text: "é" }), makeTextItem(2, { text: "é" })];
          const latest = [makeStreamingMessage(3, { text: "éé" }), makeTextItem(4, { text: "éé" })];
          const serializedBytes = (events: ReadonlyArray<ThreadEvent>) =>
            events.reduce((sum, event) => sum + Buffer.byteLength(encodeEvent(event)), 0);
          yield* coalescer.offerAll(first);
          yield* TestClock.adjust("40 millis");
          yield* coalescer.offerAll(latest);
          expect(yield* coalescer.usage).toEqual({
            retainedItems: 4,
            retainedSerializedBytes: serializedBytes([...first, ...latest]),
          });
          yield* TestClock.adjust("10 millis");
          const expectedUsage = {
            retainedItems: 2,
            retainedSerializedBytes: serializedBytes(latest),
          };
          expect(yield* coalescer.usage).toEqual(expectedUsage);
          const pull = yield* Stream.toPull(coalescer.stream);
          expect(yield* pull).toEqual(latest);
          expect(yield* coalescer.usage).toEqual(expectedUsage);

          const next = [makeStreamingMessage(5), makeTextItem(6)];
          yield* coalescer.offerAll(next);
          yield* TestClock.adjust("50 millis");
          expect(yield* pull).toEqual(next);
          yield* coalescer.end;
          yield* pull.pipe(Effect.result);
          expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
        }),
      ),
  );

  it.effect("keeps the flush timer alive when an offer's shorter scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        yield* Effect.scoped(coalescer.offer(makeToolActivity(1)));
        yield* TestClock.adjust("50 millis");
        const items = yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect);
        expect(items.map((item) => (item.kind === "event" ? item.sequence : item.kind))).toEqual([
          1,
        ]);
      }),
    ),
  );

  it.effect("keeps an unacknowledged batch charged and clears later events on overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({ maxItems: 3 });
        const first = makeMessage(1, "é".repeat(1_024));
        yield* coalescer.offer(first);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(coalescer.stream);
            const batch = yield* pull;
            expect(batch.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([
              1,
            ]);
            yield* coalescer.offer(makeMessage(2));
            yield* coalescer.offer(makeToolActivity(3));
            expect((yield* coalescer.usage).retainedItems).toBe(3);

            const overflow = yield* coalescer
              .offer(makeToolActivity(4, { kind: "tool.completed" }))
              .pipe(Effect.result);
            expect(overflow._tag).toBe("Failure");
            yield* coalescer.closed;
            expect(yield* coalescer.usage).toEqual({
              retainedItems: 1,
              retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
            });
          }),
        );
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});

it.effect("flushes the last update before a finite source ends", () =>
  Effect.gen(function* () {
    const result = yield* Stream.make(makeToolActivity(1), makeToolActivity(2)).pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
    );
    expect(result.map((item) => (item.kind === "event" ? item.sequence : null))).toEqual([2]);
  }),
);

it.effect("propagates an upstream failure instead of leaving the subscriber waiting", () =>
  Effect.gen(function* () {
    const result = yield* Stream.fail("source stopped").pipe(
      coalesceThreadLiveStream,
      Stream.runCollect,
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe("source stopped");
  }),
);

describe("live text appends", () => {
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pieces = ["a", "bc", " ", "é", "😀", "\n", "def"];
  const ids = ["m1", "m2", "r1", "r2"];
  const wire = Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output);
  const toWire = Schema.encodeSync(wire);
  const fromWire = Schema.decodeUnknownSync(wire);

  const reasoning = (sequence: number, id: string, text: string, streaming: boolean) => {
    const input = makeTextItem(sequence, {
      id,
      text,
      type: "reasoning",
      status: streaming ? "running" : "completed",
      streaming,
    });
    if (input.event.type !== "turn-item.updated" || input.event.payload.type !== "reasoning")
      throw new Error("Expected reasoning");
    // The shared fixture carries an assistant `messageId` the wire schema drops from reasoning.
    const { messageId: _messageId, ...payload } = { messageId: null, ...input.event.payload };
    return {
      ...input,
      event: { ...input.event, payload: { ...payload, ordinal: ids.indexOf(id) } },
    };
  };

  const history = (random: () => number) => {
    const texts = new Map<string, string>();
    const events: ThreadEvent[] = [];
    for (let sequence = 1; sequence <= 120; sequence += 1) {
      const roll = random();
      if (roll < 0.05) {
        events.push(
          makeToolActivity(sequence, { kind: "tool.completed", toolCallId: `c${sequence}` }),
        );
        continue;
      }
      const id = ids[Math.floor(random() * ids.length)]!;
      const previous = texts.get(id) ?? "";
      const text =
        roll < 0.09
          ? previous.slice(0, Math.floor(random() * previous.length))
          : roll < 0.12
            ? `#${previous.slice(1)}`
            : previous + pieces[Math.floor(random() * pieces.length)]!;
      const streaming = random() > 0.05;
      texts.set(id, text);
      events.push(
        id.startsWith("m")
          ? makeStreamingMessage(sequence, { id, text, streaming })
          : reasoning(sequence, id, text, streaming),
      );
    }
    return events;
  };

  const deliver = (events: ReadonlyArray<ThreadEvent>, random: () => number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* makeThreadLiveEventCoalescer({
          maxItems: 100_000,
          maxSerializedBytes: 1_000_000_000,
        });
        for (let index = 0; index < events.length;) {
          const size = 1 + Math.floor(random() * 6);
          yield* coalescer.offerAll(events.slice(index, index + size));
          index += size;
          if (random() < 0.7) yield* TestClock.adjust("50 millis");
        }
        yield* coalescer.end;
        const encode = makeThreadTextAppendEncoder();
        const items = yield* Stream.runCollect(coalescer.stream);
        return Array.from(items, (item) => fromWire(toWire(encode(item))));
      }),
    );

  const reduce = (projection: OrchestrationV2ThreadProjection, event: ThreadEvent["event"]) =>
    applyOrchestrationV2ProjectionEvent(projection, event) ?? projection;

  it.effect(
    "converges on the server's text across random growth, rewrites, and resumes (seeded property)",
    () =>
      Effect.gen(function* () {
        let appends = 0;
        for (let seed = 1; seed <= 40; seed += 1) {
          const random = seeded(seed);
          const events = history(random);
          const expected = events.reduce<OrchestrationV2ThreadProjection>(
            (state, { event }) => reduce(state, event),
            emptyProjection,
          );
          const last = events.at(-1)?.sequence ?? 0;
          let projection: OrchestrationV2ThreadProjection = emptyProjection;
          let applied = 0;
          for (let attempt = 0; applied < last; attempt += 1) {
            expect(attempt).toBeLessThan(100);
            const delivered = yield* deliver(
              events.filter((event) => event.sequence > applied),
              random,
            );
            const decode = makeThreadTextAppendDecoder();
            const received =
              random() < 0.4 ? Math.floor(random() * delivered.length) : delivered.length;
            for (const item of delivered.slice(0, received)) {
              if (item.kind === "text-append") appends += 1;
              const resolved = decode(item);
              expect(resolved).not.toBeNull();
              if (resolved?.kind !== "event" || resolved.sequence <= applied) continue;
              applied = resolved.sequence;
              projection = reduce(projection, resolved.event);
            }
          }
          expect(projection.messages.length + projection.turnItems.length).toBeGreaterThan(0);
          expect(projection).toEqual(expected);
        }
        expect(appends).toBeGreaterThan(100);
      }),
  );
});
