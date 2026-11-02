import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/078_Memory.ts";
import hubMigration from "../persistence/Migrations/079_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/080_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/082_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/083_MemoryCheckpointAccounting.ts";
import reportMigration from "../persistence/Migrations/084_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/085_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/086_MemoryRevertResults.ts";
import readyMigration from "../persistence/Migrations/088_MemoryLastReadySpace.ts";
import adminMigration from "../persistence/Migrations/089_MemoryHubAdministered.ts";
import lifecycleMigration from "../persistence/Migrations/090_MemoryCheckpointLifecycle.ts";
import revisionSizeMigration from "../persistence/Migrations/095_MemoryRevisionCheckpointSize.ts";
import { CHECKPOINT_PULL_MAX_BYTES, FORGET_RECORDS_MAX_BYTES } from "./MemoryCheckpointBound.ts";
import { encodeCheckpointRecord } from "./MemoryCheckpointInventory.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
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
const forget = (memory: number, operation: number, messages: ReadonlyArray<string>) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(memory),
    operationId: id(operation),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "forget",
    tombstone: {
      memorySpaceId: space,
      memoryId: id(memory),
      deleteOperationId: id(operation),
      deletingEnvironmentId: env,
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
  }),
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
  yield* sql`INSERT INTO memory_hub_retention(space,published_pinned_bytes) VALUES (${space},${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - current}) ON CONFLICT(space) DO UPDATE SET published_pinned_bytes=published_pinned_bytes+excluded.published_pinned_bytes`;
  assert.strictEqual((yield* usage).stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
});
const messages = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, n) => `${prefix}-${n}`);

it.effect(
  "regression: at full staging a reserved deletion succeeds and unreserved suppressions are refused",
  () =>
    Effect.gen(function* () {
      yield* join;
      yield* admit(upsert({ memory: 40, operation: 41, text: "a", messages: ["a-0"] }));
      yield* admit(upsert({ memory: 50, operation: 51, text: "b", messages: ["b-0"] }));
      yield* fillStaging;
      const stuffed = forget(40, 42, ["a-0"]);
      if (stuffed.kind !== "forget") throw new Error("fixture kind");
      const extra = {
        ...stuffed,
        tombstone: {
          ...stuffed.tombstone,
          suppressedSourceKeys: Array.from({ length: 99 }, (_, n) => ({
            environmentId: env,
            sourceId: M.MemoryImportSourceId.make(id(60)),
            sourceItemKey: `${"k".repeat(480)}${n}`,
          })),
        },
      };
      const refused = yield* admit(extra).pipe(Effect.flip);
      assert.deepInclude(refused, { _tag: "MemoryCapacityError", dimension: "checkpoint_staging" });
      const before = (yield* usage).requiredCheckpointBoundBytes;
      yield* admit(forget(50, 52, ["b-0"]));
      assert.isAtMost((yield* usage).requiredCheckpointBoundBytes, before);
    }).pipe(Effect.provide(layer)),
);

it.effect("regression: evidence added by a later revision stays deletable at full staging", () =>
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
    yield* fillStaging;
    yield* admit(forget(70, 73, evidence));
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
