import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { registerCredentialRunTag } from "../mcp/goatCredentialRedaction.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(10));
const environmentId = M.EnvironmentId.make("fixture");
const revisionId = (n: number) => M.MemoryRevisionId.make(id(30000 + n));
const sourceThread = { environmentId, threadId: "thread" };
const sourceWatermark = { fromEventId: id(100), toEventId: id(101), throughSequence: 1 };
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const live = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);

const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const isConflict = Schema.is(Store.MemoryStoreConflict);
/** One link of a single-memory chain; `source` revisions carry thread evidence. */
const operation = (n: number, source = false) => {
  const op = decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(20000 + n),
    originEnvironmentId: environmentId,
    expectedHeads: n > 0 ? [revisionId(n - 1)] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: revisionId(n),
      operationId: id(20000 + n),
      parents: n > 0 ? [revisionId(n - 1)] : [],
      scope: { kind: "user" },
      payloadRef: revisionId(n),
      assertionKind: "inference",
      provenance: source ? { environmentId, sourceThread, sourceWatermark } : { environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: `revision ${n}`,
      evidence: source
        ? [
            {
              origin: "thread",
              sourceThread,
              watermark: sourceWatermark,
              messageIds: [`message-${n}`],
            },
          ]
        : [],
      derivedFromMemoryRevisions: [],
    },
  });
  if (op.kind !== "upsert") throw new Error("Fixture kind");
  return op;
};
const approval = (op: M.MemoryOperation, n: number): M.MemoryHubReceipt => ({
  operationId: op.operationId,
  memoryId: op.memoryId,
  operationDigest: memoryOperationDigest(op),
  outcome: op.kind === "forget" ? "deleted" : "accepted",
  hubSequence: n + 1,
  ...(op.kind === "resolve"
    ? {
        resolutionApproval: {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: op.resolution.appliedAtUtc,
          revertDeadlineUtc: op.resolution.revertDeadlineUtc,
        },
      }
    : {}),
});
const receive = (op: M.MemoryOperation, n: number) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    return yield* service.applyReceived(op, approval(op, n));
  });
const chain = (count: number, source: (n: number) => boolean = () => false) =>
  Effect.forEach(
    Array.from({ length: count }, (_, n) => n),
    (n) => receive(operation(n, source(n)), n),
    {
      discard: true,
    },
  );
/** Valid JSON that no payload codec accepts, so any decode of these rows fails. */
const corruptPayloads = (keep: ReadonlyArray<M.MemoryRevisionId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE memory_payloads SET body_json='{"invalid":true}' WHERE space=${space} AND payload_ref IN (
      SELECT payload_ref FROM memory_revisions WHERE space=${space} AND memory_id=${memory} AND revision_id NOT IN ${sql.in(keep)})`;
  });

const modelSelection: M.MemoryModelSelection = {
  instanceId: M.ProviderInstanceId.make("fixture"),
  model: "fixture-model",
};
const resolution = (n: number): M.MemoryResolution => ({
  resolutionId: M.MemoryResolutionId.make(id(50000 + n)),
  memorySpaceId: space,
  memoryId: memory,
  inputRevisionIds: [revisionId(0), revisionId(1)],
  inputPayloadRefs: [revisionId(0), revisionId(1)],
  judgmentRef: M.MemoryResolutionId.make(id(50000 + n)),
  requestedModelSelection: modelSelection,
  effectiveProvider: M.ProviderDriverKind.make("codex"),
  effectiveModel: modelSelection.model,
  resolvingEnvironmentId: environmentId,
  fencingToken: 1,
  resultRevisionId: revisionId(1000 + n),
  appliedAtUtc: "2026-10-14T00:00:00.000Z",
  revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
});
/** Old resolved rows have no bearing on the current frontier. */
const historicalRows = (count: number, corrupt?: "conflict" | "resolution") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let n = 0; n < count; n++) {
      const r = {
        ...resolution(n),
        appliedAtUtc: "2026-01-14T00:00:00.000Z",
        revertDeadlineUtc: "2026-02-13T00:00:00.000Z",
      };
      yield* sql`INSERT INTO memory_conflicts(space,conflict_id,memory_id,heads_json,status)
        VALUES (${space},${id(70000 + n)},${memory},${corrupt === "conflict" ? '["invalid"]' : JSON.stringify(r.inputRevisionIds)},'resolved')`;
      yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json)
        VALUES (${space},${r.resolutionId},${memory},${JSON.stringify(r.inputRevisionIds)},${JSON.stringify(r.inputPayloadRefs)},${r.judgmentRef},${JSON.stringify(modelSelection)},'{}',${environmentId},1,${r.resultRevisionId},${Date.parse(r.appliedAtUtc)},${Date.parse(r.revertDeadlineUtc)},${corrupt === "resolution" ? "{}" : JSON.stringify(r)})`;
    }
  });

