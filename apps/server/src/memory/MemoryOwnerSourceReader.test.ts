import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Settings from "../serverSettings.ts";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import * as Owner from "./MemoryOwnerSourceReader.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { decideMemoryOperation } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const owner = M.EnvironmentId.make("owner");
const requester = M.EnvironmentId.make("requester");
const thread = { environmentId: owner, threadId: M.ThreadId.make("thread") };
const messageId = M.MessageId.make("message");
const assistantId = M.MessageId.make("assistant");
const runId = M.RunId.make("fixture-run");
const watermark = {
  fromEventId: M.EventId.make(id(3)),
  toEventId: M.EventId.make(id(13)),
  throughSequence: 4,
};
const input: M.MemoryHubSourceReadRequestInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  memoryId: memory,
  requestId: M.MemorySourceReadRequestId.make(id(4)),
  sourceThread: thread,
  sourceWatermark: watermark,
  messageIds: [messageId, assistantId],
  limit: 10,
  authorizedScopes: ["memory:read", "orchestration:read"],
};
const request: M.MemorySourceReadRequest = {
  ...Owner.sourceReadInput({
    ...input,
    requesterEnvironmentId: requester,
    expiresAtHubTime: "1970-01-01T00:01:15.000Z",
  }),
  requesterEnvironmentId: requester,
  expiresAtHubTime: "1970-01-01T00:01:15.000Z",
  stamp: { requesterCredentialVersion: 1, locatorDigest: Owner.sourceReadLocatorDigest(input) },
};
// protocolVersion is transport-only.
const { protocolVersion: _protocol, ...locator } = request as M.MemorySourceReadRequest & {
  protocolVersion: 1;
};
const encodeMessage = Schema.encodeSync(
  Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
);
const message = M.OrchestrationV2ConversationMessageJson.make({
  id: messageId,
  threadId: thread.threadId,
  runId: null,
  nodeId: null,
  createdBy: "user",
  creationSource: "web",
  role: "user",
  text: "fixture committed original",
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
});
const assistant = {
  ...message,
  id: assistantId,
  role: "assistant" as const,
  runId,
  createdBy: "agent" as const,
  text: "fixture completed answer",
};
const encodeRun = Schema.encodeSync(Schema.fromJsonString(M.OrchestrationV2RunJson));
const run = (status: M.OrchestrationV2RunJson["status"]) =>
  M.OrchestrationV2RunJson.make({
    id: runId,
    threadId: thread.threadId,
    ordinal: 1,
    providerInstanceId: M.ProviderInstanceId.make("fixture-provider"),
    modelSelection: { instanceId: M.ProviderInstanceId.make("fixture-provider"), model: "fixture" },
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: DateTime.makeUnsafe(0),
    startedAt: DateTime.makeUnsafe(0),
    completedAt: status === "running" ? null : DateTime.makeUnsafe(0),
    checkpointId: null,
    contextHandoffId: null,
  });
