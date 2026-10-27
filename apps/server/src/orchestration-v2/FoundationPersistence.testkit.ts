import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
export const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
export const layerEffectOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
export const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
  Layer.provide(layerDatabase),
);
export const layerIsolatedOutbox = Layer.fresh(
  EffectOutbox.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);
export const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerEffectOutboxProvided,
  layerCommandReceiptStoreProvided,
  IdAllocator.layer,
  layerProjectionMaintenanceProvided,
);

export const providerInstanceId = ProviderInstanceId.make("codex");
export const providerDriver = ProviderDriverKind.make("codex");
export const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

export function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

export const seedCompaction = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_legacy_imports (
    thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
  ) VALUES ('imported', '2026-10-17', '2026-10-17', '2026-10-17', 0)`;
  yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 151
  ) INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type,
    occurred_at, actor_kind, payload_json, metadata_json, application_event_version
  ) SELECT 'event-' || n, 'thread', 'thread', n,
    CASE WHEN n IN (1, 51, 101) THEN 'message.updated' ELSE 'thread.visited' END,
    '2026-10-17', 'server', '{"id":"message"}', '{}', 2 FROM history`;
  yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 100
  ) INSERT INTO orchestration_command_receipts (
    rowid, command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
  ) SELECT n * 2, 'command-' || n, 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy' FROM history`;
});
