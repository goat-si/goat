import { assert, describe, it } from "@effect/vitest";
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
import { decideMemoryOperation } from "./MemoryDecider.ts";
import * as Service from "./MemoryService.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Worker from "./MemoryWorker.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as Hold from "./MemoryGenerationHold.ts";
import * as Snapshot from "./MemorySnapshot.ts";
import { threadProvenanceCases } from "./threadProvenance.testkit.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = M.EnvironmentId.make("fixture");
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const threadId = M.ThreadId.make("thread");
// Memory falls back from disabled instances, so the fixture runs on a default-enabled one.
const selection = { instanceId: M.ProviderInstanceId.make("codex"), model: "fixture" };
const now = "2026-10-14T00:00:00.000Z";
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
const live = (
  // A function decides per call: a detail string fails with it, undefined succeeds.
  failure: boolean | (() => string | M.TextGenerationError | undefined) = false,
  onInput?: (input: M.GenerateMemorySummaryInput) => void,
  local = false,
  elapsedPerCallMs = 0,
  unconfigured = false,
  textOf?: (input: M.GenerateMemorySummaryInput) => string,
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
                    text:
                      textOf?.(input) ??
                      [
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
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(M.OrchestrationV2RunJson));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(M.OrchestrationV2RunJson));
// Counts finished spans by name, so a test can tell repeated work from settled work.
const countingTracer = (counts: Map<string, number>) =>
  Tracer.make({
    span: (options) => {
      counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
      return new Tracer.NativeSpan(options);
    },
  });
