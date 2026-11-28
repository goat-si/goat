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
import * as SqlClient from "effect/sql/SqlClient";
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
    const archived = {
      ...projection,
      thread: { ...projection.thread, lastVisitedAt: nextVisit, archivedAt: nextVisit },
    };
    const archive: OrchestrationV2StoredEvent = {
      commandId: null,
      sequence: next.sequence + 1,
      event: {
        type: "thread.archived",
        id: EventId.make("event:wire-visit:archive"),
        threadId,
        occurredAt: nextVisit,
        payload: archived.thread,
      },
    };
    const afterArchive: OrchestrationV2StoredEvent = {
      commandId: null,
      sequence: archive.sequence + 1,
      event: {
        type: "thread.unarchived",
        id: EventId.make("event:wire-visit:unarchive"),
        threadId,
        occurredAt: nextVisit,
        payload: { ...archived.thread, archivedAt: null },
      },
    };
    const subscribe = (acceptCompactVisits: boolean) => {
      let servedInitialSnapshot = false;
      return subscribeOrchestrationV2Thread({
        threadId,
        afterSequence: 0,
        ...(acceptCompactVisits ? { acceptCompactVisits } : {}),
      }).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map((items) => Array.from(items)),
        Effect.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            ensureLegacyTranscript: () => Effect.void,
            streamStoredEventsFrom: () => Stream.make(next, archive, afterArchive),
            getThreadSnapshot: () =>
              Effect.sync(() => {
                if (servedInitialSnapshot)
                  return {
                    schemaVersion: 2 as const,
                    snapshotSequence: archive.sequence,
                    projection: archived,
                  };
                servedInitialSnapshot = true;
                return { schemaVersion: 2 as const, snapshotSequence: sequence, projection };
              }),
          }),
        ),
      );
    };

    const [oldClient, newClient] = yield* Effect.all([subscribe(false), subscribe(true)] as const);
    assert.deepEqual(oldClient, [
      { kind: "snapshot", snapshotSequence: sequence, projection },
      { kind: "snapshot", snapshotSequence: archive.sequence, projection: archived },
      { kind: "event", sequence: afterArchive.sequence, event: afterArchive.event },
    ]);
    assert.deepEqual(newClient, [
      { kind: "event", sequence, event: recorded[0]!.event },
      { kind: "event", sequence: next.sequence, event: next.event },
      { kind: "event", sequence: archive.sequence, event: archive.event },
      { kind: "event", sequence: afterArchive.sequence, event: afterArchive.event },
    ]);
  }).pipe(Effect.provide(ReplayTestLayer)),
);

it.effect("thread resume replays a deleted thread's deletion and nothing recorded before it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-13T00:00:00.000Z";
    const threadId = ThreadId.make("thread:deleted-resume");
    const insert = (version: number, type: string, payload: object) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`deleted-resume:${version}`}, 'thread', ${threadId}, ${version}, ${type},
        ${now}, 'server', ${JSON.stringify(payload)}, '{}', 2
      )
    `;
    const detached = { providerSessionId: "session:deleted-resume", detachedAt: now };
    yield* insert(0, "provider-session.detached", detached);
    yield* insert(1, "provider-session.detached", detached);
    yield* insert(2, "thread.deleted", {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: "project:deleted-resume",
      title: "Deleted",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: now,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    });

    const items = yield* subscribeOrchestrationV2Thread({ threadId, afterSequence: 0 }).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ensureLegacyTranscript: () => Effect.void,
        streamStoredEventsFrom: () => Stream.empty,
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
    );
    assert.deepEqual(
      Array.from(items).map((item) => item.kind === "event" && item.event.type),
      ["thread.deleted"],
    );
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);
