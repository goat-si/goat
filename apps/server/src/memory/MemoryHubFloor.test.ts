import { scanReplicaMemory } from "./testkit/ScanReplicaMemory.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Compactor from "./MemoryCompactor.ts";
import { MemoryFloor2Enabled } from "./MemoryFloor.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Hub from "./MemoryHubService.ts";
import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import {
  core,
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

const decodeResolution = Schema.decodeUnknownSync(M.MemoryHubApplyResolutionInput);
const enabled = Effect.provideService(MemoryFloor2Enabled, true);
const features = M.MEMORY_FLOOR_2;
const advertise = { ...pullInput, features };
const newMemory = (n: number) => {
  const op = operation(n);
  const memoryId = M.MemoryId.make(id(n + 30000));
  return { ...op, memoryId, revision: { ...op.revision, memoryId } };
};
const forget = (source: ReturnType<typeof newMemory>): M.MemoryOperation => {
  const operationId = M.MemoryOperationId.make(id(20000));
  return {
    protocolVersion: 1,
    kind: "forget",
    originEnvironmentId: otherEnv,
    operationId,
    memorySpaceId: space,
    memoryId: source.memoryId,
    expectedHeads: [source.revision.revisionId],
    tombstone: {
      memorySpaceId: space,
      memoryId: source.memoryId,
      deleteOperationId: operationId,
      deletingEnvironmentId: otherEnv,
      deletedAtUtc: source.revision.createdAtUtc,
      suppressedSourceKeys: [],
      suppressedContent: [],
      sourceExclusions: [],
    },
  };
};

describe("memory hub floor", () => {
  it.effect("names members that block a wide write on the V1 floor", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const wide = operation();
      const result = yield* hub.push(
        pushInput({
          ...wide,
          payload: {
            ...wide.payload,
            derivedFromMemoryRevisions: Array.from({ length: 101 }, (_, n) =>
              M.MemoryRevisionId.make(id(200 + n)),
            ),
          },
        }),
        principal(),
      );
      assert.include(result.receipts[0], {
        outcome: "rejected",
        failureCode: "hub_upgrade_required",
      });
      assert.deepStrictEqual(Reflect.get(result.receipts[0]!, "upgradeRequiredMembers"), [
        hubEnv,
        otherEnv,
      ]);
      const page = yield* hub.pull(pullInput, principal());
      assert.deepStrictEqual(page.entries, []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("reports the same upgrade blockers in a negotiated pull and a local refusal", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const local = yield* Service.MemoryService;
      const blockers = [otherEnv];
      assert.deepStrictEqual(
        Reflect.get(yield* hub.pull(advertise, principal()), "upgradeRequiredMembers"),
        blockers,
      );
      const op = newMemory(99);
      const refusal = yield* local
        .acceptSuggestionWrite(
          {
            memorySpaceId: space,
            memoryId: op.memoryId,
            operationId: op.operationId,
            scope: op.revision.scope,
            assertionKind: op.revision.assertionKind,
            expectedHeads: [],
            payload: op.payload,
            baseBoundary: null,
          },
          {
            origin: { environmentId: hubEnv, threadId: M.ThreadId.make("origin-thread") },
            unverified: true,
          },
          Effect.void,
        )
        .pipe(Effect.flip);
      assert.include(refusal, { code: "hub_upgrade_required" });
      assert.deepStrictEqual(Reflect.get(refusal, "upgradeRequiredMembers"), blockers);
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect("a wide save stays invisible until ordered tail settlement", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sources = Array.from({ length: 101 }, (_, n) => {
        const op = operation(1000 + n);
        const memoryId = M.MemoryId.make(id(3000 + n));
        return { ...op, memoryId, revision: { ...op.revision, memoryId } };
      });
      for (const source of sources) yield* hub.push(pushInput(source), principal());
      assert.isUndefined((yield* hub.pull(advertise, principal())).derivedCap);
      const peerPull = { ...advertise, environmentId: otherEnv };
      const firstPage = yield* hub.pull(peerPull, principal(otherEnv));
      assert.strictEqual(firstPage.derivedCap, 1000);
      assert.isTrue(firstPage.hasMore);
      const wide = operation(2000);
      const result = yield* service.upsert(
        {
          memorySpaceId: space,
          operationId: wide.operationId,
          memoryId: wide.memoryId,
          expectedHeads: [],
          scope: wide.revision.scope,
          assertionKind: wide.revision.assertionKind,
          payload: {
            ...wide.payload,
            derivedFromMemoryRevisions: sources.map((op) => op.revision.revisionId),
          },
          baseBoundary: null,
        },
        Effect.void,
      );
      assert.isUndefined((yield* store.loadAggregate(space, wide.memoryId)).item);
      assert.include(result.receipt, { pendingSync: true, revisionId: null });
      const queued = yield* store.readWorkOperation(`sync:${space}:${wide.operationId}`);
      assert.strictEqual(queued?.kind, "upsert");
      if (!queued) throw new Error("expected a staged write");
      assert.include(
        (yield* hub.push({ ...pushInput(queued), features: M.MEMORY_FLOOR_2 }, principal()))
          .receipts[0],
        { outcome: "accepted" },
      );
      const source = sources[100]!;
      const widePage = yield* hub.pull(
        { ...peerPull, afterSequence: firstPage.throughSequence },
        principal(otherEnv),
      );
      yield* Effect.gen(function* () {
        const member = yield* Service.MemoryService;
        const memberStore = yield* Store.MemoryStore;
        const receive = (page: M.MemoryHubPullResult, expectedSequence: number) =>
          member.receiveHubPage({
            page,
            expectedSequence,
            memorySpaceId: space,
            hubEnvironmentId: hubEnv,
            localEnvironmentId: otherEnv,
            reauthorize: Effect.void,
          });
        yield* receive(firstPage, 0);
        yield* receive(widePage, firstPage.throughSequence);
        const saved = (yield* memberStore.loadAggregate(space, wide.memoryId)).revisions[0];
        assert.lengthOf(saved?.payload?.derivedFromMemoryRevisions ?? [], 101);
        const deleted = yield* hub.push(
          { ...pushInput(forget(source)), features, environmentId: otherEnv },
          principal(otherEnv),
        );
        assert.include(deleted.receipts[0], { outcome: "deleted" });
        const tail = yield* hub.pull(
          { ...peerPull, afterSequence: widePage.throughSequence },
          principal(otherEnv),
        );
        yield* receive(tail, widePage.throughSequence);
        const after = yield* memberStore.loadAggregate(space, wide.memoryId);
        assert.include(after.item, { status: "blocked", failureCode: "source_invalidated" });
        assert.isTrue(after.revisions.every((pair) => pair.payload === null));
      }).pipe(Effect.provide(Layer.fresh(core)));
      assert.include((yield* store.loadAggregate(space, wide.memoryId)).item, {
        status: "blocked",
        failureCode: "source_invalidated",
      });
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );
  it.effect("activates on pull only when the active credentials advertise the complete set", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const sql = yield* SqlClient.SqlClient;
      assert.isUndefined((yield* hub.pull(advertise, principal())).derivedCap);
      yield* sql`UPDATE memory_hub_members SET credential_version=2 WHERE environment=${hubEnv}`;
      const peer = { ...advertise, environmentId: otherEnv };
      assert.isUndefined((yield* hub.pull(peer, principal(otherEnv))).derivedCap);
      const rotated = { ...principal(), credentialVersion: 2 };
      assert.isUndefined(
        (yield* hub.pull({ ...pullInput, features: ["derivedCap1000", "revisionMarks"] }, rotated))
          .derivedCap,
      );
      assert.strictEqual((yield* hub.pull(advertise, rotated)).derivedCap, 1000);
      const enrolled = M.EnvironmentId.make("old-environment");
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${enrolled},${"c".repeat(64)},1,'active')`;
      const old = yield* hub
        .join(
          { protocolVersion: 1, environmentId: enrolled, memorySpaceId: space },
          principal(enrolled),
        )
        .pipe(Effect.flip);
      assert.include(old, { code: "unsupported_protocol" });
      assert.strictEqual((yield* hub.pull(advertise, rotated)).derivedCap, 1000);
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect("a lost ACK settles an accepted suggestion without republishing a forgotten body", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const compactor = yield* Compactor.MemoryCompactor;
      const hubSql = yield* SqlClient.SqlClient;
      const source = newMemory(11);
      yield* hub.push(pushInput(source), principal());
      yield* hub.pull(advertise, principal());
      const first = yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
      assert.strictEqual(first.derivedCap, 1000);
      yield* Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const receive = (page: M.MemoryHubPullResult, expectedSequence: number) =>
          service.receiveHubPage({
            memorySpaceId: space,
            hubEnvironmentId: hubEnv,
            localEnvironmentId: hubEnv,
            page,
            expectedSequence,
            reauthorize: Effect.void,
          });
        yield* receive(first, 0);
        yield* scanReplicaMemory(source.memoryId);
        const wide = newMemory(12);
        const result = yield* service.acceptSuggestionWrite(
          {
            memorySpaceId: space,
            memoryId: wide.memoryId,
            operationId: wide.operationId,
            scope: wide.revision.scope,
            assertionKind: wide.revision.assertionKind,
            expectedHeads: [],
            baseBoundary: null,
            payload: { ...wide.payload, derivedFromMemoryRevisions: [source.revision.revisionId] },
          },
          {
            origin: { environmentId: hubEnv, threadId: M.ThreadId.make("origin-thread") },
            unverified: true,
          },
          Effect.void,
        );
        const workId = `sync:${space}:${wide.operationId}`;
        const queued = yield* store.readWorkOperation(workId);
        if (!queued || queued.kind === "forget") throw new Error("expected a staged suggestion");
        assert.strictEqual(queued.forgetFence, first.throughSequence);
        assert.isUndefined((yield* store.loadAggregate(space, wide.memoryId)).item);
        const push = { ...pushInput(queued), features };
        const accepted = yield* hub.push(push, principal());
        assert.include(accepted.receipts[0], { outcome: "accepted" });
        const deleted = yield* hub.push(
          { ...pushInput(forget(source)), features, environmentId: otherEnv },
          principal(otherEnv),
        );
        assert.include(deleted.receipts[0], { outcome: "deleted" });
        const replay = yield* hub.push(push, principal());
        assert.deepStrictEqual(replay, accepted);
        yield* service.settleHubAcknowledgement({
          memorySpaceId: space,
          hubEnvironmentId: hubEnv,
          localEnvironmentId: hubEnv,
          workId,
          receipt: replay.receipts[0]!,
          operation: { operationId: queued.operationId, operationDigest: result.operationDigest },
          reauthorize: Effect.void,
        });
        assert.strictEqual((yield* store.readWork(workId))?.status, "completed");
        assert.isUndefined((yield* store.loadAggregate(space, wide.memoryId)).item);
        const tail = yield* hub.pull(
          { ...advertise, afterSequence: first.throughSequence },
          principal(),
        );
        assert.isFalse(
          tail.entries.some(
            (entry) =>
              entry.kind === "operation" && entry.operation.operationId === queued.operationId,
          ),
        );
        yield* receive(tail, first.throughSequence);
        const after = yield* store.loadAggregate(space, wide.memoryId);
        assert.isTrue(after.revisions.every((pair) => pair.payload === null));
        assert.notStrictEqual(after.item?.status, "active");
        yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS + 1);
        yield* compactor.compact(principal());
        assert.isEmpty(
          yield* hubSql`SELECT operation_id FROM memory_hub_operations WHERE operation_id=${forget(source).operationId}`,
        );
        const stale = newMemory(13);
        const refused = yield* hub.push(
          { ...pushInput({ ...stale, forgetFence: first.throughSequence }), features },
          principal(),
        );
        assert.include(refused.receipts[0], {
          outcome: "rejected",
          failureCode: "source_invalidated",
        });
      }).pipe(Effect.provide(Layer.fresh(core)));
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect("replicates unverified provenance in the tail and checkpoint", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const compactor = yield* Compactor.MemoryCompactor;
      yield* hub.pull(advertise, principal());
      assert.strictEqual(
        (yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv)))
          .derivedCap,
        1000,
      );
      const initial = newMemory(21);
      const op = {
        ...initial,
        forgetFence: 0,
        revision: {
          ...initial.revision,
          provenance: {
            environmentId: hubEnv,
            unverified: true as const,
            originThreadId: M.ThreadId.make("origin-thread"),
          },
        },
      };
      const receipt = (yield* hub.push({ ...pushInput(op), features }, principal())).receipts[0]!;
      assert.include(receipt, { outcome: "accepted", operationDigest: memoryOperationDigest(op) });
      const tail = yield* hub.pull(advertise, principal());
      yield* Effect.gen(function* () {
        const replica = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        yield* replica.receiveHubPage({
          memorySpaceId: space,
          hubEnvironmentId: hubEnv,
          localEnvironmentId: otherEnv,
          expectedSequence: 0,
          page: tail,
          reauthorize: Effect.void,
        });
        yield* scanReplicaMemory(op.memoryId);
        assert.isFalse(yield* store.areAutomaticallyUsable(space, [op.revision.revisionId]));
        assert.deepStrictEqual(
          (yield* replica.read(
            { memorySpaceId: space, memoryId: op.memoryId, includeMarks: true },
            Effect.void,
          )).marks,
          { provenance: "unverified", originThreadId: op.revision.provenance.originThreadId },
        );
        const legacy = yield* replica.read(
          { memorySpaceId: space, memoryId: op.memoryId },
          Effect.void,
        );
        assert.strictEqual(legacy.status, "active");
        if (legacy.status !== "active") throw new Error("expected a scanned replica item");
        assert.notProperty(legacy.revision.provenance, "unverified");
        assert.notProperty(legacy.revision.provenance, "originThreadId");
      }).pipe(Effect.provide(Layer.fresh(core)));
      yield* compactor.compact(principal());
      const join = yield* hub.join(
        { protocolVersion: 1, environmentId: otherEnv, memorySpaceId: space, features },
        principal(otherEnv),
      );
      const page = yield* hub.pull(
        {
          ...advertise,
          environmentId: otherEnv,
          snapshotToken: join.snapshotToken,
          afterSequence: join.checkpointSequence,
        },
        principal(otherEnv),
      );
      assert.include(
        page.checkpoint?.revisions.find(
          ({ revision }) => revision.revisionId === op.revision.revisionId,
        )?.revision.provenance,
        { unverified: true, originThreadId: op.revision.provenance.originThreadId },
      );
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect("fences all legacy hub routes on an active credential", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_space_features VALUES (${space},1000,0)`;
      const hub = yield* Hub.MemoryHubService;
      const member = principal();
      const base = { protocolVersion: 1 as const, memorySpaceId: space };
      const op = operation();
      const requestId = M.MemorySourceReadRequestId.make(id(40));
      const conflictId = M.MemoryConflictId.make(id(42));
      const lease = {
        ...base,
        memoryId: op.memoryId,
        conflictId,
        attemptId: op.operationId,
        holderEnvironmentId: hubEnv,
      };
      const heads = [M.MemoryRevisionId.make(id(10)), M.MemoryRevisionId.make(id(11))];
      const model = { instanceId: M.ProviderInstanceId.make("synthetic"), model: "synthetic" };
      const resolution = decodeResolution({
        ...base,
        holderEnvironmentId: hubEnv,
        attemptId: op.operationId,
        operation: {
          ...op,
          kind: "resolve",
          expectedHeads: heads,
          revision: { ...op.revision, parents: heads },
          conflictId,
          fencingToken: 1,
          resolutionPayload: { resolutionId: id(49), judgment: "synthetic judgment" },
          resolution: {
            resolutionId: id(49),
            memorySpaceId: space,
            memoryId: op.memoryId,
            inputRevisionIds: heads,
            inputPayloadRefs: heads,
            resultRevisionId: op.revision.revisionId,
            judgmentRef: id(49),
            requestedModelSelection: model,
            effectiveProvider: "codex",
            effectiveModel: "synthetic",
            resolvingEnvironmentId: hubEnv,
            fencingToken: 1,
            appliedAtUtc: "2026-10-14T00:00:00.000Z",
            revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
          },
        },
      });
      const calls: ReadonlyArray<Effect.Effect<unknown, Hub.MemoryHubServiceError>> = [
        hub.join({ ...base, environmentId: hubEnv }, member),
        hub.push(pushInput(op), member),
        hub.pull(pullInput, member),
        hub.claim({ ...lease, conflictHeadSet: heads, frozenDefaultModelSelection: model }, member),
        hub.renew({ ...lease, fencingToken: 1 }, member),
        hub.release({ ...lease, fencingToken: 1 }, member),
        hub.applyResolution(resolution, member),
        hub.requestSourceRead(
          {
            ...base,
            requestId,
            memoryId: op.memoryId,
            sourceThread: { environmentId: otherEnv, threadId: M.ThreadId.make("origin-thread") },
            sourceWatermark: {
              fromEventId: M.EventId.make("e1"),
              toEventId: M.EventId.make("e2"),
              throughSequence: 1,
            },
            messageIds: [M.MessageId.make("m1")],
            limit: 1,
            authorizedScopes: ["memory:read", "orchestration:read"],
          },
          member,
        ),
        hub.collectSourceReads({ ...base, limit: 1 }, member),
        hub.respondSourceRead(
          {
            ...base,
            kind: "normal",
            ownerPolicyEpoch: 1,
            requestId,
            outcome: { kind: "denied", requiredPermission: "orchestration:read" },
          },
          member,
        ),
        hub.resultSourceRead({ ...base, requestId }, member),
      ];
      for (const call of calls)
        assert.include(yield* call.pipe(Effect.asVoid, Effect.flip), {
          code: "unsupported_protocol",
        });
    }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect("fences old and partial advertisements after floor activation", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_space_features VALUES (${space},1000,0)`;
      const hub = yield* Hub.MemoryHubService;
      const old = yield* hub.pull(pullInput, principal()).pipe(Effect.result);
      const partial = yield* hub
        .push(Object.assign(pushInput(operation()), { features: ["derivedCap1000"] }), principal())
        .pipe(Effect.result);
      assert.include(old, { _tag: "Failure" });
      assert.include(partial, { _tag: "Failure" });
      if (old._tag === "Failure") assert.include(old.failure, { code: "unsupported_protocol" });
      if (partial._tag === "Failure")
        assert.include(partial.failure, { code: "unsupported_protocol" });
    }).pipe(checkUsage, Effect.provide(live)),
  );
});
