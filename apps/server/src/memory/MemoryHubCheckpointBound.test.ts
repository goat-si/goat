import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/098_Memory.ts";
import hubMigration from "./testkit/MemoryHubTestMigration.ts";
import searchMigration from "../persistence/Migrations/100_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/102_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/103_MemoryCheckpointAccounting.ts";
import reportMigration from "../persistence/Migrations/104_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/105_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/106_MemoryRevertResults.ts";
import readyMigration from "../persistence/Migrations/108_MemoryLastReadySpace.ts";
import adminMigration from "../persistence/Migrations/109_MemoryHubAdministered.ts";
import lifecycleMigration from "../persistence/Migrations/110_MemoryCheckpointLifecycle.ts";
import revisionSizeMigration from "../persistence/Migrations/115_MemoryRevisionCheckpointSize.ts";
import { CHECKPOINT_PULL_MAX_BYTES, FORGET_RECORDS_MAX_BYTES } from "./MemoryCheckpointBound.ts";
import { requireMemoryTailFit } from "./MemoryTailAdmission.ts";
import { encodeCheckpointRecord } from "./MemoryCheckpointInventory.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import * as HubKit from "./MemoryHubService.testkit.ts";
import { MemoryCompactor } from "./MemoryCompactor.ts";
import { MemoryHubService } from "./MemoryHubService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Store from "./MemoryStore.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const thread = { environmentId: env, threadId: M.ThreadId.make("thread-fixture") };
const watermark = {
  fromEventId: M.EventId.make("event-from"),
  toEventId: M.EventId.make("event-to"),
  throughSequence: 9,
};
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const decodeTombstone = Schema.decodeUnknownSync(M.MemoryTombstone);
const decodeItem = Schema.decodeUnknownSync(M.MemoryItem);
const decodeCompactReceipt = Schema.decodeUnknownSync(M.MemoryCompactReceipt);
const decodePull = Schema.decodeUnknownExit(M.MemoryHubPullResult);
const utf8 = (value: string) => new TextEncoder().encode(value).length;

const layer = Store.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      migration.pipe(
        Effect.andThen(hubMigration),
        Effect.andThen(lineageMigration),
        Effect.andThen(checkpointMigration),
        Effect.andThen(revisionSizeMigration),
        Effect.andThen(reportMigration),
        Effect.andThen(usageMigration),
        Effect.andThen(revertMigration),
        Effect.andThen(readyMigration),
        Effect.andThen(adminMigration),
        Effect.andThen(lifecycleMigration),
        Effect.andThen(searchMigration),
      ),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);

const upsert = (input: {
  memory: number;
  operation: number;
  text: string;
  messages: ReadonlyArray<string>;
  parent?: string;
}) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(input.memory),
    operationId: id(input.operation),
    originEnvironmentId: env,
    expectedHeads: input.parent ? [input.parent] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: id(input.memory),
      revisionId: id(input.operation + 1_000_000),
      operationId: id(input.operation),
      parents: input.parent ? [input.parent] : [],
      scope: { kind: "thread", thread },
      payloadRef: id(input.operation + 1_000_000),
      assertionKind: "inference",
      provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
      createdAtUtc: now,
    },
    payload: {
      text: input.text,
      evidence: input.messages.length
        ? [{ origin: "thread", sourceThread: thread, watermark, messageIds: input.messages }]
        : [],
      derivedFromMemoryRevisions: [],
    },
  });

/** The base fragment a member's local forget sends: one exclusion per reserved evidence message. */
const forget = (
  memory: number,
  operation: number,
  messages: ReadonlyArray<string>,
  deleting: string = env,
) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(memory),
    operationId: id(operation),
    originEnvironmentId: deleting,
    expectedHeads: [],
    kind: "forget",
    tombstone: {
      memorySpaceId: space,
      memoryId: id(memory),
      deleteOperationId: id(operation),
      deletingEnvironmentId: deleting,
      deletedAtUtc: now,
      suppressedSourceKeys: [],
      suppressedContent: [],
      sourceExclusions: messages.length
        ? [{ sourceThread: thread, sourceWatermark: watermark, messageIds: messages }]
        : [],
    },
  });