const committed: Owner.MemoryOwnerSourceReadCommitted = {
  version: 1,
  policy: {
    allowedRequesterEnvironmentIds: [requester],
    ownerPolicyEpoch: 1,
    removals: [],
    enrollments: [
      {
        state: "active",
        memorySpaceId: space,
        ownerEnvironmentId: owner,
        requesterEnvironmentId: requester,
        ownerPolicyEpoch: 1,
      },
    ],
  },
};
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
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(owner),
});
const core = Service.layer.pipe(
  Layer.provideMerge(
    Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(setup)))),
  ),
  Layer.provideMerge(identity),
  Layer.provide(
    Layer.mock(Repository.RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
  ),
);
const fixture = (policy: Ref.Ref<Owner.MemoryOwnerSourceReadCommitted>, hubLocal = false) =>
  Owner.layer.pipe(
    Layer.provideMerge(core),
    Layer.provide(
      Layer.succeed(Owner.MemoryOwnerSourceReadPolicyPort, {
        read: Ref.get(policy),
        changes: Effect.succeed(Stream.empty),
        recordRevokeAck: () => Ref.get(policy),
      }),
    ),
    Layer.provide(
      Settings.layerTest(
        {
          memoryHub: hubLocal
            ? { mode: "hub", memorySpaceId: space }
            : {
                mode: "member",
                memorySpaceId: space,
                hubEnvironmentId: M.EnvironmentId.make("hub"),
                endpoint: M.MemoryHubEndpoint.make("https://fixture.invalid"),
                secretName: "fixture",
              },
        },
        "memoryHub",
      ),
    ),
  );
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.threadId},NULL)`;
  yield* sql`INSERT INTO orchestration_events VALUES (1,${watermark.fromEventId},${thread.threadId},'message.updated',${encodeMessage(message)},'1970-01-01T00:00:00.000Z',2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (2,${id(11)},${thread.threadId},'run.created',${encodeRun(run("running"))},'1970-01-01T00:00:00.000Z',2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (3,${id(12)},${thread.threadId},'message.updated',${encodeMessage(assistant)},'1970-01-01T00:00:00.000Z',2,'thread')`;
  yield* sql`INSERT INTO orchestration_events VALUES (4,${watermark.toEventId},${thread.threadId},'run.updated',${encodeRun(run("completed"))},'1970-01-01T00:00:00.000Z',2,'thread')`;
  const store = yield* Store.MemoryStore;
  const op: M.MemoryOperation = {
    protocolVersion: 1,
    kind: "upsert",
    memorySpaceId: space,
    memoryId: memory,
    operationId: M.MemoryOperationId.make(id(5)),
    originEnvironmentId: owner,
    expectedHeads: [],
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      operationId: M.MemoryOperationId.make(id(5)),
      revisionId: M.MemoryRevisionId.make(id(6)),
      payloadRef: M.MemoryRevisionId.make(id(6)),
      parents: [],
      scope: { kind: "user" },
      assertionKind: "inference",
      createdAtUtc: "1970-01-01T00:00:00.000Z",
      provenance: { environmentId: owner, sourceThread: thread, sourceWatermark: watermark },
    },
    payload: {
      text: "fixture summary",
      evidence: [
        { origin: "thread", sourceThread: thread, watermark, messageIds: [messageId, assistantId] },
      ],
      derivedFromMemoryRevisions: [],
    },
  };
  yield* store.apply(
    decideMemoryOperation(
      yield* store.loadAggregate(space, memory),
      op,
      Store.localIntent,
      scanMemoryValue(op),
    ),
  );
});

it.effect.each([false, true])(
  `reads bounded committed original with the same checks (owner=hub %s)`,
  (hubLocal) =>
    Effect.gen(function* () {
      const policy = yield* Ref.make(committed);
      yield* Effect.gen(function* () {
        yield* seed;
        const reader = yield* Owner.MemoryOwnerSourceReader;
        const outcome = yield* reader.reader.readCommitted(locator, reader.permit(locator));
        assert.deepStrictEqual(outcome, {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [
              { messageId, text: "fixture committed original" },
              { messageId: assistantId, text: "fixture completed answer" },
            ],
            nextCursor: null,
          },
        });
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE body_json LIKE '%fixture committed original%'`)
            .length,
          0,
        );
      }).pipe(Effect.provide(fixture(policy, hubLocal)));
    }),
);

it.effect.each([
  "empty allowlist",
  "pending enrollment",
  "legacy",
  "digest",
  "deadline",
  "foreign owner",
  "wrong space",
] as const)(`denies before body read: %s`, (denial) =>
  Effect.gen(function* () {
    const policy = yield* Ref.make(committed);
    yield* Effect.gen(function* () {
      yield* seed;
      let value = locator;
      if (denial === "empty allowlist")
        yield* Ref.set(policy, { version: 2, policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY });
      if (denial === "pending enrollment")
        yield* Ref.set(policy, {
          version: 2,
          policy: {
            allowedRequesterEnvironmentIds: [],
            ownerPolicyEpoch: 2,
            removals: [
              {
                memorySpaceId: space,
                ownerEnvironmentId: owner,
                requesterEnvironmentId: requester,
                removalEpoch: 1,
                state: "pending",
              },
            ],
            enrollments: [
              {
                memorySpaceId: space,
                ownerEnvironmentId: owner,
                requesterEnvironmentId: requester,
                ownerPolicyEpoch: 2,
                state: "pending",
                removalEpoch: 1,
              },
            ],
          },
        });
      if (denial === "legacy") {
        const { stamp: _stamp, ...old } = value;
        value = old;
      }
      if (denial === "digest")
        value = {
          ...value,
          stamp: { requesterCredentialVersion: 1, locatorDigest: "a".repeat(64) },
        };
      if (denial === "deadline") yield* TestClock.adjust(75000);
      if (denial === "foreign owner")
        value = { ...value, sourceThread: { ...thread, environmentId: requester } };
      if (denial === "wrong space")
        value = { ...value, memorySpaceId: M.MemorySpaceId.make(id(99)) };
      const reader = yield* Owner.MemoryOwnerSourceReader;
      const error = yield* reader.reader.readCommitted(value, Effect.void).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryAccessError");
    }).pipe(Effect.provide(fixture(policy)));
  }),
);

