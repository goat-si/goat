import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import migration from "../persistence/Migrations/078_Memory.ts";
import hubMigration from "../persistence/Migrations/079_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/082_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/083_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/095_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/084_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/085_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/086_MemoryRevertResults.ts";
import threadIndexMigration from "../persistence/Migrations/097_MemorySummaryWorkThreadIndex.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Worker from "./MemoryWorker.ts";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const environmentId = M.EnvironmentId.make("fixture");
export const space = M.MemorySpaceId.make(id(1));
export const memoryId = M.MemoryId.make(id(2));
export const threadId = M.ThreadId.make("thread");
// Memory falls back from disabled instances, so the fixture runs on a default-enabled one.
export const selection = { instanceId: M.ProviderInstanceId.make("codex"), model: "fixture" };
export const now = "2026-10-14T00:00:00.000Z";
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migration;
    yield* hubMigration;
    yield* lineageMigration;
    yield* checkpointMigration;
    yield* revisionSizeMigration;
    yield* reportMigration;
    yield* usageMigration;
    yield* revertMigration;
    yield* threadIndexMigration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storage = Store.layer.pipe(Layer.provideMerge(setup));
const quota = Quota.layer.pipe(Layer.provideMerge(storage));
const service = Service.layer.pipe(
  Layer.provideMerge(quota),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
const maintenance = Maintenance.layer.pipe(Layer.provideMerge(quota));
export const live = (
  // A function decides per call: a detail string fails with it, undefined succeeds.
  failure: boolean | (() => string | M.TextGenerationError | undefined) = false,
  onInput?: (input: M.GenerateMemorySummaryInput) => void,
  local = false,
  elapsedPerCallMs = 0,
  unconfigured = false,
  // Inputs the model answers with nothing durable.
  empty?: (input: M.GenerateMemorySummaryInput) => boolean,
  // Promotion candidates answered for a promote request.
  promotions?: (
    input: M.GenerateMemorySummaryInput,
  ) => NonNullable<M.GenerateMemorySummaryOutcome["promotions"]>,
) =>
  Worker.layer.pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(maintenance),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(
      Settings.layerTest(
        {
          memoryEnabled: !unconfigured,
          memoryModelSelection: selection,
          memoryHub: local ? { mode: "disabled" } : { mode: "hub", memorySpaceId: space },
        },
        "memoryHub",
      ),
    ),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "worker" })),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: (input) => {
          onInput?.(input);
          const detail =
            typeof failure === "function" ? failure() : failure ? "synthetic failure" : undefined;
          const result =
            detail !== undefined
              ? Effect.fail(
                  typeof detail === "string"
                    ? new M.TextGenerationError({ operation: "generateMemorySummary", detail })
                    : detail,
                )
              : Effect.succeed({
                  result: empty?.(input)
                    ? null
                    : {
                        text: [
                          input.previousSummary?.text,
                          ...input.messages.map((message) => message.messageId),
                        ]
                          .filter(Boolean)
                          .join(" "),
                        assertionKind: "inference" as const,
                        evidence: [
                          ...(input.previousSummary?.evidence ?? []),
                          {
                            origin: "thread" as const,
                            sourceThread: input.sourceThread,
                            watermark: input.sourceWatermark,
                            messageIds: input.messages.map((m) => m.messageId),
                          },
                        ],
                      },
                  execution: {
                    requestedModelSelection: input.modelSelection,
                    effectiveModel: "fixture",
                    effectiveProvider: M.ProviderDriverKind.make("codex"),
                    providerInstanceId: selection.instanceId,
                    environmentId,
                  },
                  ...(input.promote && promotions ? { promotions: promotions(input) } : {}),
                });
          return elapsedPerCallMs
            ? TestClock.adjust(elapsedPerCallMs).pipe(Effect.andThen(result))
            : result;
        },
      }),
    ),
  );
