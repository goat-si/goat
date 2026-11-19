import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Compactor from "./MemoryCompactor.ts";
import { makePullMemoryTail } from "./MemoryPullTail.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import { scanReplicaMemory } from "./testkit/ScanReplicaMemory.ts";
import {
  core,
  coreFor,
  hubEnv,
  id,
  live,
  operation,
  otherEnv,
  principal,
  pullInput,
  pushInput,
  seed,
  space,
} from "./MemoryHubService.testkit.ts";

const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const isLegacyMoveInput = Schema.is(M.MemoryMoveInput);
const features = M.MEMORY_FLOOR_2;
const advertise = { ...pullInput, features };
const newMemory = (n: number) => {
  const op = operation(n);
  const memoryId = M.MemoryId.make(id(n + 30000));
  return { ...op, memoryId, revision: { ...op.revision, memoryId } };
};

describe("negotiated memory scope moves", () => {
  it.effect("looks up a move receipt without originating an unrecorded move", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      yield* hub.pull(advertise, principal());
      yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
      const scope = {
        kind: "thread",
        thread: { environmentId: hubEnv, threadId: M.ThreadId.make("receipt-source") },
      } as const;
      const root = newMemory(541);
      yield* hub.push(
        { ...pushInput({ ...root, revision: { ...root.revision, scope } }), features },
        principal(),
      );
      const request = {
        memorySpaceId: space,
        memoryId: root.memoryId,
        operationId: M.MemoryOperationId.make(id(542)),
        expectedHeads: [root.revision.revisionId],
        expectedScopeVersion: 0,
        fromScope: scope,
        toScope: { kind: "user" },
      } satisfies M.MemoryMoveInput;
      const lookup = (input: M.MemoryMoveInput) =>
        service.move({ receiptFor: input } as unknown as M.MemoryMoveInput, Effect.void);
      assert.isFalse(isLegacyMoveInput({ receiptFor: request }));
      assert.include(yield* lookup(request).pipe(Effect.flip), { code: "revision_changed" });
      assert.isUndefined(yield* store.readWork(`sync:${space}:${request.operationId}`));
      const moved = yield* hub.push(
        {
          ...pushInput({
            ...request,
            kind: "move",
            protocolVersion: 1,
            originEnvironmentId: hubEnv,
          }),
          features,
        },
        principal(),
      );
      assert.include(moved.receipts[0], { outcome: "accepted" });
      assert.deepStrictEqual((yield* lookup(request)).receipt, {
        operationId: request.operationId,
        memoryId: request.memoryId,
        revisionId: null,
        outcome: "accepted",
        pendingSync: false,
      });
      assert.include(yield* lookup({ ...request, expectedScopeVersion: 1 }).pipe(Effect.flip), {
        code: "operation_id_reused",
      });
    }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect("an old member prevents automatic floor activation", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const old = yield* hub.pull({ ...pullInput, environmentId: otherEnv }, principal(otherEnv));
      assert.isUndefined(old.derivedCap);
      const updated = yield* hub.pull(advertise, principal());
      assert.isUndefined(updated.derivedCap);
      assert.deepStrictEqual(updated.upgradeRequiredMembers, [otherEnv]);
      const upgraded = yield* hub.pull(
        { ...advertise, environmentId: otherEnv },
        principal(otherEnv),
      );
      assert.strictEqual(upgraded.derivedCap, 1000);
    }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect(
    "moves the same memory and its history, fences stale moves and retires old handles",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const hub = yield* Hub.MemoryHubService;
        const store = yield* Store.MemoryStore;
        const compactor = yield* Compactor.MemoryCompactor;
        yield* hub.pull(advertise, principal());
        yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
        const root = newMemory(501);
        const origin = { environmentId: hubEnv, threadId: M.ThreadId.make("move-origin") };
        const first = {
          ...root,
          revision: {
            ...root.revision,
            provenance: { ...root.revision.provenance, originThreadId: origin.threadId },
          },
        };
        const scope = {
          kind: "thread",
          thread: { environmentId: hubEnv, threadId: M.ThreadId.make("move-target") },
        } as const;
        assert.strictEqual(
          (yield* hub.push({ ...pushInput(first), features }, principal())).receipts[0]?.outcome,
          "accepted",
        );
        const beforeMove = yield* hub.pull(advertise, principal());
        yield* compactor.compact(principal());
        const joinInput = {
          protocolVersion: 1 as const,
          environmentId: otherEnv,
          memorySpaceId: space,
          features,
        };
        const old = yield* hub.join(joinInput, principal(otherEnv));
        const move = decodeOperation({
          protocolVersion: 1,
          kind: "move",
          operationId: id(502),
          memoryId: first.memoryId,
          memorySpaceId: space,
          originEnvironmentId: hubEnv,
          expectedHeads: [first.revision.revisionId],
          expectedScopeVersion: 0,
          fromScope: first.revision.scope,
          toScope: scope,
        });
        const push = (op: M.MemoryOperation) =>
          hub.push({ ...pushInput(op), features }, principal());
        const one = (yield* push(move)).receipts[0];
        assert.include(one, { outcome: "accepted" });
        assert.deepStrictEqual((yield* push(move)).receipts[0], one);
        const aggregate = yield* store.loadAggregate(space, first.memoryId);
        assert.deepStrictEqual(aggregate.identity?.scope, scope);
        assert.deepStrictEqual(aggregate.revisions, [
          { revision: { ...first.revision, scope }, payload: first.payload },
        ]);
        const staleHandle = yield* hub
          .pull(
            {
              ...advertise,
              environmentId: otherEnv,
              snapshotToken: old.snapshotToken,
              afterSequence: old.checkpointSequence,
            },
            principal(otherEnv),
          )
          .pipe(Effect.flip);
        assert.property(staleHandle, "code");
        const next = yield* hub.join(joinInput, principal(otherEnv));
        const checkpoint = yield* hub.pull(
          {
            ...advertise,
            environmentId: otherEnv,
            snapshotToken: next.snapshotToken,
            afterSequence: next.checkpointSequence,
          },
          principal(otherEnv),
        );
        const identity = checkpoint.checkpoint?.identities.find(
          (item) => item.memoryId === first.memoryId,
        );
        assert.deepStrictEqual(identity?.scope, scope);
        assert.deepStrictEqual(identity?.origin, origin);
        if (!checkpoint.checkpoint?.bootstrapComplete)
          throw new Error("Expected one checkpoint page");
        const checkpointPage = checkpoint.checkpoint;
        const tail = yield* hub.pull(
          { ...advertise, afterSequence: beforeMove.throughSequence },
          principal(),
        );
        yield* compactor.compact(principal());
        for (const method of ["tail", "checkpoint"] as const) {
          yield* Effect.gen(function* () {
            const replica = yield* Service.MemoryService;
            const local = yield* Store.MemoryStore;
            yield* replica.receiveHubPage({
              memorySpaceId: space,
              hubEnvironmentId: hubEnv,
              localEnvironmentId: otherEnv,
              expectedSequence: 0,
              page: beforeMove,
              reauthorize: Effect.void,
            });
            yield* scanReplicaMemory(first.memoryId);
            const editId = M.MemoryOperationId.make(id(510));
            yield* replica.upsert(
              {
                memorySpaceId: space,
                memoryId: first.memoryId,
                operationId: editId,
                expectedHeads: [first.revision.revisionId],
                scope: first.revision.scope,
                assertionKind: "inference",
                baseBoundary: null,
                payload: { ...first.payload, text: "unaccepted local edit" },
              },
              Effect.void,
            );
            if (method === "tail") {
              yield* replica.receiveHubPage({
                memorySpaceId: space,
                hubEnvironmentId: hubEnv,
                localEnvironmentId: otherEnv,
                expectedSequence: beforeMove.throughSequence,
                page: tail,
                reauthorize: Effect.void,
              });
            } else {
              const pullTail = makePullMemoryTail({
                store: local,
                service: replica,
                local: otherEnv,
                callPull: (_route, request) =>
                  hub.pull({ ...request, features }, principal(otherEnv)),
                ensureEpoch: () => Effect.void,
              });
              assert.include(
                yield* pullTail(
                  {
                    space,
                    hubId: hubEnv,
                    settings: { memoryHubVersion: 1 },
                  },
                  { pages: 0, entries: 0 },
                ).pipe(Effect.flip),
                { code: "cursor_expired" },
              );
              const stage = {
                memorySpaceId: space,
                hubEnvironmentId: hubEnv,
                checkpointId: `hub:${next.snapshotToken}`,
                expectedSnapshotToken: next.snapshotToken,
                expectedCheckpointSequence: next.checkpointSequence,
              };
              assert.strictEqual((yield* local.readBootstrap(stage)).state, "unbound");
              yield* local.transact(
                local.advanceBootstrapTx({
                  ...stage,
                  expectedState: "unbound",
                  nextState: "staging",
                  snapshotToken: stage.expectedSnapshotToken,
                  checkpointSequence: stage.expectedCheckpointSequence,
                  nextCursor: null,
                }),
              );
              yield* local.installCheckpointPage({ ...stage, page: checkpointPage });
              yield* local.completeCheckpoint({ ...stage, pageCount: 1 });
            }
            yield* scanReplicaMemory(first.memoryId);
            const moved = yield* local.loadAggregate(space, first.memoryId);
            assert.deepStrictEqual(moved.identity?.scope, scope);
            assert.strictEqual(moved.identity?.scopeVersion, 1);
            assert.deepStrictEqual(moved.identity?.origin, origin);
            assert.deepStrictEqual(moved.heads, [first.revision.revisionId]);
            const pendingEdit = yield* local.readWorkOperation(`sync:${space}:${editId}`);
            if (pendingEdit?.kind !== "upsert") throw new Error("Expected the pending edit");
            assert.deepStrictEqual(pendingEdit.revision.scope, first.revision.scope);
            assert.include((yield* push(pendingEdit)).receipts[0], {
              outcome: "rejected",
              failureCode: "identity_mismatch",
            });
            const history = yield* replica.history(
              {
                memorySpaceId: space,
                memoryId: first.memoryId,
                limit: 10,
              },
              Effect.void,
            );
            const original = history.revisions.find(
              ({ revision }) => revision.revisionId === first.revision.revisionId,
            );
            const unaccepted = history.revisions.find(
              ({ revision }) => revision.revisionId === pendingEdit.revision.revisionId,
            );
            assert.deepStrictEqual(original?.payload, first.payload);
            assert.isNull(unaccepted?.payload);
            assert.deepStrictEqual(
              (yield* replica.list(
                {
                  memorySpaceId: space,
                  scope: first.revision.scope,
                  includeQuarantined: true,
                  limit: 10,
                },
                Effect.void,
              )).items,
              [],
            );
            const optimistic = yield* replica.upsert(
              {
                memorySpaceId: space,
                memoryId: first.memoryId,
                operationId: M.MemoryOperationId.make(id(511)),
                expectedHeads: moved.heads,
                scope,
                assertionKind: "inference",
                baseBoundary: null,
                payload: { ...first.payload, text: "synthetic edit in the new scope" },
              },
              Effect.void,
            );
            assert.include(optimistic.receipt, { outcome: "accepted", pendingSync: true });
            const updated = yield* local.loadAggregate(space, first.memoryId);
            assert.deepInclude(updated.item, { status: "active", scope });
            assert.deepStrictEqual(updated.identity?.origin, origin);
            const queued = yield* local.readWorkOperation(
              `sync:${space}:${optimistic.receipt.operationId}`,
            );
            if (!queued) throw new Error("Expected the optimistic edit in the outbox");
            assert.include(queued, { expectedScopeVersion: 1 });
            assert.isTrue(M.requiresMemoryFloor2(queued));
          }).pipe(Effect.provide(Layer.fresh(core)));
        }
        const moveBack = decodeOperation({
          ...move,
          operationId: id(503),
          expectedScopeVersion: 1,
          fromScope: scope,
          toScope: first.revision.scope,
        });
        assert.include((yield* push(moveBack)).receipts[0], { outcome: "accepted" });
        const stale = decodeOperation({ ...move, operationId: id(504) });
        assert.include((yield* push(stale)).receipts[0], {
          outcome: "rejected",
          failureCode: "revision_changed",
        });
      }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect(
    "refuses an offline edit staged before a move round trip and accepts a fresh edit",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const hub = yield* Hub.MemoryHubService;
        const authority = yield* Store.MemoryStore;
        yield* hub.pull(advertise, principal());
        yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
        const root = newMemory(599);
        const push = (op: M.MemoryOperation, env = hubEnv) =>
          hub.push({ ...pushInput(op), environmentId: env, features }, principal(env));
        assert.include((yield* push(root)).receipts[0], { outcome: "accepted" });
        const page = yield* hub.pull(advertise, principal());
        const target = {
          kind: "thread" as const,
          thread: { environmentId: hubEnv, threadId: M.ThreadId.make("round-trip-target") },
        };
        yield* Effect.gen(function* () {
          const service = yield* Service.MemoryService;
          const replica = yield* Store.MemoryStore;
          const receive = (next: M.MemoryHubPullResult, expectedSequence: number) =>
            service.receiveHubPage({
              memorySpaceId: space,
              hubEnvironmentId: hubEnv,
              localEnvironmentId: otherEnv,
              expectedSequence,
              page: next,
              reauthorize: Effect.void,
            });
          yield* receive(page, 0);
          const edit = (n: number, text: string) =>
            Effect.gen(function* () {
              const operationId = M.MemoryOperationId.make(id(n));
              yield* service.upsert(
                {
                  memorySpaceId: space,
                  memoryId: root.memoryId,
                  operationId,
                  expectedHeads: [root.revision.revisionId],
                  scope: root.revision.scope,
                  assertionKind: "inference",
                  baseBoundary: null,
                  payload: { ...root.payload, text },
                },
                Effect.void,
              );
              const queued = yield* replica.readWorkOperation(`sync:${space}:${operationId}`);
              if (queued?.kind !== "upsert") throw new Error("Expected a queued edit");
              return queued;
            });
          const offline = yield* edit(600, "offline pre-move text");
          for (const [version, fromScope, toScope] of [
            [0, root.revision.scope, target],
            [1, target, root.revision.scope],
          ] as const) {
            const moved = (yield* push(
              decodeOperation({
                kind: "move",
                protocolVersion: 1,
                operationId: id(601 + version),
                memoryId: root.memoryId,
                memorySpaceId: space,
                originEnvironmentId: hubEnv,
                expectedHeads: [root.revision.revisionId],
                expectedScopeVersion: version,
                fromScope,
                toScope,
              }),
            )).receipts[0];
            assert.include(moved, { outcome: "accepted" }, JSON.stringify(moved));
          }
          const tail = yield* hub.pull(
            { ...advertise, afterSequence: page.throughSequence },
            principal(),
          );
          yield* receive(tail, page.throughSequence);
          const refused = (yield* push(offline, otherEnv)).receipts[0];
          assert.include(refused, { outcome: "rejected", failureCode: "revision_changed" });
          assert.deepStrictEqual((yield* authority.loadAggregate(space, root.memoryId)).heads, [
            root.revision.revisionId,
          ]);
          const history = yield* service.history(
            { memorySpaceId: space, memoryId: root.memoryId, limit: 10 },
            Effect.void,
          );
          assert.isNull(
            history.revisions.find(
              ({ revision }) => revision.revisionId === offline.revision.revisionId,
            )?.payload,
          );
          const fresh = yield* edit(603, "fresh post-move text");
          assert.include((yield* push(fresh, otherEnv)).receipts[0], { outcome: "accepted" });
          assert.deepStrictEqual((yield* authority.loadAggregate(space, root.memoryId)).heads, [
            fresh.revision.revisionId,
          ]);
        }).pipe(Effect.provide(Layer.fresh(coreFor(otherEnv))));
      }).pipe(checkUsage, Effect.provide(live)),
  );

  it("round-trips accepted and refused move receipts and preserves historical kind bytes", () => {
    const record = {
      memorySpaceId: space,
      originEnvironmentId: hubEnv,
      operationKind: "move" as const,
      receipt: {
        operationId: M.MemoryOperationId.make(id(1)),
        memoryId: newMemory(1).memoryId,
        operationDigest: "a".repeat(64),
        hubSequence: 1,
        outcome: "accepted" as const,
      },
      revisionId: null,
      resolutionId: null,
      revertsResolutionId: null,
      attemptId: null,
      fencingToken: null,
      reportGuard: null,
    };
    for (const receipt of [
      record.receipt,
      { ...record.receipt, outcome: "rejected" as const, failureCode: "revision_changed" as const },
    ]) {
      const value = { ...record, receipt };
      const bytes = Store.encodeCompactReceipt(value, () => 1);
      assert.strictEqual(bytes[1], 4);
      assert.deepStrictEqual(
        Store.decodeCompactReceipt(bytes, space, () => hubEnv),
        value,
      );
    }
    const expectedTail = `00010000000000004000800000000000000101${record.receipt.memoryId.replaceAll("-", "")}${"a".repeat(64)}01010000000000000000000000`;
    for (const [ordinal, operationKind] of (
      ["upsert", "forget", "resolve", "revert"] as const
    ).entries()) {
      const legacy = Store.encodeCompactReceipt({ ...record, operationKind }, () => 1);
      assert.strictEqual(Buffer.from(legacy).toString("hex"), `020${ordinal}${expectedTail}`);
    }
  });

  it.effect("refuses a move into a full scope without removing the source", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const store = yield* Store.MemoryStore;
      yield* hub.pull(advertise, principal());
      yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
      const scope = {
        kind: "thread",
        thread: { environmentId: hubEnv, threadId: M.ThreadId.make("full-scope") },
      } as const;
      const occupants = Array.from({ length: M.MEMORY_THREAD_MAX_EXPLICIT_ITEMS }, (_, index) => {
        const op = newMemory(4300 + index);
        return { ...op, revision: { ...op.revision, scope } };
      });
      const pushed = yield* hub.push({ ...pushInput(...occupants), features }, principal());
      assert.isTrue(pushed.receipts.every((receipt) => receipt.outcome === "accepted"));
      const op = newMemory(4200);
      assert.include((yield* hub.push({ ...pushInput(op), features }, principal())).receipts[0], {
        outcome: "accepted",
      });
      const move = decodeOperation({
        protocolVersion: 1,
        kind: "move",
        operationId: id(4201),
        memorySpaceId: space,
        memoryId: op.memoryId,
        originEnvironmentId: hubEnv,
        expectedHeads: [op.revision.revisionId],
        expectedScopeVersion: 0,
        fromScope: op.revision.scope,
        toScope: scope,
      });
      assert.deepInclude(
        (yield* hub.push({ ...pushInput(move), features }, principal())).receipts[0],
        {
          outcome: "rejected",
          failureCode: "capacity_exceeded",
          capacity: {
            code: "capacity_exceeded",
            dimension: "thread_items",
            current: M.MEMORY_THREAD_MAX_EXPLICIT_ITEMS + 1,
            limit: M.MEMORY_THREAD_MAX_EXPLICIT_ITEMS,
            reclaimable: 0,
          },
        },
      );
      assert.deepStrictEqual(
        (yield* store.loadAggregate(space, op.memoryId)).identity?.scope,
        op.revision.scope,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
});
