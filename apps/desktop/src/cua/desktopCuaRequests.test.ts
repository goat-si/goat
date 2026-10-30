import type { DesktopCuaDriverRequest } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeStopFirstRequests } from "./desktopCuaRequests.ts";

const request = (requestId: string, enabled = true): DesktopCuaDriverRequest => ({
  version: 1,
  type: "cuaDriverRequest",
  requestId,
  enabled,
});

/** A driver whose start handler hands out its signal and then runs until it is cut off. */
const harness = Effect.gen(function* () {
  const requests = makeStopFirstRequests();
  const queue = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const lock = yield* Semaphore.make(1);
  const started = yield* Deferred.make<AbortSignal | undefined>();
  const retired = yield* Deferred.make<void>();
  let retires = 0;
  const scope = yield* Scope.make();
  yield* requests
    .handle(
      Stream.fromQueue(queue),
      (handled) =>
        handled.enabled
          ? Deferred.succeed(started, requests.signal()).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      lock.withPermits(1),
      () => {
        retires++;
        Deferred.doneUnsafe(retired, Exit.void);
      },
    )
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.forkIn(scope));
  return {
    send: (sent: DesktopCuaDriverRequest) => Queue.offer(queue, sent),
    started: Deferred.await(started),
    retired: Deferred.await(retired),
    retires: () => retires,
    close: Scope.close(scope, Exit.void),
  };
});

describe("desktop computer use requests", () => {
  it.effect("a Stop cuts short only the start it names, while that start still runs", () =>
    Effect.gen(function* () {
      const driver = yield* harness;
      yield* driver.send(request("a"));
      const signal = yield* driver.started;
      yield* driver.send(request("b", false));
      yield* driver.send(request("a", false));
      yield* driver.retired;
      assert.isTrue(signal?.aborted);
      assert.equal(driver.retires(), 1);
      yield* driver.close;
    }),
  );

  it.effect("closing the driver aborts the work of the start it was handling", () =>
    Effect.gen(function* () {
      const driver = yield* harness;
      yield* driver.send(request("a"));
      const signal = yield* driver.started;
      assert.isFalse(signal?.aborted);
      yield* driver.close;
      assert.isTrue(signal?.aborted);
      assert.equal(driver.retires(), 0);
    }),
  );
});
