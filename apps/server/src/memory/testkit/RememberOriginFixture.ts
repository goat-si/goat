import * as M from "@goat/contracts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hub from "../MemoryHubService.ts";
import * as Service from "../MemoryService.ts";
import * as Store from "../MemoryStore.ts";
import * as Sync from "../MemorySyncService.ts";
import * as Member from "../MemorySyncService.testkit.ts";
import * as Compactor from "../MemoryCompactor.ts";
import {
  hubEnv,
  id,
  memberEnv,
  operation,
  principal,
  pull,
  seed,
  space,
} from "../MemoryCompactor.testkit.ts";
import { scanReplicaMemory } from "./ScanReplicaMemory.ts";

export const runRememberOriginFixture = Effect.fn("test.runRememberOriginFixture")(function* (
  scenario: "pre-activation" | "offline floor-2" | "already ready",
) {
  yield* seed;
  const hub = yield* Hub.MemoryHubService;
  const compactor = yield* Compactor.MemoryCompactor;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at)
    VALUES (${space},${Member.local},${"c".repeat(64)},1,'active',0)`;
  let active = false;
  let offline = false;
  let holdOrigin = scenario === "already ready";
  const negotiation = () => (active ? { features: M.MEMORY_FLOOR_2 } : {});
  const ensureOnline = Effect.suspend(() =>
    offline ? Effect.fail(new M.MemoryHubError({ code: "unavailable" })) : Effect.void,
  );
  const peerFor = (member: M.EnvironmentId) =>
    Member.peer({
      join: (connection, input) =>
        hub
          .join(
            {
              ...input,
              ...negotiation(),
            },
            principal(member),
          )
          .pipe(
            Effect.map((result) => ({ ...result, hubEnvironmentId: connection.hubEnvironmentId })),
            Effect.orDie,
          ),
      pull: (_connection, input) => {
        const { afterOriginSequence: _held, ...ordered } = input;
        const request = holdOrigin && member === memberEnv ? ordered : input;
        return ensureOnline.pipe(
          Effect.andThen(
            hub.pull({ ...request, ...negotiation() }, principal(member)).pipe(Effect.orDie),
          ),
        );
      },
      push: (_connection, input, prepare) =>
        ensureOnline.pipe(
          Effect.andThen(prepare ?? Effect.succeed(input)),
          Effect.flatMap((request) =>
            hub.push({ ...request, ...negotiation() }, principal(member)).pipe(Effect.orDie),
          ),
        ),
    });
  const origin = {
    environmentId: Member.local,
    threadId: M.ThreadId.make("synthetic-writer-conversation"),
  };
  const replica = Member.fixture(peerFor(memberEnv), undefined, false, false, memberEnv);
  const readyPeer = scenario === "already ready" ? yield* Layer.build(Layer.fresh(replica)) : null;
  if (readyPeer)
    yield* Effect.gen(function* () {
      yield* Member.ready;
      const sync = yield* Sync.MemorySyncService;
      yield* sync.syncOnce;
      assert.propertyVal(yield* sync.readLocalReadiness(), "bootstrap", "ready");
    }).pipe(Effect.provide(readyPeer));
  const writer = Member.fixture(peerFor(Member.local), undefined, false, false, Member.local);
  const attempts = yield* Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    const store = yield* Store.MemoryStore;
    const service = yield* Service.MemoryService;
    yield* Member.ready;
    yield* sync.syncOnce;
    assert.propertyVal(yield* sync.readLocalReadiness(), "bootstrap", "ready");
    const activate = Effect.gen(function* () {
      active = true;
      for (const environmentId of [hubEnv, memberEnv])
        yield* hub.pull({ ...pull(0, environmentId), ...negotiation() }, principal(environmentId));
      yield* sync.syncOnce;
      assert.isTrue(yield* store.transact(store.hubFloorActive(space)));
    });
    const remember = Effect.fn("test.rememberWithOrigin")(function* (text: string) {
      const saved = yield* service.remember(
        { memorySpaceId: space, scope: "user", text },
        Effect.void,
        origin,
      );
      const { memoryId, operationId } = saved.receipt;
      assert.include(saved.receipt, { pendingSync: true });
      assert.include((yield* store.loadAggregate(space, memoryId)).item, { status: "active" });
      const op = yield* store.readWorkOperation(`sync:${space}:${operationId}`);
      if (!op || op.kind !== "upsert") throw new Error("Expected staged remember");
      assert.isFalse(M.requiresMemoryFloor2(op));
      return op;
    });
    if (scenario === "pre-activation") {
      const op = yield* remember("Synthetic save before floor activation");
      yield* sync.syncOnce;
      yield* activate;
      return [op];
    }
    yield* activate;
    if (scenario === "already ready") {
      const saved = yield* remember("Synthetic narrow save after the peer joined");
      yield* sync.syncOnce;
      assert.deepStrictEqual(
        (yield* service.list(
          { memorySpaceId: space, origin, limit: 10, includeQuarantined: false },
          Effect.void,
        )).items.map(({ memoryId }) => memoryId),
        [saved.memoryId],
      );
      return [saved];
    }
    const sources = Array.from({ length: 100 }, (_, n) => {
      const op = operation(30100 + n);
      const memoryId = M.MemoryId.make(id(30300 + n));
      return { ...op, memoryId, revision: { ...op.revision, memoryId } };
    });
    const seeded = yield* hub.push(
      {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: hubEnv,
        operations: sources,
        ...negotiation(),
      },
      principal(),
    );
    assert.isTrue(seeded.receipts.every(({ outcome }) => outcome === "accepted"));
    yield* sync.syncOnce;
    for (const source of sources) yield* scanReplicaMemory(source.memoryId);
    yield* compactor.compact(principal());
    const pinned = yield* hub.join(
      {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: memberEnv,
        ...negotiation(),
      },
      principal(memberEnv),
    );
    offline = true;
    const zero = yield* remember("Synthetic offline save with no dependencies");
    yield* store.appendThreadLineage(
      origin,
      space,
      sources.map((op) => op.revision.revisionId),
    );
    const hundred = yield* remember("Synthetic offline save with a hundred dependencies");
    assert.lengthOf(hundred.payload.derivedFromMemoryRevisions, 100);
    offline = false;
    yield* sync.syncOnce;
    const originalPage = yield* hub.pull(
      {
        ...pull(pinned.checkpointSequence, memberEnv),
        ...negotiation(),
        snapshotToken: pinned.snapshotToken,
      },
      principal(memberEnv),
    );
    assert.propertyVal(originalPage.checkpoint, "checkpointSequence", pinned.checkpointSequence);
    assert.isFalse(
      originalPage.checkpoint?.identities.some(
        ({ memoryId }) => memoryId === zero.memoryId || memoryId === hundred.memoryId,
      ),
    );
    return [zero, hundred];
  }).pipe(Effect.provide(Layer.fresh(writer)));

  if (scenario === "pre-activation") {
    const [op] = attempts;
    if (!op) throw new Error("Expected the pre-activation save");
    const newIds = operation(30900);
    const expectedHeads = [op.revision.revisionId];
    const edited: M.MemoryOperation = {
      ...op,
      originEnvironmentId: memberEnv,
      operationId: newIds.operationId,
      expectedHeads,
      revision: {
        ...op.revision,
        operationId: newIds.operationId,
        revisionId: newIds.revision.revisionId,
        payloadRef: newIds.revision.payloadRef,
        parents: expectedHeads,
        provenance: { environmentId: memberEnv },
      },
      payload: { ...op.payload, text: "Synthetic edit by a different member" },
    };
    const saved = yield* hub.push(
      {
        protocolVersion: 1,
        environmentId: memberEnv,
        memorySpaceId: space,
        operations: [edited],
        ...negotiation(),
      },
      principal(memberEnv),
    );
    assert.propertyVal(saved.receipts[0], "outcome", "accepted");
  }
  for (const op of attempts) {
    const store = yield* Store.MemoryStore;
    assert.isDefined((yield* store.loadAggregate(space, op.memoryId)).item);
  }
  if (scenario === "pre-activation") {
    yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS + 1);
    yield* compactor.compact(principal());
  }

  const checkReplica = Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    const service = yield* Service.MemoryService;
    yield* sync.syncOnce;
    assert.propertyVal(yield* sync.readLocalReadiness(), "bootstrap", "ready");
    for (const op of attempts) yield* scanReplicaMemory(op.memoryId);
    const list = service.list(
      { memorySpaceId: space, origin, limit: 10, includeQuarantined: false },
      Effect.void,
    );
    if (scenario === "already ready") {
      assert.isEmpty((yield* list).items);
      const store = yield* Store.MemoryStore;
      const changes = yield* Stream.toPull(yield* store.changes(space));
      assert.propertyVal((yield* changes)[0], "kind", "reset");
      holdOrigin = false;
      yield* sync.syncOnce;
      assert.include((yield* changes)[0], { kind: "invalidate", memoryId: attempts[0]?.memoryId });
    }
    const page = yield* list;
    assert.sameMembers(
      page.items.map(({ memoryId }) => memoryId),
      attempts.map(({ memoryId }) => memoryId),
    );
  });
  if (readyPeer) yield* checkReplica.pipe(Effect.scoped, Effect.provide(readyPeer));
  else yield* checkReplica.pipe(Effect.scoped, Effect.provide(Layer.fresh(replica)));
});