describe("memory admission history reads", () => {
  it.effect.each(["conflict", "resolution"] as const)(
    "writes and forgets without decoding unused historical %s rows",
    (kind) =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const service = yield* Service.MemoryService;
        yield* TestClock.setTime(Date.parse("2026-10-19T00:00:00.000Z"));
        yield* chain(6);
        yield* historicalRows(24, kind);
        const full = yield* store.loadAggregate(space, memory).pipe(Effect.flip);
        assert.instanceOf(full, Store.MemoryStorageError);
        assert.strictEqual(full.stage, `${kind}-codec`);
        const selected = yield* store
          .loadAggregate(
            space,
            memory,
            {},
            kind === "conflict"
              ? { conflictId: M.MemoryConflictId.make(id(70000)) }
              : { resolutionId: resolution(0).resolutionId },
          )
          .pipe(Effect.flip);
        assert.strictEqual(selected.stage, `${kind}-codec`);

        assert.strictEqual((yield* receive(operation(6), 6)).receipt.outcome, "accepted");
        const written = yield* service.upsert(
          {
            memorySpaceId: space,
            memoryId: memory,
            operationId: M.MemoryOperationId.make(id(21000)),
            expectedHeads: [revisionId(6)],
            scope: { kind: "user" },
            assertionKind: "inference",
            payload: { text: "next local write", evidence: [], derivedFromMemoryRevisions: [] },
            baseBoundary: null,
          },
          Effect.void,
        );
        assert.strictEqual(written.receipt.outcome, "accepted");
        assert.strictEqual(
          (yield* service.forget(
            {
              memorySpaceId: space,
              memoryId: memory,
              operationId: M.MemoryOperationId.make(id(21001)),
              expectedHeads: (yield* store.loadAggregate(space, memory, {}, {})).heads,
            },
            Effect.void,
          )).receipt.outcome,
          "deleted",
        );
      }).pipe(Effect.provide(live)),
  );

  it.effect("bounds history reads to the selected IDs while preserving full history", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-10-19T00:00:00.000Z"));
      yield* chain(6);
      yield* historicalRows(48);
      const full = yield* store.loadAggregate(space, memory);
      assert.lengthOf(full.conflicts, 48);
      assert.lengthOf(full.resolutions, 48);
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const omitted = yield* store
        .loadAggregate(space, memory, {}, {})
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.deepStrictEqual(omitted.conflicts, []);
      assert.deepStrictEqual(omitted.resolutions, []);
      assert.isFalse(queries.some(([query]) => /FROM memory_(conflicts|resolutions)/.test(query)));
      const wanted = {
        conflictId: full.conflicts[3]!.conflictId,
        resolutionId: full.resolutions[4]!.resolutionId,
      };
      const selected = yield* store
        .loadAggregate(space, memory, {}, wanted)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.deepStrictEqual(selected.conflicts, [full.conflicts[3]!]);
      assert.deepStrictEqual(selected.resolutions, [full.resolutions[4]!]);
      const reads = queries.filter(([query]) => /FROM memory_(conflicts|resolutions)/.test(query));
      assert.lengthOf(reads, 2);
      for (const [query, params] of reads) assert.lengthOf(yield* sql.unsafe(query, params), 1);
      const other = yield* store.loadAggregate(space, M.MemoryId.make(id(11)), {}, wanted);
      assert.deepStrictEqual(other.conflicts, []);
      assert.deepStrictEqual(other.resolutions, []);
      assert.deepStrictEqual(
        (yield* store.loadAggregate(space, memory)).resolutions,
        full.resolutions,
      );
      const service = yield* Service.MemoryService;
      const history: M.MemoryResolution[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* service.history(
          { memorySpaceId: space, memoryId: memory, limit: 17, ...(cursor ? { cursor } : {}) },
          Effect.void,
        );
        history.push(...page.resolutions.map((pair) => pair.resolution));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepStrictEqual(history, full.resolutions);
    }).pipe(Effect.provide(live)),
  );

  it.effect("keeps selected and full admission decisions byte-for-byte equal", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const now = Date.parse("2026-10-14T00:00:01.000Z");
      yield* TestClock.setTime(now);
      yield* chain(6, (n) => n === 1);
      yield* historicalRows(24);
      const compare = Effect.fnUntraced(function* (
        op: M.MemoryOperation,
        admission: Store.MemoryAdmissionContext,
        expected: string,
        at = now,
        ancestry?: Store.MemoryAncestry,
      ) {
        const full = yield* store.loadAggregate(space, memory);
        const selected = yield* store.loadAggregate(
          space,
          memory,
          op.kind === "forget"
            ? {}
            : { heads: true, revisionIds: op.kind === "revert" ? [op.restoredRevisionId] : [] },
          op.kind === "forget"
            ? {}
            : {
                ...(op.kind === "revert" ? { resolutionId: op.revertsResolutionId } : {}),
                revision: op.revision,
                ...(op.kind === "resolve"
                  ? { metadataRevisionIds: op.resolution.inputRevisionIds }
                  : {}),
              },
        );
        const selectedIds = new Set(selected.revisions.map((pair) => pair.revision.revisionId));
        assert.deepStrictEqual(
          selected.revisions.map((pair) => pair.revision),
          full.revisions
            .filter((pair) => selectedIds.has(pair.revision.revisionId))
            .map((pair) => pair.revision),
        );
        const decide = (aggregate: Store.MemoryAggregate) => {
          try {
            return decideMemoryOperation(
              aggregate,
              op,
              admission,
              { kind: "allowed" },
              admission.kind === "approvedReplica" ? approval(op, 100) : undefined,
              ancestry,
              at,
            );
          } catch (cause) {
            if (isConflict(cause)) return { failure: cause.code };
            throw cause;
          }
        };
        const original = decide(full);
        const actual = decide(selected);
        assert.deepStrictEqual(actual, original);
        assert.strictEqual(JSON.stringify(actual), JSON.stringify(original));
        assert.strictEqual("failure" in actual ? actual.failure : actual.receipt.outcome, expected);
      });
      for (const admission of [Store.localIntent, Store.hubAdmission, Store.approvedReplica])
        yield* compare(operation(6), admission, "accepted");
      yield* compare(operation(2), Store.approvedReplica, "accepted");
      const branch = {
        ...operation(6),
        expectedHeads: [revisionId(2)],
        revision: { ...operation(6).revision, parents: [revisionId(2)] },
      };
      yield* compare(branch, Store.localIntent, "revision_changed");
      yield* compare(branch, Store.approvedReplica, "accepted");
      const missing = {
        ...branch,
        expectedHeads: [revisionId(99)],
        revision: { ...branch.revision, parents: [revisionId(99)] },
      };
      yield* compare(missing, Store.approvedReplica, "accepted");
      yield* compare(missing, Store.hubAdmission, "base_compacted", now, {
        causalBoundary: { checkpointSequence: 10, boundaryId: "fixture" },
        retentionFloor: 10,
        parents: [
          {
            revisionId: revisionId(99),
            status: "compacted",
            boundary: { checkpointSequence: 10, boundaryId: "fixture" },
          },
        ],
      });
      yield* receive(branch, 6);
      const conflicted = yield* store.loadAggregate(space, memory);
      const conflict = conflicted.conflicts.find((c) => c.status !== "resolved")!;
      const merged: Extract<M.MemoryOperation, { kind: "resolve" }> = {
        ...operation(7),
        kind: "resolve",
        expectedHeads: conflicted.heads,
        revision: { ...operation(7).revision, parents: conflicted.heads },
        conflictId: conflict.conflictId,
        fencingToken: 1,
        resolution: {
          ...resolution(100),
          inputRevisionIds: conflicted.heads,
          inputPayloadRefs: conflicted.heads,
          resultRevisionId: revisionId(7),
        },
        resolutionPayload: {
          resolutionId: resolution(100).resolutionId,
          judgment: "merge the two branches",
        },
      };
      yield* compare(merged, Store.hubAdmission, "lease_required");
      const fence: M.MemoryFenceRecord = {
        memorySpaceId: space,
        memoryId: memory,
        highestFencingToken: 1,
        activeLease: {
          memorySpaceId: space,
          memoryId: memory,
          conflictId: conflict.conflictId,
          conflictHeadSet: conflicted.heads,
          holderEnvironmentId: environmentId,
          attemptId: M.MemoryOperationId.make(id(80000)),
          frozenDefaultModelSelection: modelSelection,
          fencingToken: 1,
          claimedAtHubTime: "2026-10-14T00:00:00.000Z",
          expiresAtHubTime: "2026-10-14T00:01:00.000Z",
          attemptDeadlineHubTime: "2026-10-14T00:02:00.000Z",
        },
      };
      yield* sql`UPDATE memory_identity_ledger SET fence_json=${JSON.stringify(fence)} WHERE space=${space} AND memory_id=${memory}`;
      yield* compare(merged, Store.hubAdmission, "accepted");
      yield* compare(merged, Store.approvedReplica, "accepted");
      yield* receive(merged, 7);
      const reverted: Extract<M.MemoryOperation, { kind: "revert" }> = {
        ...operation(8),
        kind: "revert",
        payload: operation(5).payload,
        restoredRevisionId: revisionId(5),
        revertsResolutionId: merged.resolution.resolutionId,
      };
      yield* compare(reverted, Store.localIntent, "unsupported_operation");
      yield* compare(reverted, Store.hubAdmission, "accepted");
      yield* compare(reverted, Store.approvedReplica, "accepted");
      yield* compare(
        { ...reverted, payload: operation(4).payload },
        Store.hubAdmission,
        "revision_changed",
      );
      yield* compare(
        reverted,
        Store.hubAdmission,
        "revert_expired",
        Date.parse(merged.resolution.revertDeadlineUtc),
      );
      yield* compare(
        { ...reverted, revertsResolutionId: M.MemoryResolutionId.make(id(99999)) },
        Store.hubAdmission,
        "revision_changed",
      );
      yield* receive(reverted, 8);
      yield* compare(reverted, Store.hubAdmission, "revision_changed");
      const forgotten: Extract<M.MemoryOperation, { kind: "forget" }> = {
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(20009)),
        originEnvironmentId: environmentId,
        expectedHeads: [revisionId(8)],
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: M.MemoryOperationId.make(id(20009)),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: "2026-10-14T00:00:01.000Z",
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      };
      for (const admission of [Store.localIntent, Store.hubAdmission, Store.approvedReplica])
        yield* compare(forgotten, admission, "deleted");
      yield* receive(forgotten, 9);
      yield* compare(operation(9), Store.hubAdmission, "forgotten");
      yield* compare(operation(9), Store.approvedReplica, "accepted");
    }).pipe(Effect.provide(live)),
  );
});

