import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { awaitHistory, scheduleHistory } from "./ComputerUseHistoryBackground.ts";

it.effect("does not wait for a blocked history write and lets settlement await it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* scheduleHistory(
      "ticket:blocked",
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    yield* Deferred.await(started);
    const waiting = yield* awaitHistory("ticket:blocked").pipe(Effect.forkChild);
    assert.isFalse(yield* Deferred.isDone(release));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(waiting);
  }),
);

it.effect("settlement can continue after a history write fails", () =>
  Effect.gen(function* () {
    yield* scheduleHistory("ticket:failed", Effect.fail("storage unavailable"));
    yield* awaitHistory("ticket:failed");
  }),
);

it.effect("interrupts a blocked background write when its server scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    yield* scheduleHistory(
      "ticket:server-close",
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(blocked))),
      scope,
    );
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    yield* awaitHistory("ticket:server-close");
  }),
);

it.effect("clears bookkeeping when a write is scheduled into a closed server scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.close(scope, Exit.void);
    yield* scheduleHistory("ticket:closed-scope", Effect.never, scope);
    yield* awaitHistory("ticket:closed-scope");
  }),
);