const admit = Effect.fnUntraced(function* (op: M.MemoryOperation) {
  const store = yield* Store.MemoryStore;
  yield* store.transact(
    Effect.gen(function* () {
      const ledger = yield* store.appendHubEntryTx({
        operation: op,
        operationDigest: memoryOperationDigest(op),
        outcome: op.kind === "forget" ? "deleted" : "accepted",
        now: 0,
      });
      const decided = decideMemoryOperation(
        yield* store.loadAggregate(op.memorySpaceId, op.memoryId),
        op,
        Store.hubAdmission,
        scanMemoryValue(op),
      );
      yield* store.apply({ ...decided, receipt: ledger.entry.receipt });
    }),
  );
});

const join = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${"a".repeat(64)},1,'active')`;
});
const usage = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  return yield* store.transact(store.readHubUsageTx(space));
});
/** Builds and stages a full producer snapshot; staging itself refuses a bound underflow. */
const snapshot = Effect.fnUntraced(function* (checkpointId: string) {
  const store = yield* Store.MemoryStore;
  yield* store.transact(
    store.prepareHubProducerCheckpointTx({
      authority: {
        principal: {
          memorySpaceId: space,
          environmentId: env,
          credentialVersion: 1,
          scopes: ["memory:sync"],
        },
        now: Clock.currentTimeMillis,
        reauthorize: Effect.void,
      },
      checkpointId,
      hubEnvironmentId: env,
    }),
  );
  return yield* usage;
});

it.effect(
  "regression: a hub space admits 1500 small source-attributed summaries within checkpoint staging",
  () =>
    Effect.gen(function* () {
      yield* join;
      for (let n = 0; n < 1500; n++)
        yield* admit(
          upsert({
            memory: 10_000 + n,
            operation: 100_000 + n,
            text: `Thread summary ${n}: ${"decisions and follow-ups ".repeat(40)}`,
            messages: [`message-${n}-a`, `message-${n}-b`],
          }),
        );
      const after = yield* snapshot("thousands");
      assert.isAtMost(after.lastSnapshotBytes, after.requiredCheckpointBoundBytes);
      assert.isBelow(after.requiredCheckpointBoundBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES / 4);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "contract: forget records with a core-sized environment id fit the forget allowance",
  () =>
    Effect.sync(() => {
      // Seven bytes per unit once JSON-escaped: 146 units and two quotes encode to 1024 bytes.
      const environmentId = M.EnvironmentId.make('"\\한'.repeat(146));
      assert.strictEqual(utf8(JSON.stringify(environmentId)), M.MEMORY_IDENTITY_CORE_MAX_BYTES);
      const digest = "f".repeat(64);
      const tombstone = decodeTombstone({
        memorySpaceId: space,
        memoryId: id(2),
        deleteOperationId: id(3),
        deletingEnvironmentId: environmentId,
        deletedAtUtc: now,
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      });
      const item = decodeItem({
        memorySpaceId: space,
        memoryId: id(2),
        status: "forgotten",
        tombstone,
        pendingSync: false,
        localAvailability: {
          exposure: "forgotten",
          reasons: [],
          deferred: [],
          cleanupPending: false,
        },
      });
      const receipt = decodeCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "forget",
        receipt: {
          forgetExpansion: {
            requestDigest: digest,
            operationId: id(4),
            operationDigest: digest,
            status: "rejected",
          },
          forgetRetryOf: { operationId: id(5), operationDigest: digest },
          operationId: id(3),
          memoryId: id(2),
          operationDigest: digest,
          outcome: "deleted",
          hubSequence: Number.MAX_SAFE_INTEGER,
        },
        revisionId: null,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      const bytes = [item, tombstone, receipt].reduce(
        (sum, record) => sum + utf8(encodeCheckpointRecord(record)),
        0,
      );
      assert.isAtMost(bytes, FORGET_RECORDS_MAX_BYTES);
    }),
);

it.effect("contract: the page bound assumes MemoryHubPullResult's encoded limit", () =>
  Effect.sync(() => {
    const pull = (padding: number) => ({
      highWatermark: 1,
      throughSequence: 1,
      hasMore: false,
      entries: [],
      checkpoint: {
        memorySpaceId: space,
        checkpointSequence: 1,
        retentionFloor: 0,
        causalBoundary: { checkpointSequence: 1, boundaryId: "boundary" },
        pageOrdinal: 0,
        items: [],
        revisions: [],
        tombstones: [],
        conflicts: [],
        resolutions: [],
        compactReceipts: [],
        identities: [
          {
            memorySpaceId: space,
            memoryId: id(2),
            scope: { kind: "user" },
            creatingEnvironmentId: "e".repeat(padding),
            createOperationId: id(3),
            createdAtUtc: now,
          },
        ],
        fences: [],
        suppressions: [],
        importLineage: [],
        nextCursor: null,
        bootstrapComplete: true,
      },
    });
    const fits = CHECKPOINT_PULL_MAX_BYTES - utf8(JSON.stringify(pull(0)));
    assert.isTrue(Exit.isSuccess(decodePull(pull(fits))));
    assert.isTrue(Exit.isFailure(decodePull(pull(fits + 1))));
    assert.isTrue(Exit.isSuccess(decodePull({ ...pull(fits), derivedCap: 1000 })));
    assert.isTrue(Exit.isFailure(decodePull({ ...pull(fits + 1), derivedCap: 1000 })));
  }),
);

it.effect(
  "an upgraded member installs a previously published checkpoint at the envelope limit",
  () =>
    Effect.gen(function* () {
      yield* HubKit.seed;
      const hub = yield* MemoryHubService;
      const compactor = yield* MemoryCompactor;
      const sql = yield* SqlClient.SqlClient;
      const features = M.MEMORY_FLOOR_2;
      const member = HubKit.principal(HubKit.otherEnv);
      const request = {
        protocolVersion: 1 as const,
        memorySpaceId: space,
        environmentId: HubKit.otherEnv,
      };
      const encodePull = Schema.encodeSync(Schema.fromJsonString(M.MemoryHubPullResult));
      const original = HubKit.operation(71);
      const receipt = (yield* hub.push(HubKit.pushInput(original), HubKit.principal())).receipts[0];
      if (!receipt?.hubSequence) throw new Error("Expected an accepted operation");
      yield* compactor.compact(HubKit.principal());
      const joined = yield* hub.join(request, member);
      const pull = {
        ...HubKit.pullInput,
        environmentId: request.environmentId,
        afterSequence: joined.checkpointSequence,
        snapshotToken: joined.snapshotToken,
      };
      const old = yield* hub.pull(pull, member);
      if (!old.checkpoint?.bootstrapComplete) throw new Error("Expected a single published page");
      const base = old.checkpoint;
      const rejected = (length: number): M.MemoryCompactReceipt => ({
        memorySpaceId: space,
        originEnvironmentId: M.EnvironmentId.make("e".repeat(length)),
        operationKind: "upsert",
        receipt: {
          ...receipt,
          operationId: M.MemoryOperationId.make(id(72)),
          outcome: "rejected",
          failureCode: "revision_changed",
        },
        revisionId: null,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      const padded = (length: number) => ({
        ...base,
        compactReceipts: [...base.compactReceipts, rejected(length)],
      });
      const width =
        CHECKPOINT_PULL_MAX_BYTES - utf8(encodePull({ ...old, checkpoint: padded(1) })) + 1;
      yield* sql`UPDATE memory_inbox_pending SET metadata_json=${JSON.stringify(padded(width))}
      WHERE space=${space} AND reason='hub_snapshot'`;
      const legacy = yield* hub.pull(pull, member);
      assert.strictEqual(utf8(encodePull(legacy)), CHECKPOINT_PULL_MAX_BYTES);

      yield* hub.pull(
        { ...HubKit.pullInput, afterSequence: joined.checkpointSequence, features },
        HubKit.principal(),
      );
      const activated = yield* hub.pull({ ...pull, features }, member);
      const decoded = decodePull(JSON.parse(encodePull(activated)));
      if (!Exit.isSuccess(decoded)) throw new Error("Expected a valid upgraded envelope");
      const { checkpoint, derivedCap } = decoded.value;
      assert.strictEqual(derivedCap, 1000);
      if (!checkpoint?.bootstrapComplete) throw new Error("Expected a complete upgraded page");
      yield* Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const stage = {
          memorySpaceId: space,
          hubEnvironmentId: HubKit.hubEnv,
          checkpointId: `hub:${joined.snapshotToken}`,
          expectedSnapshotToken: joined.snapshotToken,
          expectedCheckpointSequence: joined.checkpointSequence,
        };
        yield* store.transact(
          store.advanceBootstrapTx({
            ...stage,
            expectedState: "unbound",
            nextState: "staging",
            snapshotToken: joined.snapshotToken,
            checkpointSequence: joined.checkpointSequence,
            nextCursor: null,
          }),
        );
        yield* store.installCheckpointPage({ ...stage, page: checkpoint });
        yield* store.completeCheckpoint({ ...stage, pageCount: 1 });
        assert.strictEqual((yield* store.readBootstrap(stage)).state, "ready");
      }).pipe(Effect.provide(Layer.fresh(HubKit.coreFor(HubKit.otherEnv))));
    }).pipe(Effect.provide(HubKit.live)),
);

it.effect(
  "invariant: the bound covers every encoded snapshot and no forget grows it, across random upserts and forgets",
  () =>
    Effect.gen(function* () {
      yield* join;
      let seed = 0x5eed;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const alphabet = ["a", " ", '"', "\\", "\u0000", "한", "😀"];
      const live = new Map<number, { head: string; messages: string[] }>();
      let next = 0;
      for (let step = 0; step < 90; step++) {
        const forgetting = live.size > 0 && random() < 0.3;
        if (forgetting) {
          const keys = [...live.keys()];
          const memory = keys[Math.floor(random() * keys.length)]!;
          const before = (yield* usage).requiredCheckpointBoundBytes;
          yield* admit(forget(memory, 500_000 + step, live.get(memory)!.messages));
          live.delete(memory);
          assert.isAtMost((yield* usage).requiredCheckpointBoundBytes, before, `forget at ${step}`);
        } else {
          const keys = [...live.keys()];
          const memory =
            keys.length && random() < 0.4
              ? keys[Math.floor(random() * keys.length)]!
              : 20_000 + next++;
          const previous = live.get(memory);
          const messages = Array.from(
            { length: Math.floor(random() * 6) },
            (_, n) => `message-${step}-${n}`,
          );
          const text = Array.from(
            { length: Math.floor(random() * 3000) },
            () => alphabet[Math.floor(random() * alphabet.length)]!,
          ).join("");
          const op = upsert({
            memory,
            operation: 300_000 + step,
            text,
            messages,
            ...(previous ? { parent: previous.head } : {}),
          });
          yield* admit(op);
          if (op.kind === "upsert")
            live.set(memory, {
              head: op.revision.revisionId,
              messages: [...new Set([...(previous?.messages ?? []), ...messages])].slice(0, 100),
            });
        }
        const after = yield* snapshot(`step-${step}`);
        assert.isAtMost(
          after.lastSnapshotBytes,
          after.requiredCheckpointBoundBytes,
          `step ${step}`,
        );
      }
    }).pipe(Effect.provide(layer)),
);

/** Fills checkpoint staging to its limit with a pinned publication, as a busy hub would. */
const fillStaging = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const current = (yield* usage).stagingBytes;
  yield* sql`INSERT INTO memory_hub_retention(space) VALUES (${space}) ON CONFLICT(space) DO NOTHING`;
  yield* sql`UPDATE memory_hub_retention SET published_pinned_bytes=published_pinned_bytes+${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - current} WHERE space=${space}`;
  assert.strictEqual((yield* usage).stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
});
const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, n) => `${prefix}-${n}`);

it.effect(
  "regression: at full staging a base deletion lands and later forgets of the identity are budgeted",
  () =>
    Effect.gen(function* () {
      yield* join;
      yield* admit(upsert({ memory: 40, operation: 41, text: "a", messages: ["a-0"] }));
      yield* admit(upsert({ memory: 50, operation: 51, text: "b", messages: ["b-0"] }));
      yield* fillStaging;
      const keys = Array.from({ length: 99 }, (_, n) => ({
        environmentId: env,
        sourceId: M.MemoryImportSourceId.make(id(60)),
        sourceItemKey: `${"k".repeat(480)}${n}`,
      }));
      const withKeys = (op: M.MemoryOperation) =>
        op.kind === "forget"
          ? { ...op, tombstone: { ...op.tombstone, suppressedSourceKeys: keys } }
          : op;
      // A member may send more than the hub reserved; the deletion itself still wins.
      yield* admit(withKeys(forget(40, 42, ["a-0"])));
      yield* fillStaging;
      for (const later of [withKeys(forget(40, 43, [])), forget(40, 44, [])]) {
        const refused = yield* admit(later).pipe(Effect.flip);
        assert.deepInclude(refused, {
          _tag: "MemoryCapacityError",
          dimension: "checkpoint_staging",
        });
      }
      const before = (yield* usage).requiredCheckpointBoundBytes;
      yield* admit(forget(50, 52, ["b-0"]));
      assert.isAtMost((yield* usage).requiredCheckpointBoundBytes, before);
    }).pipe(Effect.provide(layer)),
);

it.effect("regression: deleting later evidence stays within the reserved bound", () =>
  Effect.gen(function* () {
    yield* join;
    const first = upsert({ memory: 70, operation: 71, text: "no evidence yet", messages: [] });
    yield* admit(first);
    if (first.kind !== "upsert") throw new Error("fixture kind");
    const evidence = messages("later", 100);
    yield* admit(
      upsert({
        memory: 70,
        operation: 72,
        text: "now with evidence",
        messages: evidence,
        parent: first.revision.revisionId,
      }),
    );
    const before = (yield* usage).requiredCheckpointBoundBytes;
    yield* admit(forget(70, 73, evidence));
    assert.isAtMost((yield* usage).requiredCheckpointBoundBytes, before);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "contract: hub membership refuses an environment id the forget allowance cannot cover",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const environmentId = M.EnvironmentId.make("e".repeat(M.MEMORY_IDENTITY_CORE_MAX_BYTES));
      const requestId = M.MemoryOperationId.make(id(80));
      const requestDigest = "b".repeat(64);
      yield* store.transact(
        store.writeHubAdminTx({
          record: {
            requestId,
            requestDigest,
            expectedVersion: 1,
            stage: "prepared",
            action: { requestId, expectedVersion: 1, action: "provisionMember", environmentId },
            secretName: "synthetic-member-key",
            result: null,
            memberVersion: null,
          },
          expectedStage: null,
        }),
      );
      const refused = yield* store
        .transact(
          store.activateHubMemberTx({
            requestId,
            requestDigest,
            memorySpaceId: space,
            environmentId,
            expectedCredentialVersion: null,
            next: { credentialDigest: "a".repeat(64) },
            now: 100,
          }),
        )
        .pipe(Effect.flip);
      assert.deepInclude(refused, { _tag: "MemoryStoreConflict", code: "payload_too_large" });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "regression: an existing member with a long environment id is charged for its deletions",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* join;
      const legacy = "L".repeat(8192);
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${legacy},${"c".repeat(64)},1,'active')`;
      yield* admit(upsert({ memory: 90, operation: 91, text: "small", messages: [] }));
      const before = (yield* usage).requiredCheckpointBoundBytes;
      yield* admit(forget(90, 92, [], legacy));
      assert.isAtMost((yield* usage).requiredCheckpointBoundBytes, before);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "regression: quota admission charges but never refuses a hub first delete beyond its reservation",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      yield* join;
      yield* admit(
        upsert({ memory: 95, operation: 96, text: "hub copy without evidence", messages: [] }),
      );
      const scope = { kind: "thread" as const, thread };
      const used = (yield* store.usage(space, scope)).permanentBytes;
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'usage_key_bytes','',${M.MEMORY_PERMANENT_METADATA_MAX_BYTES - used}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`;
      assert.strictEqual(
        (yield* store.usage(space, scope)).permanentBytes,
        M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
      );
      // The member reserved evidence from a revision this hub never received.
      const op = forget(95, 97, ["member-only"]);
      const decided = decideMemoryOperation(
        yield* store.loadAggregate(space, op.memoryId),
        op,
        Store.hubAdmission,
        scanMemoryValue(op),
      );
      const outcome = yield* quota.commit(
        {
          ...decided,
          receipt: {
            operationId: op.operationId,
            memoryId: op.memoryId,
            operationDigest: memoryOperationDigest(op),
            outcome: "deleted",
            hubSequence: 1,
          },
        },
        env,
        Effect.void,
      );
      assert.strictEqual(outcome.receipt.outcome, "deleted");
      assert.isDefined((yield* store.loadAggregate(space, op.memoryId)).tombstone);
    }).pipe(Effect.provide(Quota.layer.pipe(Layer.provideMerge(layer)))),
);

it.effect(
  "regression: a pushed first delete lands with its lease invalidation at full staging",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* HubKit.seed;
      const { hub, claim } = yield* HubKit.conflict;
      // A token about to gain a digit makes the invalidation itself grow the snapshot.
      yield* sql`UPDATE memory_identity_ledger SET fence_json=json_set(fence_json,'$.highestFencingToken',8) WHERE space=${HubKit.space} AND memory_id=${HubKit.memoryId}`;
      assert.strictEqual((yield* hub.claim(claim, HubKit.principal())).fencingToken, 9);
      yield* fillStaging;
      const op = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: HubKit.space,
        memoryId: HubKit.memoryId,
        operationId: HubKit.id(60),
        originEnvironmentId: HubKit.hubEnv,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: HubKit.space,
          memoryId: HubKit.memoryId,
          deleteOperationId: HubKit.id(60),
          deletingEnvironmentId: HubKit.hubEnv,
          deletedAtUtc: now,
          suppressedSourceKeys: Array.from({ length: 99 }, (_, n) => ({
            environmentId: HubKit.hubEnv,
            sourceId: HubKit.id(61),
            sourceItemKey: `${"k".repeat(480)}${n}`,
          })),
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      const result = yield* hub.push(HubKit.pushInput(op), HubKit.principal());
      assert.strictEqual(result.receipts[0]?.outcome, "deleted");
    }).pipe(Effect.provide(HubKit.live)),
);

const encodePayload = Schema.encodeSync(Schema.fromJsonString(M.MemoryPayload));
const encodePush = Schema.encodeSync(Schema.fromJsonString(M.MemoryHubPushInput));
const decodeCheckpointPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(M.MemoryHubCheckpointPage),
);

it.effect("packs a maximal-body 1000-source save in a push, tail, and real checkpoint", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* join;
    yield* sql`INSERT INTO memory_space_features VALUES (${space},1000,0)`;
    const base = upsert({ memory: 9000, operation: 9001, text: "synthetic", messages: [] });
    if (base.kind !== "upsert") throw new Error("expected fixture upsert");
    const sourceWatermark = {
      fromEventId: M.EventId.make("from-" + "f".repeat(507)),
      toEventId: M.EventId.make("to-" + "t".repeat(509)),
      throughSequence: Number.MAX_SAFE_INTEGER,
    };
    const payload = {
      text: "z".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES),
      evidence: [
        {
          origin: "thread" as const,
          sourceThread: thread,
          watermark: sourceWatermark,
          messageIds: [],
        },
      ],
      derivedFromMemoryRevisions: Array.from({ length: 1000 }, (_, n) =>
        M.MemoryRevisionId.make(id(10000 + n)),
      ),
    };
    const operation = { ...base, payload };
    const payloadBytes = utf8(encodePayload(payload));
    const pushBytes = utf8(
      encodePush({
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: env,
        operations: [operation],
      }),
    );
    const tailBytes = yield* requireMemoryTailFit(operation);
    assert.isAtMost(payloadBytes, M.MEMORY_PAYLOAD_MAX_UTF8_BYTES);
    assert.isAtMost(pushBytes, 256 * 1024);
    assert.isAtMost(tailBytes, M.MEMORY_TAIL_ADMISSION_BYTES);
    const resolutionId = M.MemoryResolutionId.make(id(9100));
    const heads = payload.derivedFromMemoryRevisions.slice(0, 2);
    const appliedAtUtc = operation.revision.createdAtUtc;
    const revertDeadlineUtc = M.MemoryUtcTimestamp.make(
      DateTime.formatIso(DateTime.makeUnsafe(Date.parse(appliedAtUtc) + M.MEMORY_REVERT_WINDOW_MS)),
    );
    const variants: M.MemoryRevisionOperation[] = [
      operation,
      {
        ...operation,
        kind: "revert",
        expectedHeads: heads.slice(0, 1),
        revision: { ...operation.revision, parents: heads.slice(0, 1) },
        revertsResolutionId: resolutionId,
        restoredRevisionId: payload.derivedFromMemoryRevisions[2]!,
      },
      {
        ...operation,
        kind: "resolve",
        expectedHeads: heads,
        revision: { ...operation.revision, parents: heads },
        conflictId: M.MemoryConflictId.make(id(9101)),
        fencingToken: 1,
        resolution: {
          resolutionId,
          memorySpaceId: space,
          memoryId: operation.memoryId,
          inputRevisionIds: heads,
          inputPayloadRefs: heads,
          judgmentRef: resolutionId,
          requestedModelSelection: {
            instanceId: M.ProviderInstanceId.make("codex"),
            model: "fixture",
          },
          effectiveProvider: M.ProviderDriverKind.make("codex"),
          effectiveModel: "fixture",
          resolvingEnvironmentId: env,
          fencingToken: 1,
          resultRevisionId: operation.revision.revisionId,
          appliedAtUtc,
          revertDeadlineUtc,
        },
        resolutionPayload: { resolutionId, judgment: "synthetic judgment" },
      },
    ];
    for (const variant of variants) {
      const size = yield* requireMemoryTailFit(variant);
      const atSize = (extra: number) => ({
        ...variant,
        payload: {
          ...variant.payload,
          evidence: [
            {
              ...payload.evidence[0]!,
              watermark: {
                ...sourceWatermark,
                fromEventId: M.EventId.make(
                  sourceWatermark.fromEventId +
                    "e".repeat(M.MEMORY_TAIL_ADMISSION_BYTES - size + extra),
                ),
              },
            },
          ],
        },
      });
      assert.strictEqual(
        yield* requireMemoryTailFit(atSize(0)),
        M.MEMORY_TAIL_ADMISSION_BYTES,
        variant.kind,
      );
      const tooWide = yield* Effect.flip(requireMemoryTailFit(atSize(1)));
      assert.strictEqual(tooWide.dimension, "payload_bytes", variant.kind);
      assert.strictEqual(tooWide.current, M.MEMORY_TAIL_ADMISSION_BYTES + 1, variant.kind);
    }
    yield* admit(operation);
    const tail = yield* store.transact(
      store.readHubTailTx({
        memorySpaceId: space,
        afterSequence: 0,
        highWatermark: null,
        limit: 100,
        maxBytes: M.MEMORY_PAGE_MAX_UTF8_BYTES,
      }),
    );
    assert.lengthOf(tail.entries, 1);
    yield* snapshot("wide-save");
    const persisted = (yield* sql<{ body_bytes: number; dependency_bytes: number }>`
      SELECT length(CAST(body_json AS BLOB)) AS body_bytes, length(CAST(dependencies_json AS BLOB)) AS dependency_bytes
      FROM memory_payloads WHERE space=${space} AND memory_id=${operation.memoryId}`)[0]!;
    const counters = yield* store.counters(space);
    assert.strictEqual(
      counters.find((r) => r.dimension === "usage_payload_bytes")?.value,
      persisted.body_bytes,
    );
    assert.strictEqual(
      counters.find((r) => r.dimension === "usage_dependency_bytes")?.value,
      persisted.dependency_bytes,
    );
    const pages = yield* sql<{
      metadata_json: string;
    }>`SELECT metadata_json FROM memory_inbox_pending
      WHERE space=${space} AND reason='hub_snapshot' ORDER BY page_ordinal`;
    assert.lengthOf(pages, 1);
    const serialized = pages[0]!.metadata_json;
    const checkpoint = decodeCheckpointPage(serialized);
    assert.deepStrictEqual(
      checkpoint.revisions[0]?.payload?.derivedFromMemoryRevisions,
      payload.derivedFromMemoryRevisions,
    );
    assert.isAtMost(utf8(serialized), CHECKPOINT_PULL_MAX_BYTES);
    const time = M.MEMORY_LOG_RETENTION_MS;
    const authority: Store.HubAuthority = {
      principal: {
        memorySpaceId: space,
        environmentId: env,
        credentialVersion: 1,
        scopes: ["memory:sync"],
      },
      now: Effect.succeed(time),
      reauthorize: Effect.void,
    };
    const handle = yield* store.transact(
      store.prepareHubCheckpointTx({
        authority,
        checkpointId: "wide-save",
        snapshotToken: "wide-save-token",
        hubEnvironmentId: env,
      }),
    );
    yield* store.transact(
      store.publishCheckpointAndFloorTx({
        memorySpaceId: space,
        checkpointId: handle.checkpointId,
        expectedFloor: 0,
        nextFloor: handle.checkpointSequence,
        now: time,
      }),
    );
    const compacted = yield* store.transact(
      store.compactEligibleHistoryTx({
        memorySpaceId: space,
        expectedFloor: handle.checkpointSequence,
        now: time,
        limit: 10,
      }),
    );
    assert.isAbove(compacted.removedRows, 0);
    const pinned = yield* store.transact(
      store.readHubCheckpointPageTx({
        authority,
        snapshotToken: handle.snapshotToken,
        cursor: null,
      }),
    );
    assert.deepStrictEqual(pinned.revisions[0]?.payload, payload);
    yield* Effect.logInfo("wide memory bytes", {
      payloadBytes,
      pushBytes,
      tailBytes,
      checkpointBytes: utf8(serialized),
      ...persisted,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([1, 101])("bootstrap forget redacts a dependent with %s sources", (count) =>
  Effect.gen(function* () {
    yield* join;
    const sql = yield* SqlClient.SqlClient;
    const sources: M.MemoryRevisionId[] = [];
    for (let n = 12000; n < 12000 + count; n++) {
      const source = upsert({
        memory: n,
        operation: n,
        text: `synthetic source ${n}`,
        messages: [],
      });
      if (source.kind !== "upsert") throw new Error("expected source upsert");
      yield* admit(source);
      sources.push(source.revision.revisionId);
    }
    const target = upsert({
      memory: 13000,
      operation: 13000,
      text: "synthetic dependent",
      messages: [],
    });
    if (target.kind !== "upsert") throw new Error("expected dependent upsert");
    yield* admit({
      ...target,
      payload: { ...target.payload, derivedFromMemoryRevisions: sources },
    });
    yield* snapshot("bootstrap-forget");
    const rows = yield* sql<{
      metadata_json: string;
    }>`SELECT metadata_json FROM memory_inbox_pending
      WHERE space=${space} AND reason='hub_snapshot' ORDER BY page_ordinal`;
    const pages = rows.map((row) => decodeCheckpointPage(row.metadata_json));
    const first = pages[0]!;
    const stage = {
      memorySpaceId: space,
      hubEnvironmentId: env,
      checkpointId: "fixture-bootstrap",
      expectedSnapshotToken: "fixture-snapshot",
      expectedCheckpointSequence: first.checkpointSequence,
    };
    yield* Effect.gen(function* () {
      const member = yield* Store.MemoryStore;
      const memberSql = yield* SqlClient.SqlClient;
      yield* member.transact(
        member.advanceBootstrapTx({
          ...stage,
          expectedState: "unbound",
          nextState: "staging",
          snapshotToken: stage.expectedSnapshotToken,
          checkpointSequence: first.checkpointSequence,
          nextCursor: null,
        }),
      );
      for (const page of pages) yield* member.installCheckpointPage({ ...stage, page });
      const bodies = memberSql`SELECT payload_ref FROM memory_payloads WHERE space=${space} AND memory_id=${target.memoryId}`;
      assert.lengthOf(yield* bodies, 1);
      const removal = forget(11999 + count, 13001, []);
      const decision = decideMemoryOperation(
        yield* member.loadAggregate(space, removal.memoryId),
        removal,
        Store.localIntent,
        scanMemoryValue(removal),
      );
      yield* member.apply(decision);
      yield* member.completeCheckpoint({ ...stage, pageCount: pages.length });
      assert.lengthOf(yield* bodies, 0);
      assert.strictEqual(
        (yield* member.loadAggregate(space, target.memoryId)).item?.status,
        "blocked",
      );
    }).pipe(Effect.provide(Layer.fresh(layer)));
  }).pipe(Effect.provide(layer)),
);