describe("memory admission payload reads", () => {
  it.effect("receives the next revision of a long chain without decoding its history", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* chain(12);
      yield* corruptPayloads([revisionId(11)]);
      const full = yield* store.loadAggregate(space, memory).pipe(Effect.flip);
      assert.instanceOf(full, Store.MemoryStorageError);
      assert.strictEqual(full.stage, "payload-codec");

      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const received = yield* receive(operation(12), 12).pipe(
        Effect.provideService(Statement.CurrentTransformer, record),
      );
      assert.strictEqual(received.receipt.outcome, "accepted");
      assert.deepStrictEqual((yield* store.loadAggregate(space, memory, { heads: true })).heads, [
        revisionId(12),
      ]);
      // Every selected payload read binds the space plus at most one head reference.
      const payloadReads = queries.filter(([query]) =>
        query.includes("SELECT payload_ref,body_json FROM memory_payloads"),
      );
      assert.isAbove(payloadReads.length, 0);
      for (const [query, params] of payloadReads) {
        assert.isAtMost(params.length, 2);
        assert.isAtMost((yield* sql.unsafe(query, params)).length, 1);
      }
      const revisionReads = queries.filter(([query]) =>
        query.includes("SELECT r.*,NULL AS body_json FROM memory_revisions"),
      );
      assert.isAbove(revisionReads.length, 0);
      for (const [query, params] of revisionReads) {
        assert.isAtMost(params.length, 4);
        assert.isAtMost((yield* sql.unsafe(query, params)).length, 2);
      }
    }).pipe(Effect.provide(live)),
  );

  it.effect("keeps the full DAG and decodes exactly the selected payloads", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* chain(6, (n) => n % 2 === 0);
      const full = yield* store.loadAggregate(space, memory);
      const heads = yield* store.loadAggregate(space, memory, { heads: true });
      const sources = yield* store.loadAggregate(space, memory, {
        when: Store.hasSourceEvidence,
      });
      const listed = yield* store.loadAggregate(space, memory, {
        revisionIds: [revisionId(1)],
      });
      const rest = (aggregate: Store.MemoryAggregate) => ({ ...aggregate, revisions: [] });
      for (const [selected, keep] of [
        [
          heads,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            full.heads.includes(pair.revision.revisionId),
        ],
        [
          sources,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            Store.hasSourceEvidence(pair.revision),
        ],
        [
          listed,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            pair.revision.revisionId === revisionId(1),
        ],
      ] as const) {
        assert.deepStrictEqual(rest(selected), rest(full));
        assert.deepStrictEqual(
          selected.revisions.map((pair) => pair.revision),
          full.revisions.map((pair) => pair.revision),
        );
        assert.deepStrictEqual(
          selected.revisions.map((pair) => pair.payload),
          full.revisions.map((pair) => (keep(pair) ? pair.payload : null)),
        );
      }
      assert.isTrue(sources.revisions.some((pair) => pair.payload !== null));
    }).pipe(Effect.provide(live)),
  );

  it.effect(
    "counts non-head source evidence in the forget reservation without reading other history",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        yield* chain(6, (n) => n === 1);
        const before = yield* store.transact(store.firstForgetReservation(operation(6)));
        assert.isAtLeast(before.keys, 1);
        yield* corruptPayloads([revisionId(1), revisionId(5)]);
        assert.deepStrictEqual(
          yield* store.transact(store.firstForgetReservation(operation(6))),
          before,
        );
      }).pipe(Effect.provide(live)),
  );

  it.effect(
    "bounds admission revision metadata reads and widens to the full DAG when ancestry needs it",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* chain(24, () => false);

        const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        const record: Statement.Transformer = (statement) =>
          Effect.sync(() => {
            queries.push(statement.compile());
            return statement;
          });
        const received = yield* receive(operation(24, false), 24).pipe(
          Effect.provideService(Statement.CurrentTransformer, record),
        );
        assert.strictEqual(received.receipt.outcome, "accepted");
        const revisionReads = queries.filter(([query]) =>
          query.includes("SELECT r.*,NULL AS body_json FROM memory_revisions"),
        );
        assert.isAbove(revisionReads.length, 0);
        for (const [query, params] of revisionReads) {
          assert.isAtMost((yield* sql.unsafe(query, params)).length, 2);
        }
        const empty = yield* store.loadAggregate(space, memory, {}, {});
        assert.deepStrictEqual(empty.revisions, []);
        const headOnly = yield* store.loadAggregate(space, memory, { heads: true }, {});
        assert.deepStrictEqual(
          headOnly.revisions.map((pair) => pair.revision.revisionId),
          [revisionId(24)],
        );
        // Existing revision IDs or parked inbox operations still widen to the full DAG for cycle/frontier checks.
        const existing = yield* store.loadAggregate(
          space,
          memory,
          { heads: true },
          { revision: operation(24).revision },
        );
        assert.lengthOf(existing.revisions, 25);
        // A revision branching from an older revision, or an ancestor arriving after
        // its child, needs every link to prune heads exactly as the full read does.
        const branch = operation(25, false).revision;
        const fromOld = yield* store.loadAggregate(
          space,
          memory,
          { heads: true },
          { revision: { ...branch, parents: [revisionId(3)] } },
        );
        assert.lengthOf(fromOld.revisions, 25);
        yield* sql`DELETE FROM memory_revisions WHERE space=${space} AND memory_id=${memory} AND revision_id=${revisionId(5)}`;
        const lateAncestor = yield* store.loadAggregate(
          space,
          memory,
          { heads: true },
          { revision: { ...operation(5, false).revision, parents: [revisionId(24)] } },
        );
        assert.lengthOf(lateAncestor.revisions, 24);
      }).pipe(Effect.provide(live)),
  );
});

