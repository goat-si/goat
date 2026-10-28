import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { Interruption } from "./ComputerUseLeaseMessages.ts";
import { makeUnansweredWatch } from "./ComputerUseLeaseProxyUnanswered.ts";

it.effect("a stale chain's cleanup never lifts the current chain's privacy fence", () =>
  Effect.gen(function* () {
    const lifecycle: { current: { readonly connectionId: string } | undefined } = {
      current: { connectionId: "chain:b" },
    };
    const interrupted: Array<Interruption> = [];
    const watch = makeUnansweredWatch(
      {
        lock: yield* Semaphore.make(1),
        scope: yield* Scope.make(),
        outstanding: new Map(),
        lifecycle,
      },
      {
        active: () => true,
        interrupt: (cause) =>
          Effect.sync(() => {
            interrupted.push(cause);
            lifecycle.current = undefined;
            return interrupted.length;
          }),
        start: () => Effect.void,
        end: () => Effect.void,
        fenced: () => undefined,
      },
    );
    // The current chain turned private; a cleanup for the chain it replaced runs after that.
    watch.fenceTarget("private", "chain:b");
    yield* watch.closeTarget("takeover", "chain:a");
    assert.isTrue(watch.blocks("chain:b"));
    assert.deepEqual(interrupted, []);
    // The current chain's own closure still cuts it off.
    yield* watch.closeTarget("private", "chain:b");
    assert.equal(interrupted.length, 1);
  }),
);
