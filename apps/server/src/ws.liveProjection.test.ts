import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2StoredEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { idleThreadProjection, liveThreadShell } from "./mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import { subscribeOrchestrationV2Thread } from "./ws.ts";
const ReplayTestLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
it.effect("shares each live event item across subscribers and dedupes bodies per subscriber", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:shared-live");
    const messageId = MessageId.make("message:shared-live");
    const at = DateTime.makeUnsafe("2026-10-31T00:00:00.000Z");
    const owner = { threadId, runId: null, nodeId: null, createdAt: at, updatedAt: at };
    // DateTime memoizes its formatted parts, so only the plain records are frozen.
    const freeze = <A>(value: A): A => {
      if (typeof value === "object" && value !== null && !DateTime.isDateTime(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const live: ReadonlyArray<OrchestrationV2StoredEvent> = freeze([
      {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:message"),
          type: "message.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: messageId,
            role: "assistant",
            text: "Done",
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
          },
        },
      },
      {
        sequence: 2,
        commandId: null,
        event: {
          id: EventId.make("event:shared-live:reply"),
          type: "turn-item.updated",
          threadId,
          occurredAt: at,
          payload: {
            ...owner,
            id: TurnItemId.make("item:shared-live:reply"),
            type: "assistant_message",
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            title: null,
            status: "completed",
            messageId,
            text: "Done",
            streaming: false,
            startedAt: at,
            completedAt: at,
          },
        },
      },
    ] as ReadonlyArray<OrchestrationV2StoredEvent>);
    const stringify = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(JSON, "stringify")),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    // The EventSink hands every subscriber the same projected objects.
    const subscribe = (acceptDedupedBodies: boolean) =>
      subscribeOrchestrationV2Thread({ threadId, afterSequence: 0, acceptDedupedBodies }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: () => Stream.fromIterable(live),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      );
    const [deduped, first, second] = yield* Effect.forEach([true, false, false], subscribe);

    assert.lengthOf(first!, live.length);
    first!.forEach((item, index) => {
      assert.strictEqual(item, second![index]);
      assert.strictEqual(item.kind === "event" && item.event, live[index]!.event);
    });
    assert.strictEqual(deduped![0], first![0]);
    const reply = deduped![1];
    assert.deepInclude(reply?.kind === "event" ? reply.event.payload : undefined, {
      text: "",
      textOmitted: true,
    });
    // The live buffer sizes each shared item once, not once per subscriber.
    assert.lengthOf(
      stringify.mock.calls.filter(([value]) => value?.kind === "event"),
      live.length,
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("negotiates compact visits for both persisted replay and the live tail", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const threadId = ThreadId.make("thread:wire-visit");
    const visitedAt = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
    const nextVisit = DateTime.makeUnsafe("2026-11-02T00:00:00.000Z");
    const projection = idleThreadProjection({
      ...liveThreadShell(threadId),
      lastVisitedAt: visitedAt,
    });
    const recorded = yield* store.appendAgentEvents({
      events: [
        {
          type: "thread.visit-recorded",
          id: EventId.make("event:wire-visit:stored"),
          threadId,
          occurredAt: visitedAt,
          payload: { lastVisitedAt: visitedAt },
        },
      ],
    });
    const sequence = recorded[0]!.sequence;
    const next: OrchestrationV2StoredEvent = {
      commandId: null,
      sequence: sequence + 1,
      event: {
        type: "thread.visit-recorded",
        id: EventId.make("event:wire-visit:live"),
        threadId,
        occurredAt: nextVisit,
        payload: { lastVisitedAt: nextVisit },
      },
    };
    const subscribe = (acceptCompactVisits: boolean) =>
      subscribeOrchestrationV2Thread({
        threadId,
        afterSequence: 0,
        ...(acceptCompactVisits ? { acceptCompactVisits } : {}),
      }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            ensureLegacyTranscript: () => Effect.void,
            streamStoredEventsFrom: () => Stream.make(next),
            getThreadRecords: () => Effect.succeed(projection),
            getThreadSnapshot: () =>
              Effect.succeed({ schemaVersion: 2, snapshotSequence: sequence, projection }),
          }),
        ),
      );

    const [oldClient, newClient] = yield* Effect.all([subscribe(false), subscribe(true)] as const);
    assert.deepEqual(oldClient, [
      { kind: "snapshot", snapshotSequence: sequence, projection },
      {
        kind: "event",
        sequence: next.sequence,
        event: {
          ...next.event,
          type: "thread.visited",
          payload: { ...projection.thread, lastVisitedAt: nextVisit },
        },
      },
    ]);
    assert.deepEqual(newClient, [
      { kind: "event", sequence, event: recorded[0]!.event },
      { kind: "event", sequence: next.sequence, event: next.event },
    ]);
  }).pipe(Effect.provide(ReplayTestLayer)),
);
