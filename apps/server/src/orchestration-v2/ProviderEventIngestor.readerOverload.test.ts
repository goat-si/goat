import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import type * as NodeWorkerThreads from "node:worker_threads";
import { vi } from "vite-plus/test";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import { withWriterFallback } from "./readerOverloadFallback.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const workers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
function threadCreatedEvent(
  now: DateTime.Utc,
): Effect.Effect<
  Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
  IdAllocator.IdAllocatorV2Error,
  IdAllocator.IdAllocatorV2
> {
  return Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectId = yield* idAllocator.allocate.project({
      fixtureName: "provider-event-ingestor",
    });
    const threadId = yield* idAllocator.allocate.thread({
      fixtureName: "provider-event-ingestor",
      projectId,
    });
    const providerThreadId = idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Provider event ingestor",
      providerInstanceId: modelSelection.instanceId,
      modelSelection: modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: providerThreadId,
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

    return {
      id: yield* idAllocator.allocate.event({ threadId }),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    };
  });
}

const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ingestor-overload-" })),
  Layer.provideMerge(NodeServices.layer),
);
const instances = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
  getInstance: () => Effect.succeed(undefined),
});

const testDatabase = (filename: string, writerWorker: boolean) =>
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* runMigrations();
      }),
    ),
    NodeSqliteClient.layer({ filename, readerWorker: true, writerWorker }),
  );
const layerFor = (filename: string, writerWorker: boolean) => {
  const database = testDatabase(filename, writerWorker);
  const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
  const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, database)));
  return Layer.mergeAll(
    database,
    stores,
    sink,
    IdAllocator.layer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          instances,
          stores,
          sink,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          git,
        ),
      ),
    ),
  );
};

