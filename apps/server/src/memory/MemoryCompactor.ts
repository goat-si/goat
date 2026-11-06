// @effect-diagnostics-next-line nodeBuiltinImport:off -- identifiers for durable checkpoint publication.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Store from "./MemoryStore.ts";
import {
  MemoryHubConfiguration,
  MemoryHubActivity,
  type MemoryHubServiceError,
} from "./MemoryHubService.ts";

/** Staging leaves member bootstrap handles and credentials unchanged. */
export class MemoryHubCheckpointProducer extends Context.Service<
  MemoryHubCheckpointProducer,
  {
    readonly prepareTx: (input: {
      readonly authority: Store.HubAuthority;
      readonly checkpointId: string;
      readonly hubEnvironmentId: M.EnvironmentId;
    }) => Store.InTx<
      { readonly checkpointId: string; readonly checkpointSequence: number },
      MemoryHubServiceError
    >;
  }
>()("goat/memory/MemoryCompactor/MemoryHubCheckpointProducer") {}

export class MemoryCompactor extends Context.Service<
  MemoryCompactor,
  {
    readonly compact: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<Store.HubRetention, MemoryHubServiceError>;
    readonly compactIfNeeded: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<Store.HubRetention, MemoryHubServiceError>;
    /** Publish a fresh checkpoint and remove every covered log row the pressure rule allows. */
    readonly reclaim: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<Store.HubRetention, MemoryHubServiceError>;
    readonly start: (
      principal: M.MemoryHubPrincipal,
    ) => Effect.Effect<void, MemoryHubServiceError, Scope.Scope>;
  }
>()("goat/memory/MemoryCompactor") {}

