import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeStorageCleanupWorker } from "./storageCleanupWorker.ts";
import {
  cleanupFixture,
  cleanupTestLayer,
  LEGACY_WORKTREE_RULES,
} from "./storageCleanup.testkit.ts";
import { at, shell } from "./storageCleanup.testFixtures.ts";

it.effect("deletion schedules checkpoint cleanup even when worktree deletion is disabled", () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture({
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      ...LEGACY_WORKTREE_RULES,
      worktreeOnDelete: false,
    });
    const release = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    const deleted = {
      id: EventId.make("deleted-wake"),
      type: "thread.deleted",
      threadId: ThreadId.make("deleted"),
      occurredAt: at(0),
      payload: shell({ deletedAt: at(0) }),
    } as unknown as OrchestrationV2DomainEvent;
    yield* fixture.activate(
      Stream.fromEffect(Deferred.await(release)).pipe(
        Stream.flatMap(() => Stream.make(deleted)),
        Stream.concat(Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain)),
      ),
    );
    yield* fixture.service.reports.pipe(
      Stream.filter((report) => report !== null),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* fixture.service.drain;
    const before = fixture.checkpointReads();
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(delivered);
    yield* fixture.service.drain;
    expect(fixture.checkpointReads()).toBe(before + 1);
  }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
);

it.effect("coalesces a burst of deletion wakes to one pending sweep", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let runs = 0;
      const worker = yield* makeStorageCleanupWorker((trigger) =>
        Effect.gen(function* () {
          runs++;
          if (runs === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return {
            trigger,
            startedAt: "2026-01-01T00:00:00Z",
            finishedAt: "2026-01-01T00:00:00Z",
            entries: [],
            counts: { removed: 0, kept: 0, failed: 0 },
            bytesFreed: 0,
            omittedCount: 0,
          };
        }),
      );
      yield* worker.requestSweep;
      yield* Deferred.await(started);
      for (let index = 0; index < 32; index++) yield* worker.requestSweep;
      yield* Deferred.succeed(release, undefined);
      yield* worker.drain;
      expect(runs).toBe(2);
    }),
  ),
);