export const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
export const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
export const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
export const decodeRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2RunJson),
);
export const encodeRun = Schema.encodeSync(Schema.fromJsonString(M.OrchestrationV2RunJson));
export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId},NULL)`;
  const message = M.OrchestrationV2ConversationMessageJson.make({
    id: M.MessageId.make("message"),
    threadId,
    runId: M.RunId.make("run"),
    nodeId: null,
    createdBy: "user",
    creationSource: "web",
    role: "user",
    text: "synthetic committed statement",
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(now),
    updatedAt: DateTime.makeUnsafe(now),
  });
  const run = M.OrchestrationV2RunJson.make({
    id: M.RunId.make("run"),
    threadId,
    ordinal: 1,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    providerThreadId: null,
    userMessageId: message.id,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: DateTime.makeUnsafe(now),
    startedAt: DateTime.makeUnsafe(now),
    completedAt: DateTime.makeUnsafe(now),
    checkpointId: null,
    contextHandoffId: null,
  });
  yield* sql`INSERT INTO orchestration_events VALUES (1,${id(10)},${threadId},'message.updated',${encodeMessage(message)},${now},2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(11)},${threadId},'run.updated',${encodeRun(run)},${now},2,'thread')`;
});

/** Fixture rows the setup just wrote; a missing one is a broken fixture. */
const required = <A>(value: A | null | undefined): A => {
  if (value === null || value === undefined) throw new Error("fixture value missing");
  return value;
};
export const work = (kind: Store.MemoryWork["kind"] = "summary"): Store.MemoryWork => ({
  id: "work",
  space,
  memoryId,
  kind,
  status: "running",
  attempt: 1,
  nextAttemptAt: 0,
  claimedBy: "worker",
  claimedUntil: Number.MAX_SAFE_INTEGER,
  payloadRef: null,
  metadata: {
    kind: "summary",
    sourceThread: { environmentId, threadId },
    sourceWatermark: {
      fromEventId: M.EventId.make(id(10)),
      toEventId: M.EventId.make(id(11)),
      throughSequence: 2,
    },
    memoryId,
    operationId: M.MemoryOperationId.make(id(4)),
    revisionId: M.MemoryRevisionId.make(id(5)),
    modelSelection: selection,
  },
});
// Build canonical lineage through the real Worker/Service/Store, with synthetic content only.
export const seedDerivedSummary = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  yield* seed;
  const worker = yield* Worker.MemoryWorker;
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  yield* worker.sweepDue();
  const target = M.MemoryId.make(Service.memoryStableUuid(`${environmentId}:${threadId}:summary`));
  const current = yield* store.loadAggregate(space, target);
  const first = required(current.revisions.find((p) => p.revision.revisionId === current.heads[0]));
  yield* service.upsert(
    {
      memorySpaceId: space,
      memoryId,
      operationId: M.MemoryOperationId.make(id(8100)),
      expectedHeads: [],
      scope: { kind: "user" },
      assertionKind: "inference",
      payload: { text: "synthetic source A", evidence: [], derivedFromMemoryRevisions: [] },
      baseBoundary: null,
    },
    Effect.void,
  );
  const rA = required((yield* store.loadAggregate(space, memoryId)).heads[0]);
  yield* service.upsert(
    {
      memorySpaceId: space,
      memoryId: target,
      operationId: M.MemoryOperationId.make(id(8101)),
      expectedHeads: current.heads,
      scope: first.revision.scope,
      assertionKind: "inference",
      payload: {
        ...required(first.payload),
        text: "synthetic derived A",
        derivedFromMemoryRevisions: [rA],
      },
      baseBoundary: null,
    },
    Effect.void,
  );
  return { target, rA, d0: required((yield* store.loadAggregate(space, target)).heads[0]) };
});
export const incrementalSummary = (target: M.MemoryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const worker = yield* Worker.MemoryWorker;
    const original = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0];
    const message = yield* decodeMessage(required(original).payload_json);
    // Force two generation calls in the same claim, covering the in-memory carry too.
    for (let index = 3; index <= 103; index++)
      yield* sql`INSERT INTO orchestration_events VALUES (${index},${id(8200 + index)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`increment-${index}`), runId: null })},${now},2,'thread')`;
    const queued: Store.MemoryWork = {
      ...work(),
      id: "lineage-increment",
      memoryId: target,
      status: "pending",
      claimedBy: null,
      claimedUntil: null,
      metadata: {
        ...(work().metadata as Extract<Store.MemoryWork["metadata"], { kind: "summary" }>),
        memoryId: target,
        operationId: M.MemoryOperationId.make(id(8102)),
        revisionId: M.MemoryRevisionId.make(id(8103)),
        fromSequence: 2,
        sourceWatermark: {
          fromEventId: M.EventId.make(id(8203)),
          toEventId: M.EventId.make(id(8303)),
          throughSequence: 103,
        },
      },
    };
    yield* store.enqueueWork(queued);
    yield* store.claimWork(queued.id, "worker", Date.parse(now), Number.MAX_SAFE_INTEGER);
    yield* worker.execute(required(yield* store.readWork(queued.id)));
    return yield* store.loadAggregate(space, target);
  });
// Summary A covers a run that is then rolled back, and run B adds 101 messages. The next
// summary must drop A and regenerate from the start: two bounded chunks in one work item.
export const seedRolledBackRegeneration = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  const worker = yield* Worker.MemoryWorker;
  const earlyMessageRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0];
  const earlyMessage = yield* decodeMessage(required(earlyMessageRow).payload_json);
  yield* sql`UPDATE orchestration_events SET sequence=3 WHERE sequence=2`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(1299)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make("survivor"), runId: null })},${now},2,'thread')`;
  yield* worker.sweepDue();
  const runRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=3`)[0];
  const run = yield* decodeRun(required(runRow).payload_json);
  yield* sql`INSERT INTO orchestration_events VALUES (4,${id(1300)},${threadId},'run.updated',${encodeRun({ ...run, status: "rolled_back" })},${now},2,'thread')`;
  const nextRunId = M.RunId.make("run-b");
  for (let index = 0; index < 101; index++) {
    yield* sql`INSERT INTO orchestration_events VALUES (${index + 5},${id(1400 + index)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make(`run-b-${index}`), runId: nextRunId })},${now},2,'thread')`;
  }
  yield* sql`INSERT INTO orchestration_events VALUES (106,${id(1600)},${threadId},'run.updated',${encodeRun({ ...run, id: nextRunId, userMessageId: M.MessageId.make("run-b-0"), status: "completed" })},${now},2,'thread')`;
});
