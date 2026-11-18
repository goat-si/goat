import * as Context from "effect/Context";
import { suggestionForgetGeneration } from "./store/SaveSuggestions.ts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Sync from "./MemorySyncService.ts";
import * as Member from "./MemorySyncService.testkit.ts";
import { decodeLegacyPushResult, decodeLegacyUpsert } from "./testkit/FrozenMemoryV1.ts";
import { makeMemorySaveSuggestions } from "./MemorySaveSuggestions.ts";
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

  it.effect("returns a terminal V1 receipt for a payload that exceeds the new tail envelope", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const op = newMemory(94);
      const { payload } = decodeLegacyUpsert({
        memorySpaceId: space,
        memoryId: op.memoryId,
        operationId: op.operationId,
        expectedHeads: [],
        scope: op.revision.scope,
        assertionKind: op.revision.assertionKind,
        baseBoundary: null,
        payload: {
          ...op.payload,
          evidence: [
            {
              origin: "thread",
              sourceThread: {
                environmentId: hubEnv,
                threadId: M.ThreadId.make("synthetic-thread"),
              },
              watermark: {
                fromEventId: M.EventId.make("e".repeat(63000)),
                toEventId: M.EventId.make("end"),
                throughSequence: 1,
              },
              messageIds: [],
            },
          ],
        },
      });
      const request = pushInput({ ...op, payload });
      const legacy = yield* hub.push(request, principal());
      assert.include(decodeLegacyPushResult(legacy).receipts[0], {
        outcome: "rejected",
        hubSequence: null,
        failureCode: "payload_too_large",
      });
      const updated = yield* hub.push({ ...request, features }, principal());
      assert.include(updated.receipts[0], {
        outcome: "rejected",
        failureCode: "capacity_exceeded",
      });
      assert.propertyVal(updated.receipts[0]?.capacity, "dimension", "payload_bytes");
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
        if (!queued || !M.isMemoryRevisionOperation(queued))
          throw new Error("expected a staged suggestion");
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

  it.effect(
    "a remote forget refuses stale suggestion acceptance and the ordered pull purges it",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const hub = yield* Hub.MemoryHubService;
        const source = newMemory(14);
        yield* hub.push(pushInput(source), principal());
        yield* hub.pull(advertise, principal());
        const peer = principal(otherEnv);
        const initial = yield* hub.pull({ ...advertise, environmentId: otherEnv }, peer);
        assert.strictEqual(initial.derivedCap, 1000);
        yield* Effect.gen(function* () {
          const service = yield* Service.MemoryService;
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const suggestions = makeMemorySaveSuggestions({
            sql,
            store,
            requireSharing: () => Effect.void,
            stableUuid: Service.memoryStableUuid,
          });
          const receive = (page: M.MemoryHubPullResult, expectedSequence: number) =>
            service.receiveHubPage({
              memorySpaceId: space,
              hubEnvironmentId: hubEnv,
              localEnvironmentId: hubEnv,
              page,
              expectedSequence,
              reauthorize: Effect.void,
            });
          yield* receive(initial, 0);
          const op = newMemory(15);
          yield* suggestions.onRefusedSave(
            {
              input: {
                memorySpaceId: space,
                memoryId: op.memoryId,
                operationId: op.operationId,
                expectedHeads: [],
                scope: op.revision.scope,
                assertionKind: op.revision.assertionKind,
                baseBoundary: null,
                payload: op.payload,
              },
              thread: { environmentId: hubEnv, threadId: M.ThreadId.make("stale-origin") },
              reason: "thread_lineage_incomplete",
              knownRevisions: [],
              lineageComplete: false,
              forgetGeneration: 0,
            },
            Effect.void,
          );
          const forgotten = yield* hub.push(
            { ...pushInput(forget(source)), features, environmentId: otherEnv },
            peer,
          );
          assert.include(forgotten.receipts[0], { outcome: "deleted" });
          const target = { memorySpaceId: space, suggestionId: op.memoryId };
          assert.deepStrictEqual(yield* service.acceptSuggestion(target, Effect.void), {
            status: "pending",
          });
          assert.isUndefined((yield* store.loadAggregate(space, op.memoryId)).item);
          const [attempt] = yield* sql<{ accept_operation_id: string }>`
          SELECT accept_operation_id FROM memory_save_suggestions WHERE id=${op.memoryId}`;
          if (!attempt) throw new Error("Expected a frozen acceptance");
          const workId = `sync:${space}:${attempt.accept_operation_id}`;
          const queued = yield* store.readWorkOperation(workId);
          if (!queued || queued.kind !== "upsert") throw new Error("Expected a staged acceptance");
          assert.strictEqual(queued.forgetFence, initial.throughSequence);
          const pushed = yield* hub.push({ ...pushInput(queued), features }, principal());
          const receipt = pushed.receipts[0]!;
          assert.include(receipt, { outcome: "rejected", failureCode: "source_invalidated" });
          yield* service.settleHubAcknowledgement({
            memorySpaceId: space,
            hubEnvironmentId: hubEnv,
            localEnvironmentId: hubEnv,
            workId,
            receipt,
            operation: {
              operationId: queued.operationId,
              operationDigest: memoryOperationDigest(queued),
            },
            reauthorize: Effect.void,
          });
          assert.include(
            (yield* service.listSuggestionMetadata({ memorySpaceId: space }, Effect.void))[0],
            { suggestionId: op.memoryId, state: "accepting" },
          );
          const tail = yield* hub.pull(
            { ...advertise, afterSequence: initial.throughSequence },
            principal(),
          );
          yield* receive(tail, initial.throughSequence);
          assert.deepStrictEqual(
            yield* service.listSuggestionMetadata({ memorySpaceId: space }, Effect.void),
            [],
          );
          assert.isUndefined((yield* store.loadAggregate(space, op.memoryId)).item);
          assert.deepStrictEqual(yield* service.acceptSuggestion(target, Effect.void), {
            status: "refused",
            reason: "source_invalidated",
          });
        }).pipe(Effect.provide(Layer.fresh(core)));
      }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect("a local forget after push discovery removes an unsent incomplete acceptance", () =>
    Effect.gen(function* () {
      yield* seed;
      const hub = yield* Hub.MemoryHubService;
      const sql = yield* SqlClient.SqlClient;
      const member = principal(Member.local);
      yield* sql`UPDATE memory_hub_members SET environment=${Member.local} WHERE environment=${otherEnv}`;
      yield* hub.pull(advertise, principal());
      const source = newMemory(91);
      yield* hub.push({ ...pushInput(source), features }, principal());
      yield* (yield* Compactor.MemoryCompactor).compact(principal());
      const pushed: M.MemoryOperation[] = [];
      const client = Member.peer({
        join: (_connection, input) => hub.join({ ...input, features }, member).pipe(Effect.orDie),
        pull: (_connection, input) => hub.pull({ ...input, features }, member).pipe(Effect.orDie),
        push: (_connection, input) => {
          pushed.push(...input.operations);
          return hub.push({ ...input, features }, member).pipe(Effect.orDie);
        },
      });
      const found = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const draft = newMemory(92);
      const wrapStore = (store: Store.MemoryStore["Service"]) => ({
        ...store,
        readEligibleOutbox: (...args: Parameters<typeof store.readEligibleOutbox>) =>
          store
            .readEligibleOutbox(...args)
            .pipe(
              Effect.tap((rows) =>
                rows.some((row) => row.work.memoryId === draft.memoryId)
                  ? Deferred.succeed(found, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                  : Effect.void,
              ),
            ),
      });
      const memberContext = yield* Layer.build(
        Layer.fresh(
          Member.fixture(client, undefined, undefined, undefined, undefined, undefined, wrapStore),
        ),
      );
      yield* Effect.gen(function* () {
        const store = Context.get(memberContext, Store.MemoryStore);
        const service = Context.get(memberContext, Service.MemoryService);
        const memberSql = Context.get(memberContext, SqlClient.SqlClient);
        const sync = Context.get(memberContext, Sync.MemorySyncService);
        yield* sync.syncOnce;
        assert.include(yield* sync.readLocalReadiness(), { bootstrap: "ready" });
        assert.isUndefined((yield* store.loadAggregate(space, draft.memoryId)).identity);
        const suggestions = makeMemorySaveSuggestions({
          sql: memberSql,
          store,
          requireSharing: () => Effect.void,
          stableUuid: Service.memoryStableUuid,
        });
        yield* suggestions.onRefusedSave(
          {
            input: {
              memorySpaceId: space,
              memoryId: draft.memoryId,
              operationId: draft.operationId,
              expectedHeads: [],
              scope: draft.revision.scope,
              assertionKind: "inference",
              baseBoundary: null,
              payload: draft.payload,
            },
            thread: { environmentId: Member.local, threadId: M.ThreadId.make("synthetic-origin") },
            reason: "thread_lineage_incomplete",
            knownRevisions: [],
            lineageComplete: false,
            forgetGeneration: yield* suggestionForgetGeneration(space).pipe(
              Effect.provideService(SqlClient.SqlClient, memberSql),
            ),
          },
          Effect.void,
        );
        assert.lengthOf(yield* suggestions.listMetadata({ memorySpaceId: space }, Effect.void), 1);
        assert.deepStrictEqual(
          yield* service.acceptSuggestion(
            { memorySpaceId: space, suggestionId: draft.memoryId },
            Effect.void,
          ),
          { status: "pending" },
        );
        const inFlight = yield* Effect.forkScoped(sync.syncOnce);
        yield* Deferred.await(found);
        yield* service.forget(
          {
            memorySpaceId: space,
            memoryId: source.memoryId,
            operationId: M.MemoryOperationId.make(id(19000)),
            expectedHeads: [source.revision.revisionId],
          },
          Effect.void,
        );
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(inFlight);
        assert.isFalse(pushed.some((op) => op.memoryId === draft.memoryId));
        assert.deepStrictEqual(
          yield* memberSql`SELECT 1 FROM memory_payloads WHERE space=${space} AND memory_id=${draft.memoryId}`,
          [],
        );
        yield* sync.syncOnce;
        assert.isTrue(pushed.some((op) => op.kind === "forget" && op.memoryId === source.memoryId));
        yield* sync.shutdown;
      });
      const store = yield* Store.MemoryStore;
      assert.isUndefined((yield* store.loadAggregate(space, newMemory(92).memoryId)).item);
    }).pipe(checkUsage, Effect.provide(live), enabled),
  );

  it.effect.each([101, 1000])(
    "a %s-source summary keeps a promotion only if its ordered closure fits",
    (size) =>
      Effect.gen(function* () {
        yield* seed;
        const hub = yield* Hub.MemoryHubService;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
        yield* hub.pull(advertise, principal());
        yield* hub.pull({ ...advertise, environmentId: otherEnv }, principal(otherEnv));
        const toInput = (op: ReturnType<typeof newMemory>): M.MemoryUpsertInput => ({
          memorySpaceId: space,
          memoryId: op.memoryId,
          operationId: op.operationId,
          scope: op.revision.scope,
          assertionKind: op.revision.assertionKind,
          expectedHeads: [],
          payload: op.payload,
          baseBoundary: null,
        });
        const sources = yield* Effect.forEach(
          Array.from({ length: size }, (_, n) => newMemory(38000 + n)),
          (source) => service.upsert(toInput(source), Effect.void),
        );
        const revisionIds = sources.flatMap(({ receipt }) =>
          "revisionId" in receipt && receipt.revisionId ? [receipt.revisionId] : [],
        );
        assert.lengthOf(revisionIds, size);
        const first = newMemory(38000);
        const firstOp = yield* store.readWorkOperation(`sync:${space}:${first.operationId}`);
        if (!firstOp || firstOp.kind !== "upsert") throw new Error("Expected a source operation");
        yield* sql`UPDATE memory_outbox SET status='completed' WHERE space=${space} AND kind='sync'`;
        const thread = {
          environmentId: hubEnv,
          threadId: M.ThreadId.make("synthetic-promoted-thread"),
        };
        yield* store.appendThreadLineage(thread, space, revisionIds);
        const summary = newMemory(902);
        const eventId = M.EventId.make(id(22000));
        const sourceWatermark = { fromEventId: eventId, toEventId: eventId, throughSequence: 1 };
        const selection = { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" };
        const messageId = M.MessageId.make("synthetic-evidence");
        const input: M.GenerateMemorySummaryInput = {
          cwd: "/synthetic",
          sourceThread: thread,
          sourceWatermark,
          modelSelection: selection,
          messages: [{ messageId, text: "Synthetic source words.", completed: true }],
        };
        const execution = {
          requestedModelSelection: selection,
          providerInstanceId: selection.instanceId,
          environmentId: hubEnv,
          effectiveProvider: M.ProviderDriverKind.make("codex"),
          effectiveModel: selection.model,
        };
        const result = {
          text: "A synthetic summary",
          assertionKind: "fact" as const,
          evidence: [
            {
              origin: "thread" as const,
              sourceThread: thread,
              watermark: sourceWatermark,
              messageIds: [messageId],
            },
          ],
        };
        const work: Store.MemoryWork = {
          id: "synthetic-summary-promotion",
          space,
          memoryId: summary.memoryId,
          kind: "consolidate",
          status: "pending",
          claimedBy: null,
          claimedUntil: null,
          attempt: 0,
          nextAttemptAt: 0,
          payloadRef: null,
          metadata: {
            kind: "summary",
            sourceThread: thread,
            sourceWatermark,
            memoryId: summary.memoryId,
            operationId: summary.operationId,
            revisionId: summary.revision.revisionId,
            modelSelection: selection,
          },
        };
        yield* service.queueSummary(work);
        assert.isTrue(yield* store.claimWork(work.id, "synthetic-worker", 0, 10000));
        const claimed = yield* store.readWork(work.id);
        if (!claimed) throw new Error("Expected a claimed summary");
        yield* service.commitSummary({
          work: claimed,
          input,
          expectedHeads: [],
          recheckSource: Effect.void,
          generated: { execution, result },
          promotions: {
            input,
            execution,
            replace: true,
            project: null,
            candidates: { user: { ...result, text: "Synthetic promotion" }, project: null },
          },
        });
        const promotionId = M.MemoryId.make(
          Service.memoryStableUuid(`${thread.environmentId}:${thread.threadId}:promotion:user`),
        );
        const eligible = store.readEligibleOutbox(space, 0, 100);
        assert.isUndefined((yield* store.loadAggregate(space, summary.memoryId)).item);
        assert.isUndefined((yield* store.loadAggregate(space, promotionId)).item);
        assert.isFalse((yield* eligible).some((row) => row.work.memoryId === promotionId));
        const summaryOp = yield* store.readWorkOperation(`sync:${space}:${summary.operationId}`);
        if (!summaryOp) throw new Error("Expected a staged summary");
        assert.propertyVal(
          (yield* hub.push({ ...pushInput(summaryOp), features }, principal())).receipts[0],
          "outcome",
          "accepted",
        );
        assert.propertyVal(
          (yield* store.loadAggregate(space, summary.memoryId)).item,
          "status",
          "active",
        );
        assert.isUndefined((yield* store.loadAggregate(space, promotionId)).item);
        const candidate = (yield* eligible).find((row) => row.work.memoryId === promotionId);
        if (size === 1000) {
          assert.isUndefined(candidate);
          return;
        }
        assert.isDefined(candidate);
        const promotion = candidate ? yield* store.readWorkOperation(candidate.work.id) : undefined;
        if (!promotion || promotion.kind !== "upsert")
          throw new Error("Expected a staged promotion");
        assert.lengthOf(promotion.payload.derivedFromMemoryRevisions, 102);
        assert.propertyVal(
          (yield* hub.push({ ...pushInput(promotion), features }, principal())).receipts[0],
          "outcome",
          "accepted",
        );
        assert.propertyVal(
          (yield* store.loadAggregate(space, promotionId)).item,
          "status",
          "active",
        );
        assert.propertyVal(
          (yield* hub.push(
            { ...pushInput(forget(firstOp)), features, environmentId: otherEnv },
            principal(otherEnv),
          )).receipts[0],
          "outcome",
          "deleted",
        );
        for (const memoryId of [summary.memoryId, promotionId])
          assert.propertyVal(
            (yield* store.loadAggregate(space, memoryId)).item,
            "status",
            "blocked",
          );
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
