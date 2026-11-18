import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeV8 from "node:v8";
import * as NodeVM from "node:vm";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { makeEnvironmentQueryHarness, readEnvironmentQuery } from "./runtimeTestSupport.ts";

describe("query revalidation", () => {
  it.effect("revalidates a stale directly mounted query after reopening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let executions = 0;
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => ++executions),
          {
            idleTtlMs: 60_000,
            staleTimeMs: 5_000,
          },
        );
        const registry = AtomRegistry.make({ timeoutResolution: 100 });
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const read = readEnvironmentQuery(registry, harness.atom);
        const unmount = registry.mount(harness.atom);
        expect(yield* read).toBe(1);
        unmount();
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(6_000);
        yield* Effect.yieldNow;
        const remount = registry.mount(harness.atom);
        yield* Effect.addFinalizer(() => Effect.sync(remount));
        yield* Effect.yieldNow;
        vi.advanceTimersByTime(0);
        yield* Effect.yieldNow;
        expect(yield* read).toBe(2);
      }),
    ),
  );

  it.effect("does not revalidate after a transient derived reader gap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        let executions = 0;
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => ++executions),
          {
            idleTtlMs: 15_000,
            staleTimeMs: 5_000,
          },
        );
        const registry = AtomRegistry.make({ timeoutResolution: 100 });
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const toggle = Atom.make(true).pipe(Atom.keepAlive);
        const derived = Atom.make((get) => (get(toggle) ? get(harness.atom) : null));
        const unmount = registry.mount(derived);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        const read = readEnvironmentQuery(registry, harness.atom);
        expect(yield* read).toBe(1);
        vi.advanceTimersByTime(6_000);
        registry.set(toggle, false);
        vi.advanceTimersByTime(1_000);
        registry.set(toggle, true);
        yield* Effect.yieldNow;
        expect(executions).toBe(1);
      }),
    ),
  );
  it.effect("keeps its cache when collected while unmounted, inside its stale time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        NodeV8.setFlagsFromString("--expose-gc");
        const gc = NodeVM.runInNewContext("gc") as () => void;
        using _now = vi.spyOn(Date, "now").mockReturnValue(0);
        let fetches = 0;
        const harness = yield* makeEnvironmentQueryHarness(
          Effect.sync(() => {
            fetches += 1;
            return fetches;
          }),
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        // `Atom.family` holds members weakly, so the test must hold none: another environment
        // than `harness.atom`'s, which the harness holds.
        const environmentId = EnvironmentId.make("unheld-environment");
        const query = () => harness.family({ environmentId, input: undefined });
        const first = new WeakRef(query());
        const remount = Effect.gen(function* () {
          const unmount = registry.mount(query());
          yield* Effect.yieldNow;
          const value = yield* readEnvironmentQuery(registry, query());
          unmount();
          return value;
        });
        // A WeakRef target survives until the current job ends, so collect after it.
        const collect = Effect.yieldNow.pipe(Effect.andThen(Effect.sync(gc)));

        expect(yield* remount).toBe(1);
        yield* collect;
        expect(yield* remount).toBe(1);
        yield* collect;
        expect(first.deref()).toBe(query());
        expect(fetches).toBe(1);
      }),
    ),
  );
});