/** Starts every reader slot, then holds 64 admissions so the next reader read is rejected. */
const saturateReaders = (nonReaders: ReadonlySet<NodeWorkerThreads.Worker>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const warmRelease = yield* Deferred.make<void>();
    const warmEntered = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>());
    const warm = [];
    for (const entered of warmEntered)
      warm.push(
        yield* Effect.forkChild(
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1`;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(warmRelease);
              }),
            )
            .pipe(NodeSqliteClient.readOnly),
          { startImmediately: true },
        ),
      );
    for (const entered of warmEntered) yield* Deferred.await(entered);
    yield* Deferred.succeed(warmRelease, undefined);
    for (const fiber of warm) yield* Fiber.join(fiber);
    const readers = workers.filter((worker) => !nonReaders.has(worker));
    assert.lengthOf(readers, 4);
    const sent = yield* Deferred.make<void>();
    const held = readers.map((reader) =>
      vi.spyOn(reader, "postMessage").mockImplementation(() => {
        Deferred.doneUnsafe(sent, Effect.void);
      }),
    );
    const reads = [];
    for (let index = 0; index < 64; index++)
      reads.push(
        yield* Effect.forkChild(sql`SELECT 1`.pipe(NodeSqliteClient.readOnly), {
          startImmediately: true,
        }),
      );
    yield* Deferred.await(sent);
    return { held, reads };
  });

it.effect.each([false, true])(
  "deduplicates under reader saturation with writerWorker=%s",
  (writerWorker) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ingestor-overload-" });
      yield* Effect.gen(function* () {
        // Workers that exist before the first read are not reader slots.
        const nonReaders = new Set(workers);
        const now = yield* DateTime.now;
        const sql = yield* SqlClient.SqlClient;
        const eventSink = yield* EventSink.EventSinkV2;
        const events = yield* EventStore.EventStoreV2;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const allocator = yield* IdAllocator.IdAllocatorV2;
        const thread = yield* threadCreatedEvent(now);
        yield* eventSink.write({ events: [thread] });
        const threadId = thread.threadId;
        const providerSessionId = yield* allocator.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        const nodeId = NodeId.make(`${threadId}:approval`);
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        };
        const input = {
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId,
          event: { type: "node.updated" as const, driver: CODEX_DRIVER, node },
        };
        assert.lengthOf(yield* ingestor.ingestNormalized(input), 1);
        const sequence = yield* events.latestSequence({ threadId });
        const beforeRow = yield* sql<{
          updated_at: string;
        }>`SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        yield* TestClock.adjust("5 seconds");
        const { held, reads } = yield* saturateReaders(nonReaders);
        using _held = {
          [Symbol.dispose]: () => {
            for (const spy of held) spy.mockRestore();
          },
        };
        assert.isTrue(yield* projection.isNodeStored(node));
        assert.isFalse(
          yield* projection.isNodeStored({ ...node, status: "completed", completedAt: now }),
        );
        assert.isEmpty(yield* ingestor.ingestNormalized(input));
        assert.equal(yield* sql.withTransaction(events.latestSequence({ threadId })), sequence);
        const unchangedRow = yield* sql<{
          updated_at: string;
        }>`SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        assert.equal(unchangedRow[0]?.updated_at, beforeRow[0]?.updated_at);
        const changedNode = { ...node, status: "completed" as const, completedAt: now };
        const changed = yield* ingestor.ingestNormalized({
          ...input,
          event: { ...input.event, node: changedNode },
        });
        assert.deepEqual(
          changed.map((stored) => stored.event.type),
          ["node.updated"],
        );
        assert.isTrue(yield* projection.isNodeStored(changedNode));
        assert.equal(yield* sql.withTransaction(events.latestSequence({ threadId })), sequence + 1);
        const originalPredicate = NodeSqliteClient.isReaderAdmissionOverload;
        const fallbackReached = yield* Deferred.make<void>();
        using predicate = vi
          .spyOn(NodeSqliteClient, "isReaderAdmissionOverload")
          .mockImplementation((error) => {
            const overloaded = originalPredicate(error);
            if (overloaded) Deferred.doneUnsafe(fallbackReached, Effect.void);
            return overloaded;
          });
        assert.isTrue(yield* sql.withTransaction(projection.isNodeStored(changedNode)));
        assert.equal(predicate.mock.calls.length, 0);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const transaction = yield* Effect.forkChild(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          ),
        );
        yield* Deferred.await(entered);
        const waiting = yield* Effect.forkChild(projection.isNodeStored(node), {
          startImmediately: true,
        });
        yield* Deferred.await(fallbackReached);
        assert.isUndefined(waiting.pollUnsafe());
        yield* Fiber.interrupt(waiting);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(transaction);
        const lastRead = reads.pop()!;
        yield* Fiber.interrupt(lastRead);
        const replacement = yield* Effect.forkChild(sql`SELECT 1`.pipe(NodeSqliteClient.readOnly), {
          startImmediately: true,
        });
        assert.isUndefined(replacement.pollUnsafe());
        const overflow = yield* sql`SELECT 1`.pipe(NodeSqliteClient.readOnly, Effect.flip);
        assert.isTrue(NodeSqliteClient.isReaderAdmissionOverload(overflow));
        reads.push(replacement);
        yield* sql`CREATE TABLE writer_after_interrupt (value INTEGER)`;
        yield* sql`DROP TABLE orchestration_v2_projection_nodes`;
        const writerFailure = yield* projection.isNodeStored(node).pipe(Effect.flip);
        assert.equal(writerFailure._tag, "ProjectionStoreReadError");
        assert.isFalse(NodeSqliteClient.isReaderAdmissionOverload(writerFailure));
        for (const spy of held) spy.mockRestore();
        for (const read of reads) yield* Fiber.interrupt(read);
        assert.equal(yield* events.latestSequence({ threadId }), sequence + 1);
        const unrelated = yield* projection.isNodeStored(node).pipe(Effect.flip);
        assert.equal(unrelated._tag, "ProjectionStoreReadError");
        assert.isFalse(NodeSqliteClient.isReaderAdmissionOverload(unrelated));
        const normalizeError = yield* ingestor.normalize(input).pipe(Effect.flip);
        assert.equal(normalizeError._tag, "ProviderEventNormalizeError");
      }).pipe(Effect.provide(layerFor(path.join(directory, "state.sqlite"), writerWorker)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
type IngestEvent = ProviderEventIngestor.ProviderEventIngestInput["event"];
interface Saturated {
  readonly now: DateTime.Utc;
  readonly thread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderEventIngestor.ProviderEventIngestInput["providerSessionId"];
  readonly providerThreadId: OrchestrationV2AppThread["activeProviderThreadId"] & {};
  readonly projection: ProjectionStore.ProjectionStoreV2Shape;
  readonly ingest: (
    event: IngestEvent,
  ) => ReturnType<ProviderEventIngestor.ProviderEventIngestorV2Shape["ingestNormalized"]>;
}

/** Runs `body` while every reader slot is busy and all 64 admissions are queued. */
const withSaturatedReaders = <A, E>(body: (saturated: Saturated) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ingestor-overload-" });
    return yield* Effect.gen(function* () {
      const nonReaders = new Set(workers);
      const now = yield* DateTime.now;
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const created = yield* threadCreatedEvent(now);
      yield* eventSink.write({ events: [created] });
      const threadId = created.threadId;
      const providerSessionId = yield* allocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId,
      });
      const { held, reads } = yield* saturateReaders(nonReaders);
      using _held = {
        [Symbol.dispose]: () => {
          for (const spy of held) spy.mockRestore();
        },
      };
      const overflow = yield* sql`SELECT 1`.pipe(NodeSqliteClient.readOnly, Effect.flip);
      assert.isTrue(NodeSqliteClient.isReaderAdmissionOverload(overflow));
      const result = yield* body({
        now,
        thread: created.payload,
        providerSessionId,
        providerThreadId: allocator.derive.providerThread({
          driver: CODEX_DRIVER,
          nativeThreadId: "native-thread",
        }),
        projection,
        ingest: (event) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId: modelSelection.instanceId,
            threadId,
            event,
          }),
      });
      for (const spy of held) spy.mockRestore();
      for (const read of reads) yield* Fiber.interrupt(read);
      return result;
    }).pipe(Effect.provide(layerFor(path.join(directory, "state.sqlite"), false)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const ingestionReads: ReadonlyArray<{
  readonly name: string;
  readonly event: (saturated: Saturated) => IngestEvent;
  readonly stored: ReadonlyArray<string>;
}> = [
  {
    name: "plan.updated reading the previous plan",
    event: ({ thread }) => ({
      type: "plan.updated",
      driver: CODEX_DRIVER,
      plan: {
        id: PlanId.make(`${thread.id}:plan`),
        threadId: thread.id,
        runId: null,
        nodeId: NodeId.make(`${thread.id}:plan-node`),
        status: "active",
        kind: "todo_list",
        steps: [{ id: "1", text: "Ingest under overload", status: "running" }],
      },
    }),
    stored: ["plan.updated"],
  },
  {
    name: "turn_item.updated reading the stored screen row",
    event: ({ thread, now }) => ({
      type: "turn_item.updated",
      driver: CODEX_DRIVER,
      turnItem: {
        id: TurnItemId.make(`${thread.id}:screen-row`),
        type: "dynamic_tool",
        threadId: thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "goat screen run",
        toolName: "goat.goat_screen_run",
        input: { code: "..." },
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    }),
    stored: ["turn-item.updated"],
  },
  {
    name: "turn.terminal reading pending native user inputs",
    event: ({ providerThreadId }) => ({
      type: "turn.terminal",
      driver: CODEX_DRIVER,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:overload"),
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    }),
    stored: [],
  },
  {
    name: "app_thread.created reading the existing thread",
    event: ({ thread }) => ({
      type: "app_thread.created",
      driver: CODEX_DRIVER,
      appThread: { ...thread, title: "Renamed under overload" },
    }),
    stored: ["thread.metadata-updated"],
  },
  {
    name: "provider_thread.updated reading rewound thread records",
    event: ({ thread, now, providerSessionId, providerThreadId }) => ({
      type: "provider_thread.updated",
      driver: CODEX_DRIVER,
      providerThread: {
        id: providerThreadId,
        driver: CODEX_DRIVER,
        providerInstanceId: modelSelection.instanceId,
        providerSessionId,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: { driver: CODEX_DRIVER, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
      retainedNativeTurnIds: [],
    }),
    stored: ["provider-thread.updated"],
  },
];

it.effect.each(ingestionReads)("ingests $name while reader admission is saturated", (read) =>
  withSaturatedReaders((saturated) =>
    Effect.gen(function* () {
      const stored = yield* saturated.ingest(read.event(saturated));
      assert.deepEqual(
        stored.map((event) => event.event.type),
        read.stored,
      );
    }),
  ),
);

it.effect("fails reads outside provider ingestion fast while reader admission is saturated", () =>
  withSaturatedReaders(({ thread, projection }) =>
    Effect.gen(function* () {
      const failure = yield* projection.getThread(thread.id).pipe(Effect.flip);
      assert.isTrue(NodeSqliteClient.isReaderAdmissionOverload(failure));
    }),
  ),
);

it.effect("reruns an ingestion read on the writer inside an enclosing readOnly", () =>
  withSaturatedReaders(({ thread, projection }) =>
    Effect.gen(function* () {
      const read = yield* withWriterFallback(projection.getThread(thread.id)).pipe(
        NodeSqliteClient.readOnly,
      );
      assert.equal(read.id, thread.id);
    }),
  ),
);
