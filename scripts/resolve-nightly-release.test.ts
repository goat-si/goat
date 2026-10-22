import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveNightlyTargetVersion } from "./resolve-nightly-release.ts";

it.effect("keeps the stable core as the nightly target version", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveNightlyTargetVersion("0.0.17"), "0.0.17");
    assert.equal(yield* resolveNightlyTargetVersion("9.9.9-smoke.0"), "9.9.9");
    assert.equal(yield* resolveNightlyTargetVersion("1.2.3-beta.4+build.9"), "1.2.3");
  }),
);
