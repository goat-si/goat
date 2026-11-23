import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import { makeCodexContextRestores } from "./CodexContextRestores.ts";

it.effect("retries a failed restore before allowing a start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(
        yield* Scope.Scope,
        yield* Ref.make(new Map([["affected", {}]])),
      );
      let attempts = 0;
      yield* restores.fork(
        "one",
        Effect.suspend(() => (++attempts === 1 ? Effect.fail("failed") : Effect.void)),
      );
      yield* restores.wait("one");
      assert.equal(attempts, 2);
      yield* restores.wait("one");
      assert.equal(attempts, 2);
    }),
  ),
);

it.effect("unloading a thread frees failed restores and its compaction marker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(
        yield* Scope.Scope,
        yield* Ref.make(new Map([["affected", {}]])),
      );
      for (let i = 0; i < 256; i++) yield* restores.fork(String(i), Effect.fail("failed"));
      yield* restores.mark("0", "old-compaction");
      yield* restores.clear("0");
      assert.isUndefined(restores.take("0"));
      yield* restores.fork("new", Effect.void);
      yield* restores.wait("new");
    }),
  ),
);

it.effect.each(["pending", "compactions"] as const)(
  "scopes %s overflow to the affected thread until it recovers",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const restores = makeCodexContextRestores(
          yield* Scope.Scope,
          yield* Ref.make(new Map([["affected", {}]])),
        );
        for (let i = 0; i < 256; i++) {
          if (kind === "pending") yield* restores.fork(String(i), Effect.fail("failed"));
          else yield* restores.mark(String(i), String(i));
        }
        if (kind === "pending") yield* restores.fork("affected", Effect.void);
        else yield* restores.mark("affected", "overflow");
        yield* restores.wait("unrelated");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(restores.wait("affected"))));
        yield* restores.clear("0");
        yield* restores.fork("affected", Effect.void);
        yield* restores.wait("affected");
      }),
    ),
);

it.effect("keeps a failed restore recoverable on a later start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(
        yield* Scope.Scope,
        yield* Ref.make(new Map([["affected", {}]])),
      );
      let attempts = 0;
      yield* restores.fork(
        "one",
        Effect.suspend(() => (++attempts <= 2 ? Effect.fail("failed") : Effect.void)),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(restores.wait("one"))));
      assert.equal(attempts, 2);
      yield* restores.wait("one");
      assert.equal(attempts, 3);
    }),
  ),
);

it.effect("does not strand a waiting start when restoration defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(
        yield* Scope.Scope,
        yield* Ref.make(new Map([["affected", {}]])),
      );
      yield* restores.fork("one", Effect.die("broken"));
      const result = yield* Effect.exit(restores.wait("one"));
      assert.isTrue(Exit.isFailure(result));
    }),
  ),
);

it.effect("unloading interrupts an in-flight restore before it can inject later", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(yield* Scope.Scope, yield* Ref.make(new Map()));
      const finished = yield* Deferred.make<void>();
      yield* restores.fork(
        "one",
        Effect.never.pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
      );
      yield* restores.clear("one");
      assert.isTrue(yield* Deferred.isDone(finished));
    }),
  ),
);

it.effect("unloading interrupts a retry already in progress", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(yield* Scope.Scope, yield* Ref.make(new Map()));
      const entered = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      let attempts = 0;
      yield* restores.fork(
        "one",
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail("failed")
            : Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finished, undefined)),
              ),
        ),
      );
      const waiting = yield* restores
        .wait("one")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* restores.clear("one");
      assert.isTrue(yield* Deferred.isDone(finished));
      yield* Fiber.join(waiting);
    }),
  ),
);