const seed = Effect.gen(function* () {
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
const work = (kind: Store.MemoryWork["kind"] = "summary"): Store.MemoryWork => ({
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
const seedDerivedSummary = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  yield* seed;
  const worker = yield* Worker.MemoryWorker;
  const service = yield* Service.MemoryService;
  const store = yield* Store.MemoryStore;
  yield* worker.sweepDue();
  const target = M.MemoryId.make(Service.memoryStableUuid(`${environmentId}:${threadId}:summary`));
  const current = yield* store.loadAggregate(space, target);
  const first = current.revisions.find((p) => p.revision.revisionId === current.heads[0])!;
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
  const rA = (yield* store.loadAggregate(space, memoryId)).heads[0]!;
  yield* service.upsert(
    {
      memorySpaceId: space,
      memoryId: target,
      operationId: M.MemoryOperationId.make(id(8101)),
      expectedHeads: current.heads,
      scope: first.revision.scope,
      assertionKind: "inference",
      payload: { ...first.payload!, text: "synthetic derived A", derivedFromMemoryRevisions: [rA] },
      baseBoundary: null,
    },
    Effect.void,
  );
  return { target, rA, d0: (yield* store.loadAggregate(space, target)).heads[0]! };
});
const incrementalSummary = (target: M.MemoryId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const worker = yield* Worker.MemoryWorker;
    const original = (yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
    const message = yield* decodeMessage(original.payload_json);
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
    yield* worker.execute((yield* store.readWork(queued.id))!);
    return yield* store.loadAggregate(space, target);
  });
// Summary A covers a run that is then rolled back, and run B adds 101 messages. The next
// summary must drop A and regenerate from the start: two bounded chunks in one work item.
const seedRolledBackRegeneration = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  const worker = yield* Worker.MemoryWorker;
  const earlyMessageRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
  const earlyMessage = yield* decodeMessage(earlyMessageRow.payload_json);
  yield* sql`UPDATE orchestration_events SET sequence=3 WHERE sequence=2`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(1299)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make("survivor"), runId: null })},${now},2,'thread')`;
  yield* worker.sweepDue();
  const runRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=3`)[0]!;
  const run = yield* decodeRun(runRow.payload_json);
  yield* sql`INSERT INTO orchestration_events VALUES (4,${id(1300)},${threadId},'run.updated',${encodeRun({ ...run, status: "rolled_back" })},${now},2,'thread')`;
  const nextRunId = M.RunId.make("run-b");
  for (let index = 0; index < 101; index++) {
    yield* sql`INSERT INTO orchestration_events VALUES (${index + 5},${id(1400 + index)},${threadId},'message.updated',${encodeMessage({ ...earlyMessage, id: M.MessageId.make(`run-b-${index}`), runId: nextRunId })},${now},2,'thread')`;
  }
  yield* sql`INSERT INTO orchestration_events VALUES (106,${id(1600)},${threadId},'run.updated',${encodeRun({ ...run, id: nextRunId, userMessageId: M.MessageId.make("run-b-0"), status: "completed" })},${now},2,'thread')`;
});
describe("MemoryWorker", () => {
  it.effect.each([false, true])(
    "stores a generated summary with GOAT credentials redacted (local=%s, #1297)",
    (local) => {
      // A synthetic canary shaped like a registry token; not a real credential.
      const secret = "canarySummaryToken".padEnd(43, "0");
      return Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        yield* (yield* Worker.MemoryWorker).sweepDue();
        const target = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const stored = local
          ? yield* store.readLocalSummaryPayload(
              environmentId,
              `${environmentId}:${threadId}:summary`,
            )
          : (yield* store.loadAggregate(space, target)).revisions[0]?.payload;
        assert.include(stored?.text, "GOAT_MCP_BEARER_TOKEN=[redacted]");
        assert.notInclude(stored?.text, secret);
      }).pipe(
        Effect.provide(
          live(
            false,
            undefined,
            local,
            0,
            false,
            () => `deploys with GOAT_MCP_BEARER_TOKEN=${secret}`,
          ),
        ),
      );
    },
  );
  it.effect("started idle worker drains without waking itself", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        yield* worker.start();
        yield* worker.drain;
        yield* store.loadAggregate(space, memoryId);
        yield* store.recoverDeferred(1, 0);
        yield* worker.drain;
        assert.deepStrictEqual(yield* store.dueWork(0, 100), []);
      }),
    ).pipe(Effect.provide(live())),
  );
  it("stores the bounded retry sequence without sleeping", () => {
    assert.deepStrictEqual(
      [1, 2, 3, 4, 20].map(Worker.memoryRetryDelay),
      [5000, 30000, 120000, 600000, 600000],
    );
  });
  it.effect.each(["claim", "resolve", "revert_intent"] as const)(
    "refuses generic %s execution",
    (kind) =>
      Effect.gen(function* () {
        const worker = yield* Worker.MemoryWorker;
        assert.strictEqual(
          (yield* worker.execute(work(kind)).pipe(Effect.flip)).code,
          "unsupported_operation",
        );
      }).pipe(Effect.provide(live())),
  );
  it.effect("refuses a foreign runtime owner", () =>
    Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      assert.strictEqual(
        (yield* worker.execute({ ...work(), claimedBy: "foreign" }).pipe(Effect.flip)).code,
        "attempt_expired",
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("resumes skipped summaries after turning memory on without a new event", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      assert.strictEqual(yield* store.readThreadHookWatermark(), 2);
      assert.strictEqual((yield* store.dueWork(0, 100)).length, 0);
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ memoryEnabled: true });
      yield* worker.sweepDue();
      const page = yield* store.list({
        memorySpaceId: space,
        scope: { kind: "thread", thread: { environmentId, threadId } },
        limit: 20,
      });
      assert.strictEqual(page.length, 1);
      assert.strictEqual(page[0]!.status, "active");
    }).pipe(Effect.provide(live(false, undefined, false, 0, true))),
  );
  it.effect("still cancels deleted thread work while memory is off", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({
        ...work(),
        status: "pending",
        claimedBy: null,
        claimedUntil: null,
      });
      yield* sql`INSERT INTO orchestration_events VALUES (3,${id(12)},${threadId},'thread.deleted','{}',${now},2,'thread')`;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      assert.strictEqual((yield* store.readWork("work"))?.status, "cancelled");
      assert.strictEqual(yield* store.readThreadHookWatermark(), 3);
      assert.isNotNull((yield* store.ftsState(environmentId)).measuredAt);
    }).pipe(Effect.provide(live(false, undefined, false, 0, true))),
  );
  it.effect("moves queued work off an unusable model onto the memory model", () => {
    const inputs: M.GenerateMemorySummaryInput[] = [];
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const stuck = work();
      yield* store.enqueueWork({
        ...stuck,
        status: "retry",
        claimedBy: null,
        claimedUntil: null,
        metadata: {
          ...(stuck.metadata as Extract<Store.MemoryWork["metadata"], { kind: "summary" }>),
          modelSelection: { instanceId: selection.instanceId, model: "unsupported-thread-model" },
        },
      });
      const worker = yield* Worker.MemoryWorker;
      yield* store.claimWork("work", "worker", Date.parse(now), Number.MAX_SAFE_INTEGER);
      yield* worker.execute((yield* store.readWork("work"))!);
      const done = yield* store.readWork("work");
      assert.strictEqual(done?.status, "completed");
      assert.deepStrictEqual(
        done?.metadata.kind === "summary" ? done.metadata.modelSelection : null,
        selection,
      );
      assert.isAbove(inputs.length, 0);
      assert.isTrue(inputs.every((input) => input.modelSelection.model === selection.model));
    }).pipe(Effect.provide(live(false, (input) => inputs.push(input))));
  });
  it.effect("keeps queued summaries while memory is off and resumes when it is on", () => {
    const inputs: M.GenerateMemorySummaryInput[] = [];
    return Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({
        ...work(),
        status: "pending",
        claimedBy: null,
        claimedUntil: null,
      });
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      assert.strictEqual((yield* store.readWork("work"))?.status, "pending");
      assert.strictEqual(inputs.length, 0);
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ memoryEnabled: true });
      yield* worker.sweepDue();
      assert.strictEqual((yield* store.readWork("work"))?.status, "completed");
    }).pipe(Effect.provide(live(false, (input) => inputs.push(input), false, 0, true)));
  });
  it.effect("inherits summary lineage across incremental generation chunks", () => {
    const inputs: M.GenerateMemorySummaryInput[] = [];
    return Effect.gen(function* () {
      const { target, rA, d0 } = yield* seedDerivedSummary;
      const aggregate = yield* incrementalSummary(target);
      assert.strictEqual(inputs.length, 3);
      assert.deepStrictEqual(inputs[1]!.previousSummary!.derivedFromMemoryRevisions, [rA]);
      assert.deepStrictEqual(inputs[2]!.previousSummary!.derivedFromMemoryRevisions, [rA]);
      assert.notStrictEqual(aggregate.heads[0], d0);
      assert.deepStrictEqual(
        aggregate.revisions.find((p) => p.revision.revisionId === aggregate.heads[0])!.payload!
          .derivedFromMemoryRevisions,
        [rA],
      );
    }).pipe(Effect.provide(live(false, (input) => inputs.push(input))));
  });
  it.effect("forgets derived summaries after retention removes the previous payload", () =>
    Effect.gen(function* () {
      const { target, rA, d0 } = yield* seedDerivedSummary;
      const aggregate = yield* incrementalSummary(target);
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const unrelated = M.MemoryId.make(id(8104));
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId: unrelated,
          operationId: M.MemoryOperationId.make(id(8105)),
          expectedHeads: [],
          scope: { kind: "thread", thread: { environmentId, threadId } },
          assertionKind: "inference",
          payload: {
            text: "unrelated synthetic summary",
            evidence: [],
            derivedFromMemoryRevisions: [],
          },
          baseBoundary: null,
        },
        Effect.void,
      );
      // Model an acknowledged, published retention boundary; deletion itself uses production Store.
      yield* sql`UPDATE memory_events SET receipt_json=json_set(receipt_json,'$.hubSequence',1) WHERE operation_id=${M.MemoryOperationId.make(id(8101))}`;
      yield* sql`UPDATE memory_outbox SET status='completed' WHERE space=${space} AND payload_ref=${d0}`;
      yield* sql`UPDATE memory_payloads SET purge_eligible_after=0 WHERE space=${space} AND payload_ref=${d0}`;
      yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1) ON CONFLICT(space) DO UPDATE SET published=1`;
      assert.strictEqual(yield* store.prunePayloads(Date.parse(now), 100), 1);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${d0}`).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${aggregate.heads[0]!}`).length,
        1,
      );
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(8106)),
          expectedHeads: [rA],
        },
        Effect.void,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${target}`).length,
        0,
      );
      const page = yield* store.list({
        memorySpaceId: space,
        scope: { kind: "thread", thread: { environmentId, threadId } },
        limit: 20,
      });
      assert.strictEqual(page.find((item) => item.memoryId === target)!.status, "blocked");
      assert.strictEqual(page.find((item) => item.memoryId === unrelated)!.status, "active");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${unrelated}`).length,
        1,
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("rejects a dependency invalidated inside the summary commit transaction", () =>
    Effect.gen(function* () {
      const { target, d0 } = yield* seedDerivedSummary;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const current = yield* store.loadAggregate(space, target);
      const previousSummary = current.revisions.find((p) => p.revision.revisionId === d0)!.payload!;
      const template = work();
      if (template.metadata.kind !== "summary") throw new Error("Expected summary work");
      const queued = {
        ...template,
        id: "commit-fence",
        memoryId: target,
        metadata: { ...template.metadata, memoryId: target },
      };
      yield* store.enqueueWork(queued);
      const input: M.GenerateMemorySummaryInput = {
        cwd: "/tmp/synthetic-memory-generation",
        sourceThread: template.metadata.sourceThread,
        sourceWatermark: template.metadata.sourceWatermark,
        messages: [
          { messageId: M.MessageId.make("message"), text: "synthetic statement", completed: true },
        ],
        previousSummary,
        modelSelection: selection,
      };
      const failure = yield* service
        .commitSummary({
          work: queued,
          expectedHeads: [d0],
          input,
          generated: {
            result: {
              text: "synthetic newly generated summary",
              assertionKind: "inference",
              evidence: previousSummary.evidence,
            },
            execution: {
              environmentId,
              providerInstanceId: selection.instanceId,
              requestedModelSelection: selection,
              effectiveProvider: M.ProviderDriverKind.make("codex"),
              effectiveModel: "fixture",
            },
          },
          recheckSource:
            sql`UPDATE memory_items SET status='forgotten' WHERE space=${space} AND memory_id=${memoryId}`.pipe(
              Effect.orDie,
              Effect.asVoid,
            ),
        })
        .pipe(Effect.flip);
      if (failure._tag !== "MemoryStoreConflict") throw failure;
      assert.strictEqual(failure.code, "source_invalidated");
      assert.deepStrictEqual((yield* store.loadAggregate(space, target)).heads, [d0]);
      assert.isUndefined(yield* store.receipt(space, template.metadata.operationId));
    }).pipe(Effect.provide(live())),
  );
  it.effect.each(["forgotten", "missing", "held"] as const)(
    "does not generate from an invalid summary dependency: %s",
    (invalid) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        const { target, rA, d0 } = yield* seedDerivedSummary;
        const sql = yield* SqlClient.SqlClient;
        // Preserve D's body to exercise pre-generation validation independently of purge.
        if (invalid === "missing") yield* sql`DELETE FROM memory_revisions WHERE revision_id=${rA}`;
        else if (invalid === "held")
          yield* sql`UPDATE memory_items SET availability_json=json_set(availability_json,'$.exposure','held') WHERE memory_id=${memoryId}`;
        else yield* sql`UPDATE memory_items SET status='forgotten' WHERE memory_id=${memoryId}`;
        const aggregate = yield* incrementalSummary(target);
        assert.strictEqual(inputs.length, 1);
        assert.deepStrictEqual(aggregate.heads, [d0]);
        assert.strictEqual(
          (yield* (yield* Store.MemoryStore).readWork("lineage-increment"))!.status,
          "cancelled",
        );
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input))));
    },
  );
  it.effect.each([false, true])(
    "excludes WP4 frames from imported transcript inputs (local=%s)",
    (local) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const row = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
        const message = yield* decodeMessage(row.payload_json);
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeMessage({ ...message, creationSource: "provider", text: "keep before\n<external_goat_memory>synthetic forgotten memory</external_goat_memory>\nkeep after\n<external_goat_memory>unfinished synthetic memory" })} WHERE sequence=1`;
        yield* (yield* Worker.MemoryWorker).sweepDue();
        assert.strictEqual(inputs.length, 1);
        assert.strictEqual(inputs[0]!.messages[0]!.text, "keep before\n\nkeep after");
        assert.deepStrictEqual(
          inputs[0]!.messages.map((m) => m.messageId),
          [message.id],
        );
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local)));
    },
  );
  it.effect("catches up committed termination and emits one stable summary", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      assert.strictEqual(yield* store.readThreadHookWatermark(), 2);
      const page = yield* store.list({
        memorySpaceId: space,
        scope: { kind: "thread", thread: { environmentId, threadId } },
        limit: 20,
      });
      assert.strictEqual(page.length, 1);
      assert.strictEqual(page[0]!.status, "active");
      yield* worker.drain;
      assert.strictEqual(
        (yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        })).length,
        1,
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect(
    "isolates a secret source while normal work, deferred repair and maintenance continue",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const worker = yield* Worker.MemoryWorker;
        const source = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
        const message = yield* decodeMessage(source.payload_json);
        const secret = encodeMessage({ ...message, text: "sk-" + "A".repeat(32) });
        yield* sql`UPDATE orchestration_events SET payload_json=${secret} WHERE sequence=1`;
        const normalThread = M.ThreadId.make("normal-thread");
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${normalThread},NULL)`;
        yield* sql`INSERT INTO orchestration_events VALUES (3,${id(20)},${normalThread},'message.updated',${encodeMessage({ ...message, threadId: normalThread })},${now},2,'thread')`;
        yield* sql`INSERT INTO orchestration_events SELECT 4,${id(21)},${normalThread},event_type,payload_json,occurred_at,application_event_version,aggregate_kind FROM orchestration_events WHERE sequence=2`;
        yield* worker.sweepDue();
        assert.strictEqual(yield* store.readThreadHookWatermark(), 4);
        const reports = yield* store.pendingReports(100);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0]!.failureCode, "secret_detected");
        const normalId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${normalThread}:summary`),
        );
        assert.strictEqual((yield* store.loadAggregate(space, normalId)).item?.status, "active");
        yield* worker.sweepDue();
        assert.strictEqual((yield* store.pendingReports(100)).length, 1);
        const normal = yield* store.loadAggregate(space, normalId);
        assert.strictEqual(
          normal.item?.localAvailability.reasons.includes("scanner_pending"),
          false,
        );
        assert.strictEqual(
          normal.item?.localAvailability.reasons.includes("index_unavailable"),
          false,
        );
        const quota = yield* Quota.MemoryQuotaService;
        assert.isNotNull((yield* quota.readStorageGrowth(environmentId)).current);
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='summary' AND status='failed'`).length,
          1,
        );
      }).pipe(Effect.provide(live())),
  );
  it.effect("filters streaming and system messages before applying the chunk limit", () => {
    const batches: string[][] = [];
    return Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const original = (yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
      const message = yield* decodeMessage(original.payload_json);
      yield* sql`UPDATE orchestration_events SET sequence=112 WHERE sequence=2`;
      for (let index = 2; index <= 111; index++) {
        yield* sql`INSERT INTO orchestration_events VALUES (${index},${id(2000 + index)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`skipped-${index}`), streaming: index % 2 === 0, role: index % 2 === 0 ? "user" : "system" })},${now},2,'thread')`;
      }
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      yield* worker.sweepDue();
      yield* worker.sweepDue();
      assert.deepStrictEqual(batches, [["message"]]);
    }).pipe(
      Effect.provide(
        live(false, (input) => batches.push(input.messages.map((message) => message.messageId))),
      ),
    );
  });
  it.effect("retries rejected forget excess without replaying the basic deletion", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(id(1700)),
          expectedHeads: [],
          baseBoundary: null,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
        },
        Effect.void,
      );
      const aggregate = yield* store.loadAggregate(space, memoryId);
      const operation = yield* decodeOperation({
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId,
        operationId: id(1701),
        originEnvironmentId: environmentId,
        expectedHeads: aggregate.heads,
        tombstone: {
          memorySpaceId: space,
          memoryId,
          deleteOperationId: id(1701),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [
            {
              sourceThread: { environmentId, threadId },
              sourceWatermark: { fromEventId: id(1702), toEventId: id(1703), throughSequence: 1 },
              messageIds: ["excess-message"],
            },
          ],
        },
      });
      const used = yield* store.usage(space, { kind: "user" });
      const filler = M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - used.keys;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${filler}) INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) SELECT ${space},'fixture',CAST(v AS TEXT),${id(1799)},'{}' FROM n`;
      // Exhaust intent slots as well; the basic deletion still commits and its rejected excess is recoverable.
      const intentLimit = M.MEMORY_PENDING_FORGET_INTENTS_MAX;
      yield* sql`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<${intentLimit}) INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,operation_digest,submission_state) SELECT ${space},printf('00000000-0000-4000-8000-%012d',10000+v),printf('00000000-0000-4000-8000-%012d',20000+v),${now},0,'capacity_exceeded',NULL,'unsubmitted' FROM n`;
      const decision = decideMemoryOperation(aggregate, operation, Store.localIntent, {
        kind: "allowed",
      });
      const result = yield* quota.commit(decision, environmentId, Effect.void);
      assert.strictEqual(result.receipt.outcome, "deleted");
      assert.strictEqual(result.receipt.forgetExpansion?.status, "rejected");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_pending_forget_intents WHERE memory_id=${memoryId}`)
          .length,
        0,
      );
      yield* sql`DELETE FROM memory_pending_forget_intents WHERE memory_id!=${memoryId}`;
      const intent = (yield* store.pendingForgetIntents(10))[0]!;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const failedRetryId = M.MemoryOperationId.make(
        Service.memoryStableUuid(`${intent.operationId}:0:retry`),
      );
      assert.strictEqual(yield* store.receipt(space, failedRetryId), undefined);
      assert.strictEqual((yield* store.pendingForgetIntents(10))[0]?.attempts, 1);
      yield* sql`DELETE FROM memory_import_keys WHERE key_kind='fixture'`;
      yield* (yield* Worker.MemoryWorker).sweepDue();
      const retryId = M.MemoryOperationId.make(
        Service.memoryStableUuid(`${intent.operationId}:1:retry`),
      );
      const retry = (yield* store.receipt(space, retryId))!;
      assert.strictEqual(retry.receipt.outcome, "deleted");
      assert.deepStrictEqual(retry.receipt.forgetRetryOf, {
        operationId: intent.operationId,
        operationDigest: intent.operationDigest,
      });
      assert.deepStrictEqual(yield* store.pendingForgetIntents(10), []);
      assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, 1);
      assert.deepStrictEqual(yield* quota.commit(decision, environmentId, Effect.void), result);
    }).pipe(Effect.provide(live())),
  );
  it.effect.each([false, true])(
    "preserves earlier chunks and later updates (local=%s)",
    (local) => {
      const batches: string[][] = [];
      const previous: Array<M.MemoryPayload | undefined> = [];
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const original = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
        const message = yield* decodeMessage(original.payload_json);
        yield* sql`UPDATE orchestration_events SET sequence=102 WHERE sequence=2`;
        for (let index = 2; index <= 101; index++) {
          yield* sql`INSERT INTO orchestration_events VALUES (${index},${id(1000 + index)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`message-${index}`) })},${now},2,'thread')`;
        }
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        assert.deepStrictEqual(
          batches.map((batch) => batch.length),
          [100, 1],
        );
        assert.strictEqual(new Set(batches.flat()).size, 101);
        assert.deepStrictEqual(yield* store.pendingReports(100), []);
        const run = (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=102`)[0]!;
        yield* sql`INSERT INTO orchestration_events VALUES (103,${id(1200)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("later") })},${now},2,'thread')`;
        yield* sql`INSERT INTO orchestration_events VALUES (104,${id(1201)},${threadId},'run.updated',${run.payload_json},${now},2,'thread')`;
        yield* worker.sweepDue();
        assert.deepStrictEqual(batches.at(-1), ["later"]);
        assert.strictEqual(previous[0], undefined);
        assert.include(previous[1]!.text, "message-100");
        assert.strictEqual(previous[1]!.evidence[0]!.messageIds.length, 100);
        assert.include(previous[2]!.text, "message-101");
        const summaryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const aggregate = local ? undefined : yield* store.loadAggregate(space, summaryId);
        const final = local
          ? yield* store.readLocalSummaryPayload(
              environmentId,
              `${environmentId}:${threadId}:summary`,
            )
          : aggregate?.revisions.find((pair) => pair.revision.revisionId === aggregate.heads[0])
              ?.payload;
        if (!final) throw new Error("Missing summary");
        assert.include(final.text, "message-100");
        assert.include(final.text, "message-101");
        assert.include(final.text, "later");
        assert.strictEqual(new Set(final.evidence.flatMap((entry) => entry.messageIds)).size, 102);
      }).pipe(
        Effect.provide(
          live(
            false,
            (input) => {
              batches.push(input.messages.map((message) => message.messageId));
              previous.push(input.previousSummary);
            },
            local,
          ),
        ),
      );
    },
  );
  it.effect.each([false, true])(
    "rebuilds cumulative summaries after a prior run is rolled back (local=%s)",
    (local) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        yield* seedRolledBackRegeneration;
        const worker = yield* Worker.MemoryWorker;
        const store = yield* Store.MemoryStore;
        assert.include(
          inputs[0]!.messages.map((m) => m.messageId),
          M.MessageId.make("message"),
        );
        // The hook itself is bounded to 100 events per sweep.
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        assert.strictEqual(inputs[1]!.previousSummary, undefined);
        assert.isTrue(inputs.slice(1).every((input) => input.messages.length <= 100));
        assert.isFalse(
          inputs
            .slice(1)
            .some(
              (input) =>
                input.messages.some((m) => m.messageId === "message") ||
                input.previousSummary?.text.includes("message"),
            ),
        );
        const summaryId = M.MemoryId.make(
          Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
        );
        const aggregate = local ? undefined : yield* store.loadAggregate(space, summaryId);
        const final = local
          ? yield* store.readLocalSummaryPayload(
              environmentId,
              `${environmentId}:${threadId}:summary`,
            )
          : aggregate?.revisions.find((pair) => pair.revision.revisionId === aggregate.heads[0])
              ?.payload;
        if (!final) throw new Error("Missing rebuilt summary");
        assert.notInclude(final.text, "message");
        assert.include(final.text, "run-b-100");
        const evidenceIds = new Set(final.evidence.flatMap((e) => e.messageIds));
        assert.isFalse(evidenceIds.has(M.MessageId.make("message")));
        assert.isTrue(evidenceIds.has(M.MessageId.make("survivor")));
        assert.strictEqual(evidenceIds.size, 102);
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local)));
    },
  );
  it.effect.each([false, true])(
    "keeps one claim while a regeneration outlasts the claim deadline (local=%s)",
    (local) => {
      const inputs: M.GenerateMemorySummaryInput[] = [];
      return Effect.gen(function* () {
        yield* seedRolledBackRegeneration;
        const sql = yield* SqlClient.SqlClient;
        const worker = yield* Worker.MemoryWorker;
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        // Summary A, the two-call regeneration in one work item, then the continuation chunk.
        // Two 400s calls outlast the 600s claim, so without renewal the regeneration repeats.
        assert.strictEqual(inputs.length, 4);
        assert.isUndefined(inputs[1]!.previousSummary);
        assert.isDefined(inputs[2]!.previousSummary);
        const rows = yield* sql<{
          attempt: number;
          status: string;
        }>`SELECT attempt,status FROM memory_outbox WHERE kind='summary'`;
        assert.isAbove(rows.length, 0);
        assert.deepStrictEqual(
          [...new Set(rows.map((row) => `${row.status}:${row.attempt}`))],
          ["completed:1"],
        );
      }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local, 400000)));
    },
  );
  it.effect("revisits consolidation on the first recovery scan from 24 hours on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const sql = yield* SqlClient.SqlClient;
      yield* worker.sweepDue();
      yield* TestClock.setTime(Date.parse(now) + 86400000 - 1);
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate' AND status='completed'`)[0]!
          .count,
        0,
      );
      yield* TestClock.adjust(1);
      yield* worker.sweepDue();
      // The scan just before the boundary found nothing; the next scheduled one consolidates.
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate'`)[0]!.count,
        0,
      );
      yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate' AND status='completed'`)[0]!
          .count,
        1,
      );
      yield* worker.sweepDue();
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE kind='consolidate'`)[0]!.count,
        1,
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("consolidates delayed terminal events using the processing clock", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const terminalAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(now), { hours: 1 }));
      yield* sql`UPDATE orchestration_events SET occurred_at=${terminalAt} WHERE sequence=2`;
      yield* TestClock.setTime(Date.parse(now) + 25 * 3600000);
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      const rows = yield* sql<{
        kind: string;
        status: string;
      }>`SELECT kind,status FROM memory_outbox WHERE kind='consolidate'`;
      assert.deepStrictEqual(rows, [{ kind: "consolidate", status: "completed" }]);
    }).pipe(Effect.provide(live())),
  );
  it.effect.each([
    [
      "schema_rejected",
      'Codex CLI command failed: {"error":{"message":"Invalid schema for response_format","code":"invalid_json_schema"},"status":400}',
      5,
    ],
    [
      "unavailable",
      // Grok's shape: free-text detail, typed runner cause.
      new M.TextGenerationError({
        operation: "generateMemorySummary",
        detail: "Grok did not disclose or support the selected memory model.",
        cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
      }),
      6,
    ],
  ] as const)(
    "pauses a model the provider keeps refusing (%s) instead of failing every summary",
    ([reason, schemaRejection, probes]) => {
      let reject = true;
      let calls = 0;
      return Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(now));
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const worker = yield* Worker.MemoryWorker;
        const template = work();
        for (let index = 0; index < 19; index++)
          yield* store.enqueueWork({
            ...template,
            id: "queued-" + index,
            memoryId: M.MemoryId.make(id(9000 + index)),
            status: "pending",
            claimedBy: null,
            claimedUntil: null,
            metadata: {
              ...(template.metadata as Extract<Store.MemoryWork["metadata"], { kind: "summary" }>),
              memoryId: M.MemoryId.make(id(9000 + index)),
              operationId: M.MemoryOperationId.make(id(9100 + index)),
              revisionId: M.MemoryRevisionId.make(id(9200 + index)),
            },
          });
        const summaries = sql<{
          status: string;
          attempt: number;
        }>`SELECT status,attempt FROM memory_outbox WHERE kind='summary'`;
        yield* worker.sweepDue();
        yield* worker.sweepDue();
        // The first rejection holds the model: no other summary was claimed or reported.
        assert.strictEqual(calls, 1);
        assert.strictEqual((yield* store.pendingReports(100)).length, 1);
        const statuses = (yield* summaries).map((row) => row.status);
        assert.deepStrictEqual(
          [
            statuses.filter((status) => status === "retry").length,
            statuses.filter((status) => status === "pending").length,
          ],
          [1, 19],
        );
        const hold = yield* Hold.MemoryGenerationHold;
        const key = yield* hold.keyFor(selection);
        assert.strictEqual((yield* hold.status(key))?.reason, reason);
        // Probes at 1 minute, 10 minutes and 1 hour, then once a day (hourly for an outage).
        for (const step of [60_000, 600_000, 3_600_000, 82_800_000, 3_600_000]) {
          yield* TestClock.adjust(step);
          yield* worker.sweepDue();
          yield* worker.sweepDue();
        }
        assert.strictEqual(calls, probes);
        assert.isAtMost((yield* store.pendingReports(100)).length, probes);
        // The provider is fixed: the next daily probe succeeds and the queue drains.
        reject = false;
        yield* TestClock.adjust(24 * 3_600_000);
        yield* worker.sweepDue();
        // The success lifts the hold and rearms rows that failed earlier probes, so every row is
        // generated again at once. The clones share one source chunk, so only one of them commits.
        assert.strictEqual(calls, probes + 20);
        assert.isTrue((yield* summaries).some((row) => row.status === "completed"));
        assert.isUndefined(yield* hold.status(key));
      }).pipe(
        Effect.provide(
          live(
            () => (reject ? schemaRejection : undefined),
            () => void (calls += 1),
          ).pipe(Layer.provideMerge(Hold.layer)),
        ),
      );
    },
  );
  it.effect("resumes held summaries right away when the memory model changes", () => {
    let calls = 0;
    const models: Array<string> = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const store = yield* Store.MemoryStore;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      assert.strictEqual(calls, 1);
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({
        memoryModelSelection: { instanceId: selection.instanceId, model: "fixture-next" },
      });
      // No clock advance: the change alone makes the held summary due again.
      yield* worker.sweepDue();
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(models, ["fixture", "fixture-next"]);
      const rows = yield* (yield* SqlClient.SqlClient)<{
        status: string;
      }>`SELECT status FROM memory_outbox WHERE kind='summary'`;
      assert.isTrue(rows.every((row) => row.status === "completed"));
      assert.strictEqual(yield* store.rearmGenerationWork(Date.parse(now)), 0);
    }).pipe(
      Effect.provide(
        live(
          () =>
            models.at(-1) === "fixture"
              ? 'Codex CLI command failed: {"error":{"code":"invalid_json_schema"},"status":400}'
              : undefined,
          (input) => {
            calls += 1;
            models.push(input.modelSelection.model);
          },
        ),
      ),
    );
  });
  it.effect("records one safe report and durable future retry on provider failure", () =>
    Effect.gen(function* () {
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      const reports = yield* store.pendingReports(100);
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0]!.failureCode, "generation_failed");
      yield* worker.drain;
      assert.strictEqual((yield* store.pendingReports(100)).length, 1);
    }).pipe(Effect.provide(live(true))),
  );
  it.effect("deleted thread cancels its jobs before generation", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${now}`;
      const worker = yield* Worker.MemoryWorker;
      const store = yield* Store.MemoryStore;
      yield* worker.sweepDue();
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
      assert.deepStrictEqual(
        yield* store.list({
          memorySpaceId: space,
          scope: { kind: "thread", thread: { environmentId, threadId } },
          limit: 20,
        }),
        [],
      );
    }).pipe(Effect.provide(live())),
  );
  it.effect("drains a summary work history far above the store budget to its live threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const worker = yield* Worker.MemoryWorker;
      const threads = 2000;
      const runs = 45;
      // Half the threads are live; the rest were deleted or dropped by history compaction.
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${threads - 1})
        INSERT INTO orchestration_v2_projection_threads SELECT 'synthetic-'||i,CASE WHEN i%4=1 THEN ${now} END FROM n WHERE i%4!=3`;
      // Every run left a row the size of a real one; only the newest per thread completed.
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${threads * runs - 1})
        INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,attempt,next_attempt_at)
        SELECT 'synthetic:'||i,${space},${memoryId},'summary',CASE WHEN i%${runs}=${runs - 1} THEN 'completed' ELSE 'cancelled' END,
        json_object('kind','summary','sourceThread',json_object('environmentId',${environmentId},'threadId','synthetic-'||CAST(i/${runs} AS INTEGER)),
          'observedThroughSequence',i%${runs},'sourceWatermark',json_object('fromEventId',${id(10)},'toEventId',${id(11)},'throughSequence',i%${runs}),
          'memoryId',${memoryId},'operationId',${id(4)},'revisionId',${id(5)},'modelSelection',json_object('instanceId','codex','model','fixture'),
          'evidence',printf('%.1100c','x')),1,0
        FROM n`;
      assert.isAbove((yield* store.measureAllocation()).memoryBytes!, M.MEMORY_STORE_BUDGET_BYTES);
      const rows = () =>
        sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_outbox WHERE id LIKE 'synthetic:%'`.pipe(
          Effect.map((result) => result[0]!.count),
        );
      // One sweep runs the whole paged pass: the one-time compaction of an old store.
      yield* worker.sweepDue();
      assert.strictEqual(yield* rows(), threads / 2);
      assert.isBelow((yield* store.measureAllocation()).memoryBytes!, M.MEMORY_STORE_TARGET_BYTES);
    }).pipe(Effect.provide(live())),
  );
  it.effect("settles a run that later messages invalidated instead of rereading it", () => {
    const spans = new Map<string, number>();
    const reads = () => spans.get("MemoryWorker.readSource") ?? 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* Worker.MemoryWorker;
      const original = (yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
      const message = yield* decodeMessage(original.payload_json);
      // A follow-up message whose run never reports, so the completed run's source stays stale.
      yield* sql`INSERT INTO orchestration_events VALUES (3,${id(30)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("follow-up"), runId: M.RunId.make("run-queued") })},${now},2,'thread')`;
      const sweep = worker.sweepDue().pipe(Effect.withTracer(countingTracer(spans)));
      yield* sweep;
      yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      yield* sweep;
      assert.deepStrictEqual(
        yield* sql`SELECT kind,status FROM memory_outbox WHERE kind IN ('summary','consolidate')`,
        [{ kind: "summary", status: "cancelled" }],
      );
      const settled = reads();
      for (let pass = 0; pass < 3; pass++) {
        yield* sweep;
        yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
        yield* sweep;
      }
      assert.strictEqual(reads(), settled);
      // Eight sweeps over one hour sample storage at its start and at its end.
      assert.strictEqual(spans.get("MemoryStore.measureAllocation"), 2);
    }).pipe(Effect.provide(live()));
  });
});

it.effect.each(
  [false, true].flatMap((local) =>
    (["hook", "execute"] as const).flatMap((entry) =>
      (["leading", "middle", "trailing", "all"] as const).map((shape) => ({ local, entry, shape })),
    ),
  ),
)(
  "r2 $entry consumes frame-only $shape pages and resumes next sweep (local=$local)",
  ({ local, entry, shape }) => {
    const inputs: M.GenerateMemorySummaryInput[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const worker = yield* Worker.MemoryWorker;
      const message = yield* decodeMessage(
        (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!.payload_json,
      );
      const run = yield* decodeRun(
        (yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=2`)[0]!.payload_json,
      );
      yield* sql`DELETE FROM orchestration_events`;
      const texts = [
        ...(shape === "middle" || shape === "trailing" ? ["valid before"] : []),
        ...Array.from(
          { length: shape === "leading" ? 101 : 202 },
          () => "<external_goat_memory>synthetic reference</external_goat_memory>",
        ),
        ...(shape === "leading" || shape === "middle" ? ["valid after"] : []),
      ];
      for (const [i, text] of texts.entries())
        yield* sql`INSERT INTO orchestration_events VALUES (${i + 1},${id(9000 + i)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make(`page-${i}`), runId: null, text })},${now},2,'thread')`;
      const end = texts.length + 1;
      yield* sql`INSERT INTO orchestration_events VALUES (${end},${id(9500)},${threadId},'run.updated',${encodeRun(run)},${now},2,'thread')`;
      // Execute the whole range to exercise empty pages between generation chunks too.
      const queued: Store.MemoryWork = {
        ...work(),
        space: local ? `_local:${environmentId}` : space,
        status: "pending",
        claimedBy: null,
        claimedUntil: null,
        metadata: {
          ...(work().metadata as Extract<Store.MemoryWork["metadata"], { kind: "summary" }>),
          observedThroughSequence: end,
          sourceWatermark: {
            fromEventId: M.EventId.make(id(9000)),
            toEventId: M.EventId.make(id(9500)),
            throughSequence: end,
          },
        },
      };
      if (entry === "execute") {
        yield* store.enqueueWork(queued);
        yield* store.claimWork(queued.id, "worker", Date.parse(now), Number.MAX_SAFE_INTEGER);
        yield* worker.execute((yield* store.readWork(queued.id))!);
        assert.strictEqual((yield* store.readWork(queued.id))!.status, "completed");
        assert.deepStrictEqual(
          inputs.flatMap((i) => i.messages.map((m) => m.text)),
          texts.filter((t) => !t.startsWith("<external")),
        );
        const completed = yield* sql<{
          watermark: number;
        }>`SELECT json_extract(metadata_json,'$.sourceWatermark.throughSequence') AS watermark FROM memory_outbox WHERE id=${queued.id}`;
        assert.strictEqual(completed[0]!.watermark, end);
      } else {
        for (let i = 0; i < 8; i++) yield* worker.sweepDue();
        assert.deepStrictEqual(
          inputs.flatMap((i) => i.messages.map((m) => m.text)),
          texts.filter((t) => !t.startsWith("<external")),
        );
        const rows = yield* sql<{
          watermark: number;
        }>`SELECT max(json_extract(metadata_json,'$.sourceWatermark.throughSequence')) AS watermark FROM memory_outbox WHERE status='completed' AND kind='summary'`;
        assert.strictEqual(rows[0]!.watermark, end);
      }
      // Catch-up must consume the same empty history without another generation.
      for (let i = 0; i < 4; i++) yield* worker.sweepDue();
      const count = inputs.length;
      yield* worker.sweepDue();
      assert.strictEqual(inputs.length, count);
      yield* sql`INSERT INTO orchestration_events VALUES (${end + 1},${id(9501)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("next-page"), runId: null, text: "next valid statement" })},${now},2,'thread')`;
      yield* sql`INSERT INTO orchestration_events VALUES (${end + 2},${id(9502)},${threadId},'run.updated',${encodeRun({ ...run, id: M.RunId.make("next-run") })},${now},2,'thread')`;
      yield* worker.sweepDue();
      assert.strictEqual(inputs.length, count + 1);
      assert.strictEqual(inputs.at(-1)!.messages[0]!.text, "next valid statement");
    }).pipe(Effect.provide(live(false, (input) => inputs.push(input), local)));
  },
);