/** @public Composition shares the existing Store; no independent SQL connection. */
export const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const configuration = yield* MemoryHubConfiguration;
  const activity = yield* MemoryHubActivity;
  const producer = yield* MemoryHubCheckpointProducer;
  const pressured = (principal: M.MemoryHubPrincipal, now: number) =>
    Effect.map(
      store.storeBudgetBytes(principal.environmentId, now),
      (figure) => figure.bytes !== null && figure.bytes >= M.MEMORY_STORE_TARGET_BYTES,
    );
  const run = Effect.fnUntraced(function* (principal: M.MemoryHubPrincipal, force: boolean) {
    return yield* store.transact(
      Effect.gen(function* () {
        const hub = yield* configuration.read;
        if (!hub) return yield* new M.MemoryHubError({ code: "hub_disabled" });
        if (
          hub.memorySpaceId !== principal.memorySpaceId ||
          hub.hubEnvironmentId !== principal.environmentId
        )
          return yield* new M.MemoryHubForbiddenError({});
        yield* store.requireHubMemberTx(principal);
        const now = yield* Clock.currentTimeMillis;
        yield* store.purgeHubTransientTx({
          memorySpaceId: principal.memorySpaceId,
          now,
          limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
        });
        const previous = yield* store.readHubRetentionTx(principal.memorySpaceId);
        const usage = yield* store.readHubUsageTx(principal.memorySpaceId);
        const lastRun = previous.compaction.lastRunAtUtc;
        const pressure = yield* pressured(principal, now);
        if (
          !force &&
          previous.checkpointId !== null &&
          lastRun !== null &&
          now - Date.parse(lastRun) <
            (pressure
              ? M.MEMORY_STORE_PRESSURE_CHECKPOINT_INTERVAL_MS
              : M.MEMORY_CHECKPOINT_INTERVAL_MS) &&
          usage.tailRows < M.MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS &&
          usage.tailBytes < M.MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES
        )
          return previous;
        const authority: Store.HubAuthority = {
          principal,
          now: Clock.currentTimeMillis,
          reauthorize: Effect.asVoid(store.requireHubMemberTx(principal)),
        };
        const handle = yield* producer.prepareTx({
          authority,
          checkpointId: NodeCrypto.randomUUID(),
          hubEnvironmentId: hub.hubEnvironmentId,
        });
        // The Store owns pin details. A failed floor CAS due to another live pin keeps
        // the prior floor while still publishing the complete new recovery snapshot.
        yield* store
          .publishCheckpointAndFloorTx({
            memorySpaceId: principal.memorySpaceId,
            checkpointId: handle.checkpointId,
            expectedFloor: previous.retentionFloor,
            nextFloor: handle.checkpointSequence,
            now,
          })
          .pipe(
            Effect.catchTags({
              MemoryStoreConflict: (error) =>
                error.code === "revision_changed"
                  ? store.publishCheckpointAndFloorTx({
                      memorySpaceId: principal.memorySpaceId,
                      checkpointId: handle.checkpointId,
                      expectedFloor: previous.retentionFloor,
                      nextFloor: previous.retentionFloor,
                      now,
                    })
                  : Effect.fail(error),
            }),
          );
        // Publication/floor and bounded removal commit together. Failure keeps the
        // prior durable checkpoint/floor and never exposes partially staged pages.
        yield* store.compactEligibleHistoryTx({
          memorySpaceId: principal.memorySpaceId,
          expectedFloor: (yield* store.readHubRetentionTx(principal.memorySpaceId)).retentionFloor,
          now,
          limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
          pressure,
        });
        return yield* store.readHubRetentionTx(principal.memorySpaceId);
      }),
    );
  });
  const compact: MemoryCompactor["Service"]["compact"] = Effect.fn("MemoryCompactor.compact")(
    (principal) => run(principal, true),
  );
  const compactIfNeeded: MemoryCompactor["Service"]["compactIfNeeded"] = Effect.fn(
    "MemoryCompactor.compactIfNeeded",
  )((principal) => run(principal, false));
  const reclaim: MemoryCompactor["Service"]["reclaim"] = Effect.fn("MemoryCompactor.reclaim")(
    function* (principal) {
      let retention = yield* run(principal, true);
      // Each pass is its own bounded transaction; a full pass means more rows may be eligible.
      for (
        let pass = 0;
        pass < 64 &&
        retention.compaction.removedRows >= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS &&
        (yield* pressured(principal, yield* Clock.currentTimeMillis));
        pass++
      ) {
        yield* Effect.yieldNow;
        retention = yield* store.transact(
          Effect.gen(function* () {
            yield* store.requireHubMemberTx(principal);
            yield* store.compactEligibleHistoryTx({
              memorySpaceId: principal.memorySpaceId,
              expectedFloor: (yield* store.readHubRetentionTx(principal.memorySpaceId))
                .retentionFloor,
              now: yield* Clock.currentTimeMillis,
              limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
              pressure: true,
            });
            return yield* store.readHubRetentionTx(principal.memorySpaceId);
          }),
        );
      }
      return retention;
    },
  );
  const start: MemoryCompactor["Service"]["start"] = Effect.fn("MemoryCompactor.start")(
    function* (principal) {
      // Subscribe before the startup sweep, so a concurrent commit cannot be lost.
      const changes = yield* store.changes(principal.memorySpaceId);
      const admissions = yield* activity.subscribe;
      yield* compactIfNeeded(principal);
      const sweep = compactIfNeeded(principal).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Memory compaction deferred", { errorTag: error._tag }),
        ),
      );
      yield* Stream.runForEach(changes, () => sweep).pipe(Effect.forkScoped);
      yield* Stream.runForEach(admissions, () => sweep).pipe(Effect.forkScoped);
      const scheduledSweep = Effect.gen(function* () {
        // Signals can move lastRun while the timer is sleeping. On every wake,
        // re-read the durable deadline rather than adding another fixed day.
        const retained = yield* store.transact(store.readHubRetentionTx(principal.memorySpaceId));
        const now = yield* Clock.currentTimeMillis;
        const lastRun = retained.compaction.lastRunAtUtc;
        const deadline =
          lastRun === null ? now : Date.parse(lastRun) + M.MEMORY_CHECKPOINT_INTERVAL_MS;
        // Wake at least hourly so a store that crosses its target while idle is cleaned; the
        // sweep's own gate decides whether that wake runs anything.
        yield* Effect.sleep(
          Math.max(
            0,
            Math.min(deadline, now + M.MEMORY_STORE_PRESSURE_CHECKPOINT_INTERVAL_MS) - now,
          ),
        );
        yield* sweep;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Memory compaction timer deferred", { errorTag: error._tag }),
        ),
        // A failed due sweep must not spin on an unchanged past deadline.
        Effect.andThen(
          Effect.gen(function* () {
            const retained = yield* store.transact(
              store.readHubRetentionTx(principal.memorySpaceId),
            );
            const now = yield* Clock.currentTimeMillis;
            const lastRun = retained.compaction.lastRunAtUtc;
            if (lastRun === null || Date.parse(lastRun) + M.MEMORY_CHECKPOINT_INTERVAL_MS <= now)
              yield* Effect.sleep(M.MEMORY_CHECKPOINT_INTERVAL_MS);
          }).pipe(Effect.catch(() => Effect.sleep(M.MEMORY_CHECKPOINT_INTERVAL_MS))),
        ),
      );
      yield* scheduledSweep.pipe(Effect.forever, Effect.forkScoped);
    },
  );
  return MemoryCompactor.of({ compact, compactIfNeeded, reclaim, start });
});

const producerLayer = Layer.effect(
  MemoryHubCheckpointProducer,
  Effect.map(Store.MemoryStore, (store) =>
    MemoryHubCheckpointProducer.of({ prepareTx: store.prepareHubProducerCheckpointTx }),
  ),
);

export const layer = Layer.effect(MemoryCompactor, make).pipe(Layer.provideMerge(producerLayer));
