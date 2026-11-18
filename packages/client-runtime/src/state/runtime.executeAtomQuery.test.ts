import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import { Atom, AtomRegistry } from "effect/reactivity";

import { executeAtomQuery } from "./runtime.ts";

describe("executeAtomQuery", () => {
  it("keeps concurrent query results correlated to their atoms", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const firstAtom = Atom.make(firstLatch.await.pipe(Effect.as("first")));
    const secondAtom = Atom.make(secondLatch.await.pipe(Effect.as("second")));
    const registry = AtomRegistry.make();

    const firstResult = executeAtomQuery(registry, firstAtom);
    const secondResult = executeAtomQuery(registry, secondAtom);

    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    const [first, second] = await Promise.all([firstResult, secondResult]);
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    if (first._tag === "Success" && second._tag === "Success") {
      expect(first.value).toBe("first");
      expect(second.value).toBe("second");
    }

    registry.dispose();
  });

  it("settles when its caller aborts a waiting query", async () => {
    const registry = AtomRegistry.make();
    const controller = new AbortController();
    const resultPromise = executeAtomQuery(registry, Atom.make(Effect.never), {
      reportDefect: false,
      signal: controller.signal,
    });

    controller.abort();

    const result = await resultPromise;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(result.cause)).toBe(true);
    }
    registry.dispose();
  });
});
