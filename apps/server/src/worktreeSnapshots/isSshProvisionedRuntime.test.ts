import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { isSshProvisionedRuntime } from "./isSshProvisionedRuntime.ts";

it.effect("detects the SSH launch origin", () =>
  Effect.gen(function* () {
    const previous = process.env.GOAT_RUNTIME_ORIGIN;
    try {
      delete process.env.GOAT_RUNTIME_ORIGIN;
      assert.isFalse(yield* isSshProvisionedRuntime);
      process.env.GOAT_RUNTIME_ORIGIN = "ssh";
      assert.isTrue(yield* isSshProvisionedRuntime);
    } finally {
      if (previous === undefined) delete process.env.GOAT_RUNTIME_ORIGIN;
      else process.env.GOAT_RUNTIME_ORIGIN = previous;
    }
  }),
);
