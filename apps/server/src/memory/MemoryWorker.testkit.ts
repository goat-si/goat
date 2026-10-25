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
import * as Tracer from "effect/Tracer";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import threadIndexMigration from "../persistence/Migrations/096_MemorySummaryWorkThreadIndex.ts";
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
                  result: {
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
// Counts finished spans by name, so a test can tell repeated work from settled work.
export const countingTracer = (counts: Map<string, number>) =>
  Tracer.make({
    span: (options) => {
      counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
      return new Tracer.NativeSpan(options);
    },
  });
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
