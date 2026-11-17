import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { makeHarness } from "../testkit/ThreadLaunchHarness.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import { CommitGuard } from "./CommitGuard.ts";
import { PreparationClaims } from "./PreparationClaims.ts";
import { orphanRun, runStatus } from "./PreparationOrphans.testkit.ts";

it.effect(
  "a pending mark waits for the thread's lock while a dispatch on that thread commits",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const claims = yield* PreparationClaims;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId, runId } = yield* orphanRun("lock-order");
      const inCommit = yield* Deferred.make<void>();
      const letGo = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      // The guard runs inside the dispatch's commit, under the thread's lock.
      const dispatching = yield* threads
        .dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make("command:lock-order:fail"),
          threadId,
          runId,
          failure: makeProviderFailure({ message: "Held inside its commit." }),
        })
        .pipe(
          Effect.provideService(
            CommitGuard,
            () => () =>
              Deferred.succeed(inCommit, undefined).pipe(Effect.andThen(Deferred.await(letGo))),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(inCommit);
      const marking = yield* Effect.scoped(
        claims
          .pending(threadId)
          .pipe(Effect.andThen(Ref.update(order, (entries) => [...entries, "mark recorded"]))),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Ref.update(order, (entries) => [...entries, "commit released"]);
      yield* Deferred.succeed(letGo, undefined);
      yield* Fiber.join(dispatching);
      yield* Fiber.join(marking);
      assert.deepEqual(yield* Ref.get(order), ["commit released", "mark recorded"]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "a caller interrupted while waiting for the thread's lock leaves at once with no mark, and the lock's holder goes on",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const claims = yield* PreparationClaims;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId, runId } = yield* orphanRun("interrupted-mark");
      const inCommit = yield* Deferred.make<void>();
      const letGo = yield* Deferred.make<void>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const log = (entry: string) => Ref.update(order, (entries) => [...entries, entry]);
      const dispatching = yield* threads
        .dispatch({
          type: "prepared-run.fail",
          commandId: CommandId.make("command:interrupted-mark:fail"),
          threadId,
          runId,
          failure: makeProviderFailure({ message: "Held inside its commit." }),
        })
        .pipe(
          Effect.provideService(
            CommitGuard,
            () => () =>
              Deferred.succeed(inCommit, undefined).pipe(Effect.andThen(Deferred.await(letGo))),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(inCommit);
      const marking = yield* Effect.scoped(
        claims.pending(threadId).pipe(Effect.andThen(log("mark recorded"))),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const interrupting = yield* Fiber.interrupt(marking).pipe(
        Effect.andThen(log("interrupt returned")),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* log("commit released");
      yield* Deferred.succeed(letGo, undefined);
      yield* Fiber.join(interrupting);
      yield* Fiber.join(dispatching);
      assert.deepEqual(yield* Ref.get(order), ["interrupt returned", "commit released"]);
      assert.isFalse(yield* claims.isPending(threadId));
      assert.equal(yield* runStatus(threadId, runId), "failed");
    }).pipe(Effect.provide(harness.layer));
  },
);