describe("memory credential redaction (#1297)", () => {
  // Synthetic canaries shaped like registry tokens; none is a real credential.
  const secret = "canaryMemoryToken".padEnd(43, "0");
  const text = `notes GOAT_MCP_BEARER_TOKEN=${secret} Bearer ${secret} ${"l01RetryTag".padEnd(51, "1")}`;
  const operationId = M.MemoryOperationId.make(id(22000));
  const write = (payloadText: string): M.MemoryUpsertInput => ({
    memorySpaceId: space,
    memoryId: memory,
    operationId,
    expectedHeads: [],
    scope: { kind: "user" },
    assertionKind: "inference",
    payload: { text: payloadText, evidence: [], derivedFromMemoryRevisions: [] },
    baseBoundary: null,
  });

  it.effect("stores and syncs a local write with its GOAT credentials redacted", () =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = yield* service.upsert(write(text), Effect.void);

      const stored = (yield* store.loadAggregate(space, memory)).revisions[0]?.payload;
      assert.include(stored?.text, "GOAT_MCP_BEARER_TOKEN=[redacted] Bearer [redacted]");
      assert.notInclude(stored?.text, secret);
      // The operation is what sync uploads, and its digest is over the redacted bytes.
      const sent = yield* store.readOperation(space, operationId);
      assert.notInclude(JSON.stringify(sent), secret);
      assert.strictEqual(first.operationDigest, sent && memoryOperationDigest(sent));

      // A retry is matched by what the caller sent, even after this process learns a run tag
      // that now redacts more of the same text.
      registerCredentialRunTag("l01RetryTag");
      assert.deepStrictEqual(yield* service.upsert(write(text), Effect.void), first);
      // Two requests that differ only in their credential are still different requests.
      const changed = text.replaceAll(secret, "differentToken".padEnd(43, "0"));
      const error = yield* service.upsert(write(changed), Effect.void).pipe(Effect.flip);
      assert.isTrue(isConflict(error) && error.code === "operation_id_reused");
    }).pipe(Effect.provide(live)),
  );

  it.effect("keeps a received operation's signed text as its author wrote it", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const base = operation(0);
      const received = { ...base, payload: { ...base.payload, text: `remote ${text}` } };
      assert.strictEqual((yield* receive(received, 0)).receipt.outcome, "accepted");
      const stored = yield* store.readOperation(space, received.operationId);
      assert.strictEqual(
        stored?.kind === "upsert" ? stored.payload.text : undefined,
        received.payload.text,
      );
    }).pipe(Effect.provide(live)),
  );
});
