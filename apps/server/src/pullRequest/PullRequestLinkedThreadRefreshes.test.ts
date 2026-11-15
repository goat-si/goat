import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { makeService } from "./pullRequestTestFixtures.ts";

it.effect(
  "a subscriber busy refetching gets the newest linked-thread revision, not one refresh per archived thread",
  () =>
    Effect.gen(function* () {
      const service = yield* makeService({ projects: [], providers: [] });
      const received = yield* Queue.unbounded<number>();
      const refetched = yield* Deferred.make<void>();
      // Like an open pull request list, the subscriber refetches before it reads the next signal.
      yield* service.subscribeLinkedThreadRefreshes.pipe(
        Stream.runForEach((revision) =>
          Queue.offer(received, revision).pipe(Effect.andThen(Deferred.await(refetched))),
        ),
        Effect.forkScoped,
      );
      yield* service.notifyLinkedThreadsChanged;
      assert.strictEqual(yield* Queue.take(received), 1);

      // Archiving ten threads while that refetch runs.
      for (let index = 0; index < 10; index += 1) yield* service.notifyLinkedThreadsChanged;
      yield* Deferred.succeed(refetched, undefined);
      const afterRefetch: Array<number> = [];
      while (afterRefetch.at(-1) !== 11) afterRefetch.push(yield* Queue.take(received));
      // A held revision, one handed to the waiting subscriber, and the newest one at most.
      assert.isAtMost(afterRefetch.length, 3);
    }).pipe(Effect.scoped),
);
