import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { makeCodexContextRestores } from "./CodexContextRestores.ts";

it.effect("retries a failed restore before allowing a start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(yield* Scope.Scope);
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

it.effect.each(["pending", "compactions"] as const)("fails closed on %s overflow", (kind) =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(yield* Scope.Scope);
      for (let i = 0; i < 257; i++) {
        if (kind === "pending") yield* restores.fork(String(i), Effect.never);
        else restores.mark(String(i), String(i));
      }
      const result = yield* Effect.exit(restores.wait("overflow"));
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(Cause.pretty(result.cause), "capacity exceeded");
    }),
  ),
);

it.effect("keeps a failed restore recoverable on a later start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const restores = makeCodexContextRestores(yield* Scope.Scope);
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
      const restores = makeCodexContextRestores(yield* Scope.Scope);
      yield* restores.fork("one", Effect.die("broken"));
      const result = yield* Effect.exit(restores.wait("one"));
      assert.isTrue(Exit.isFailure(result));
    }),
  ),
);