it.effect.each([
  "deleted thread",
  "streaming",
  "new message",
  "wrong watermark",
  "forgotten",
  "secret",
  "oversize",
] as const)(`does not expose invalid committed source: %s`, (drift) =>
  Effect.gen(function* () {
    const policy = yield* Ref.make(committed);
    yield* Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      if (drift === "deleted thread")
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='deleted'`;
      if (drift === "streaming")
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeMessage({ ...message, streaming: true })} WHERE sequence=1`;
      if (drift === "new message")
        yield* sql`INSERT INTO orchestration_events SELECT 5,${id(99)},stream_id,event_type,payload_json,occurred_at,application_event_version,aggregate_kind FROM orchestration_events WHERE sequence=1`;
      if (drift === "wrong watermark")
        yield* sql`UPDATE orchestration_events SET event_id=${id(99)}`;
      if (drift === "forgotten")
        yield* sql`INSERT INTO memory_pending_forget_intents(space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,submission_state) VALUES (${space},${memory},${id(99)},'1970-01-01T00:00:00.000Z',0,NULL,'unsubmitted')`;
      if (drift === "secret")
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeMessage({ ...message, text: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----" })} WHERE sequence=1`;
      if (drift === "oversize")
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeMessage({ ...message, text: "x".repeat(70000) })} WHERE sequence=1`;
      const reader = yield* Owner.MemoryOwnerSourceReader;
      const result = yield* Effect.result(reader.reader.readCommitted(locator, Effect.void));
      if (drift === "secret") {
        assert.strictEqual(result._tag, "Success");
        if (result._tag === "Success")
          assert.deepStrictEqual(result.success, {
            kind: "unavailable",
            code: "secret_detected",
          });
      } else assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.provide(fixture(policy)));
  }),
);

it.effect("rechecks committed policy after the read before releasing body", () =>
  Effect.gen(function* () {
    const policy = yield* Ref.make(committed);
    yield* Effect.gen(function* () {
      yield* seed;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let calls = 0;
      const permit = Effect.suspend(() =>
        ++calls === 4
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void,
      );
      const reader = yield* Owner.MemoryOwnerSourceReader;
      const fiber = yield* reader.reader
        .readCommitted(locator, permit)
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Ref.set(policy, { version: 2, policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY });
      yield* Deferred.succeed(resume, undefined);
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "Failure");
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }).pipe(Effect.provide(fixture(policy)));
  }),
);

it.effect.each([
  "running",
  "failed",
  "rolled_back",
  "completion after watermark",
  "run changed after watermark",
] as const)("rejects uncommitted run evidence: %s", (drift) =>
  Effect.gen(function* () {
    const policy = yield* Ref.make(committed);
    yield* Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      if (drift === "completion after watermark") {
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeRun(run("running"))} WHERE sequence=4`;
        yield* sql`INSERT INTO orchestration_events VALUES (5,${id(99)},${thread.threadId},'run.updated',${encodeRun(run("completed"))},'1970-01-01T00:00:00.000Z',2,'thread')`;
      } else if (drift === "run changed after watermark") {
        yield* sql`INSERT INTO orchestration_events VALUES (5,${id(99)},${thread.threadId},'run.updated',${encodeRun(run("completed"))},'1970-01-01T00:00:00.000Z',2,'thread')`;
      } else {
        yield* sql`UPDATE orchestration_events SET payload_json=${encodeRun(run(drift))} WHERE sequence=4`;
      }
      const reader = yield* Owner.MemoryOwnerSourceReader;
      const result = yield* Effect.result(reader.reader.readCommitted(locator, Effect.void));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "MemoryStoreConflict");
    }).pipe(Effect.provide(fixture(policy)));
  }),
);
