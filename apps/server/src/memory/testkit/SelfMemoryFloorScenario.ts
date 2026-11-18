import * as M from "@goat/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Hub from "../MemoryHubService.ts";
import * as Store from "../MemoryStore.ts";
import * as Service from "../MemoryService.ts";
import * as Sync from "../MemorySyncService.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const runSelfWideSave = Effect.fn("test.runSelfWideSave")(function* (
  space: M.MemorySpaceId,
  local: M.EnvironmentId,
) {
  yield* (yield* Sync.MemorySyncService).shutdown;
  const restarted = yield* Layer.build(Layer.fresh(Sync.layer));
  const sync = Context.get(restarted, Sync.MemorySyncService);
  const store = yield* Store.MemoryStore;
  const service = yield* Service.MemoryService;
  const hub = yield* Hub.MemoryHubService;
  assert.strictEqual((yield* sync.readLocalReadiness()).bootstrap, "ready");
  assert.isFalse(yield* store.transact(store.hubFloorActive(space)));
  yield* sync.syncOnce;
  assert.isTrue(yield* store.transact(store.hubFloorActive(space)));
  const member = yield* store.readHubMember(space, local);
  if (!member) throw new Error("Expected a self credential");
  const principal: M.MemoryHubPrincipal = {
    environmentId: local,
    memorySpaceId: space,
    credentialVersion: member.credentialVersion,
    scopes: ["memory:sync"],
  };
  const sources = Array.from(
    { length: 101 },
    (_, index): Extract<M.MemoryOperation, { kind: "upsert" }> => {
      const operationId = M.MemoryOperationId.make(id(100 + index));
      const memoryId = M.MemoryId.make(id(1000 + index));
      const revisionId = M.MemoryRevisionId.make(id(2000 + index));
      return {
        protocolVersion: 1,
        kind: "upsert",
        operationId,
        memoryId,
        expectedHeads: [],
        memorySpaceId: space,
        originEnvironmentId: local,
        payload: {
          text: `synthetic self source ${index}`,
          evidence: [],
          derivedFromMemoryRevisions: [],
        },
        revision: {
          operationId,
          memoryId,
          memorySpaceId: space,
          revisionId,
          payloadRef: revisionId,
          parents: [],
          scope: { kind: "user" },
          provenance: { environmentId: local },
          assertionKind: "inference",
          createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
        },
      };
    },
  );
  for (const operations of [sources.slice(0, 100), sources.slice(100)]) {
    const pushed = yield* hub.push(
      {
        protocolVersion: 1,
        environmentId: local,
        memorySpaceId: space,
        features: M.MEMORY_FLOOR_2,
        operations,
      },
      principal,
    );
    assert.isTrue(pushed.receipts.every((receipt) => receipt.outcome === "accepted"));
  }
  yield* sync.syncOnce;
  const input: M.MemoryUpsertInput = {
    memorySpaceId: space,
    operationId: M.MemoryOperationId.make(id(9000)),
    memoryId: M.MemoryId.make(id(9001)),
    expectedHeads: [],
    scope: { kind: "user" },
    assertionKind: "inference",
    baseBoundary: null,
    payload: {
      text: "synthetic wide self save",
      evidence: [],
      derivedFromMemoryRevisions: sources.map((source) => source.revision.revisionId),
    },
  };
  const staged = yield* service.upsert(input, Effect.void);
  assert.include(staged.receipt, { pendingSync: true, revisionId: null });
  assert.isUndefined((yield* store.loadAggregate(space, input.memoryId)).item);
  yield* sync.syncOnce;
  const accepted = yield* store.receipt(space, input.operationId);
  if (!accepted || !("hubSequence" in accepted.receipt))
    throw new Error("Expected a sequenced self-hub receipt");
  assert.include(accepted.receipt, { outcome: "accepted" });
  assert.isNumber(accepted.receipt.hubSequence);
  const first = sources[0];
  if (!first) throw new Error("Expected a source");
  yield* service.forget(
    {
      memorySpaceId: space,
      memoryId: first.memoryId,
      operationId: M.MemoryOperationId.make(id(9002)),
      expectedHeads: [first.revision.revisionId],
    },
    Effect.void,
  );
  yield* sync.syncOnce;
  const after = yield* store.loadAggregate(space, input.memoryId);
  assert.include(after.item, { status: "blocked", failureCode: "source_invalidated" });
  assert.isTrue(after.revisions.every((pair) => pair.payload === null));
  const next = sources[1];
  if (!next) throw new Error("Expected a second source");
  const scope = {
    kind: "thread",
    thread: {
      environmentId: local,
      threadId: M.ThreadId.make("synthetic-move-thread"),
    },
  } as const;
  const move = yield* service.remember(
    {
      memorySpaceId: space,
      memoryId: next.memoryId,
      scope: "thread",
    },
    Effect.void,
    scope.thread,
  );
  assert.include(move.receipt, { pendingSync: true, revisionId: null });
  assert.deepStrictEqual(
    (yield* store.loadAggregate(space, next.memoryId)).identity?.scope,
    next.revision.scope,
  );
  yield* sync.syncOnce;
  const moved = yield* store.loadAggregate(space, next.memoryId);
  assert.deepStrictEqual(moved.identity?.scope, scope);
  assert.deepStrictEqual(moved.revisions, [
    { revision: { ...next.revision, scope }, payload: next.payload },
  ]);
  yield* sync.shutdown;
});