// The snapshot service and worker share the real writer/store; only the provider and
// projection shell are synthetic. The second turn receives no new memory snapshot.
const lineageLive = (onInput?: (input: M.GenerateMemorySummaryInput) => void) =>
  Snapshot.layer.pipe(
    Layer.provideMerge(live(false, onInput)),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getThreadShell: (requested) =>
          Effect.succeed({
            id: requested,
            projectId: M.ProjectId.make("project"),
            activeRunId: M.RunId.make("run"),
            activityRunStatus: "running",
          } as M.OrchestrationV2ThreadShell),
      }),
    ),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.succeed({ memorySpaceId: space, bootstrap: "ready" as const }),
      }),
    ),
  );
const lineagePolicy = { grant: "read" as const, policyEpoch: 1 };
const lineageSetup = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(now));
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES ('project','/synthetic',NULL)`;
});
const lineageUpsert = (
  n: number,
  deps: readonly M.MemoryRevisionId[] = [],
): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId: M.MemoryId.make(id(n)),
  operationId: M.MemoryOperationId.make(id(n + 1000)),
  expectedHeads: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  payload: { text: `synthetic lineage ${n}`, evidence: [], derivedFromMemoryRevisions: deps },
  baseBoundary: null,
});
const head = (store: Store.MemoryStore["Service"], target: M.MemoryId) =>
  store.loadAggregate(space, target).pipe(Effect.map((a) => a.heads[0]!));
const summaryMemoryId = M.MemoryId.make(
  Service.memoryStableUuid(`${environmentId}:${threadId}:summary`),
);
const laterLineageTurn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const original = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`)[0]!;
  const message = yield* decodeMessage(original.payload_json);
  const runRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events WHERE sequence=2`)[0]!;
  const run = yield* decodeRun(runRow.payload_json);
  yield* sql`INSERT INTO orchestration_events VALUES (3,${id(9300)},${threadId},'message.updated',${encodeMessage({ ...message, id: M.MessageId.make("paraphrase"), role: "assistant", runId: M.RunId.make("later"), text: "synthetic memory paraphrase without a frame" })},${now},2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (4,${id(9301)},${threadId},'run.updated',${encodeRun({ ...run, id: M.RunId.make("later"), ordinal: 2 })},${now},2,'thread')`;
});
it.effect.each([false, true, "multi"] as const)(
  "r4 injected context survives later turns and derived body pruning (derived=%s)",
  (derived) => {
    let generated = 0;
    return Effect.gen(function* () {
      yield* lineageSetup;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const snapshot = yield* Snapshot.MemorySnapshot;
      const worker = yield* Worker.MemoryWorker;
      const sql = yield* SqlClient.SqlClient;
      const a: M.MemoryUpsertInput = {
        ...lineageUpsert(9200),
        ...(derived
          ? {
              scope: {
                kind: "thread" as const,
                thread: { environmentId, threadId: M.ThreadId.make("unrelated") },
              },
            }
          : {}),
      };
      yield* service.upsert(a, Effect.void);
      const rA = yield* head(store, a.memoryId);
      const unrelated = {
        ...lineageUpsert(9250),
        scope: {
          kind: "thread" as const,
          thread: { environmentId, threadId: M.ThreadId.make("unrelated") },
        },
      };
      yield* service.upsert(unrelated, Effect.void);
      const unrelatedRevision = yield* head(store, unrelated.memoryId);
      yield* store.appendThreadLineage(
        { environmentId, threadId: M.ThreadId.make("other-owner") },
        space,
        [unrelatedRevision],
      );
      let rD: M.MemoryRevisionId | undefined;
      let rB: M.MemoryRevisionId | undefined;
      if (derived === "multi") {
        const b = { ...lineageUpsert(9202, [rA]), scope: a.scope };
        yield* service.upsert(b, Effect.void);
        rB = yield* head(store, b.memoryId);
      }
      if (derived) {
        const d = lineageUpsert(9201, [rB ?? rA]);
        yield* service.upsert(d, Effect.void);
        rD = yield* head(store, d.memoryId);
      }
      const selected = yield* snapshot.forThread(
        threadId,
        lineagePolicy,
        Effect.succeed(lineagePolicy),
      );
      assert.isDefined(selected);
      if (derived)
        assert.deepStrictEqual(
          selected!.items.map((i) => i.revisionId),
          [rD],
        );
      const lineage = yield* store.readThreadLineage({ environmentId, threadId }, space);
      assert.include(lineage.revisions, rA);
      if (rD) assert.include(lineage.revisions, rD);
      if (rB) assert.include(lineage.revisions, rB);
      for (const n of derived ? (rB ? [9202, 9201] : [9201]) : []) {
        const d = { ...lineageUpsert(n), ...(n === 9202 ? { scope: a.scope } : {}) };
        const aggregate = yield* store.loadAggregate(space, d.memoryId);
        const oldHead = aggregate.heads[0]!;
        const old = aggregate.revisions.find((p) => p.revision.revisionId === oldHead)!;
        yield* service.upsert(
          { ...d, operationId: M.MemoryOperationId.make(id(n + 11000)), expectedHeads: [oldHead] },
          Effect.void,
        );
        yield* sql`UPDATE memory_events SET receipt_json=json_set(receipt_json,'$.hubSequence',1) WHERE operation_id=${old.revision.operationId}`;
        yield* sql`UPDATE memory_outbox SET status='completed' WHERE space=${space} AND payload_ref=${old.revision.payloadRef}`;
        yield* sql`UPDATE memory_payloads SET purge_eligible_after=0 WHERE space=${space} AND payload_ref=${old.revision.payloadRef}`;
        yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1) ON CONFLICT(space) DO UPDATE SET published=1`;
        yield* store.prunePayloads(Date.parse(now), 100);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${old.revision.payloadRef}`,
          0,
        );
      }
      // Exclude the first run's source. The only usable message is a later native
      // paraphrase, yet its summary must retain the earlier injection's lineage.
      yield* laterLineageTurn;
      yield* sql`DELETE FROM orchestration_events WHERE sequence IN (1,2)`;
      yield* worker.sweepDue();
      assert.strictEqual(generated, 1);
      const summary = yield* store.loadAggregate(space, summaryMemoryId);
      const payload = summary.revisions.find(
        (p) => p.revision.revisionId === summary.heads[0],
      )!.payload!;
      assert.include(payload.derivedFromMemoryRevisions, rA);
      if (rD) assert.include(payload.derivedFromMemoryRevisions, rD);
      const fresh = yield* store.readThreadLineage(
        { environmentId, threadId: M.ThreadId.make("clean") },
        space,
      );
      assert.deepStrictEqual(fresh.revisions, []);
      assert.strictEqual(fresh.state, "tracked");
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId: a.memoryId,
          operationId: M.MemoryOperationId.make(id(10204)),
          expectedHeads: [yield* head(store, a.memoryId)],
        },
        Effect.void,
      );
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${summaryMemoryId}`,
        0,
      );
      // A source rebuild must fail before asking the generation transport again.
      const retry = work();
      const candidate = {
        ...retry,
        id: "r3-after-forget",
        memoryId: M.MemoryId.make(id(9299)),
        metadata: {
          ...retry.metadata,
          ...(retry.metadata.kind === "summary"
            ? {
                sourceWatermark: {
                  fromEventId: M.EventId.make(id(9300)),
                  toEventId: M.EventId.make(id(9301)),
                  throughSequence: 4,
                },
                memoryId: M.MemoryId.make(id(9299)),
                operationId: M.MemoryOperationId.make(id(10205)),
              }
            : {}),
        },
      };
      yield* store.enqueueWork(candidate);
      yield* worker.execute(candidate);
      assert.strictEqual(generated, 1);
      assert.strictEqual((yield* store.readWork(candidate.id))?.status, "cancelled");
      assert.include(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions,
        rA,
      );
      assert.strictEqual(
        (yield* store.loadAggregate(space, unrelated.memoryId)).item?.status,
        "active",
      );
      assert.deepStrictEqual(
        (yield* store.readThreadLineage(
          { environmentId, threadId: M.ThreadId.make("other-owner") },
          space,
        )).revisions,
        [unrelatedRevision],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at=${now} WHERE thread_id=${threadId}`;
      yield* sql`INSERT INTO orchestration_events VALUES (5,${id(9302)},${threadId},'thread.deleted','{}',${now},2,'thread')`;
      yield* worker.sweepDue();
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_outbox WHERE json_extract(metadata_json,'$.kind')='threadLineage' AND json_extract(metadata_json,'$.sourceThread.threadId')=${threadId}`,
        0,
      );
      assert.deepStrictEqual(
        (yield* store.readThreadLineage(
          { environmentId, threadId: M.ThreadId.make("other-owner") },
          space,
        )).revisions,
        [unrelatedRevision],
      );
    }).pipe(
      Effect.provide(
        lineageLive(() => {
          generated++;
        }),
      ),
    );
  },
);
it.effect.each(["fork", "import", "transfer", "overflow"] as const)(
  "r3 unknown %s history never reaches generation",
  (kind) => {
    let generated = 0;
    return Effect.gen(function* () {
      yield* lineageSetup;
      const sql = yield* SqlClient.SqlClient;
      const payload =
        kind === "fork"
          ? { forkedFrom: { type: "provider_thread", providerThreadId: "missing" } }
          : kind === "import"
            ? {
                status: "not_loaded",
                nativeThreadRef: { nativeId: "synthetic" },
                providerSessionId: null,
              }
            : { sourceThreadId: "missing", targetThreadId: threadId };
      const event =
        kind === "fork"
          ? "thread.created"
          : kind === "import"
            ? "provider-thread.updated"
            : "context-transfer.created";
      yield* sql`INSERT INTO orchestration_events VALUES (0,${id(9400)},${threadId},${event},${JSON.stringify(payload)},${now},2,'thread')`;
      const store = yield* Store.MemoryStore;
      if (kind === "overflow") {
        yield* sql`DELETE FROM orchestration_events WHERE sequence=0`;
        yield* store.appendThreadLineage(
          { environmentId, threadId },
          space,
          Array.from({ length: 100 }, (_, n) => M.MemoryRevisionId.make(id(9800 + n))),
        );
        yield* store.appendThreadLineage({ environmentId, threadId }, space, [
          M.MemoryRevisionId.make(id(9900)),
        ]);
      }
      assert.strictEqual(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).state,
        kind === "overflow" ? "overflow" : "unknown",
      );
      const service = yield* Service.MemoryService;
      yield* service.upsert(lineageUpsert(14900), Effect.void);
      const snapshot = yield* Snapshot.MemorySnapshot;
      assert.isDefined(
        yield* snapshot.forThread(threadId, lineagePolicy, Effect.succeed(lineagePolicy)),
      );
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      assert.strictEqual(generated, 0);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${summaryMemoryId}`,
        0,
      );
    }).pipe(
      Effect.provide(
        lineageLive(() => {
          generated++;
        }),
      ),
    );
  },
);
it.effect("r3 previous summary plus thread lineage exceeding 100 never reaches generation", () => {
  let generated = 0;
  return Effect.gen(function* () {
    yield* lineageSetup;
    const worker = yield* Worker.MemoryWorker;
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    yield* worker.sweepDue();
    assert.strictEqual(generated, 1);
    const deps: M.MemoryRevisionId[] = [];
    for (let n = 10000; n <= 10100; n++) {
      const value = lineageUpsert(n);
      yield* service.upsert(value, Effect.void);
      deps.push(yield* head(store, value.memoryId));
    }
    const current = yield* store.loadAggregate(space, summaryMemoryId);
    const previous = current.revisions.find(
      (p) => p.revision.revisionId === current.heads[0],
    )!.payload!;
    yield* service.upsert(
      {
        memorySpaceId: space,
        memoryId: summaryMemoryId,
        expectedHeads: current.heads,
        operationId: M.MemoryOperationId.make(id(12000)),
        scope: { kind: "thread", thread: { environmentId, threadId } },
        assertionKind: "inference",
        payload: { ...previous, derivedFromMemoryRevisions: deps.slice(0, 100) },
        baseBoundary: null,
      },
      Effect.void,
    );
    yield* store.appendThreadLineage({ environmentId, threadId }, space, [deps[100]!]);
    yield* laterLineageTurn;
    yield* worker.sweepDue();
    assert.strictEqual(generated, 1);
  }).pipe(
    Effect.provide(
      lineageLive(() => {
        generated++;
      }),
    ),
  );
});

it.effect.each(threadProvenanceCases(threadId))(
  "production origin $name: $state gates summary generation",
  (origin) => {
    let generated = 0;
    return Effect.gen(function* () {
      yield* lineageSetup;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const service = yield* Service.MemoryService;
      yield* sql`INSERT INTO orchestration_events VALUES (-10,${id(14500)},${threadId},'thread.created',${origin.createdJson},${now},2,'thread')`;
      for (const [i, event] of origin.events.entries())
        yield* sql`INSERT INTO orchestration_events VALUES (${i - 9},${id(14510 + i)},${event.streamId},${event.type},${event.payloadJson},${now},2,'thread')`;
      assert.strictEqual(
        (yield* store.readThreadLineage({ environmentId, threadId }, space)).state,
        origin.state,
      );
      yield* service.upsert(lineageUpsert(14501), Effect.void);
      assert.isDefined(
        yield* (yield* Snapshot.MemorySnapshot).forThread(
          threadId,
          lineagePolicy,
          Effect.succeed(lineagePolicy),
        ),
      );
      yield* (yield* Worker.MemoryWorker).sweepDue();
      assert.strictEqual(generated, origin.state === "tracked" ? 1 : 0);
      assert.strictEqual(
        (yield* store.loadAggregate(space, summaryMemoryId)).heads.length,
        origin.state === "tracked" ? 1 : 0,
      );
    }).pipe(
      Effect.provide(
        lineageLive(() => {
          generated++;
        }),
      ),
    );
  },
);

it.effect("r5 MCP body consumption reaches Worker summary and forget purges summary", () => {
  let generated = 0;
  return Effect.gen(function* () {
    yield* lineageSetup;
    const service = yield* Service.MemoryService;
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const a = lineageUpsert(24000);
    yield* service.upsert(a, Effect.void);
    const rA = yield* head(store, a.memoryId);
    // The MCP read service boundary, without automatic snapshot injection.
    yield* service.read({ memorySpaceId: space, memoryId: a.memoryId }, Effect.void, {
      environmentId,
      threadId,
    });
    assert.deepStrictEqual(
      (yield* store.readThreadLineage({ environmentId, threadId }, space)).revisions,
      [rA],
    );
    yield* (yield* Worker.MemoryWorker).sweepDue();
    assert.strictEqual(generated, 1);
    const summary = yield* store.loadAggregate(space, summaryMemoryId);
    assert.include(
      summary.revisions.find((p) => p.revision.revisionId === summary.heads[0])!.payload!
        .derivedFromMemoryRevisions,
      rA,
    );
    yield* service.forget(
      {
        memorySpaceId: space,
        memoryId: a.memoryId,
        operationId: M.MemoryOperationId.make(id(24001)),
        expectedHeads: [rA],
      },
      Effect.void,
    );
    assert.lengthOf(
      yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${summaryMemoryId}`,
      0,
    );
  }).pipe(
    Effect.provide(
      lineageLive(() => {
        generated++;
      }),
    ),
  );
});
