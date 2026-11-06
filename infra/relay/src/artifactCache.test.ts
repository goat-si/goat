import { assert, it } from "@effect/vitest";
import * as Artifacts from "alchemy/Artifacts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

it.effect("propagates an artifact computation failure to later callers", () =>
  Effect.gen(function* () {
    const cached = Artifacts.cached("bundle");
    const first = yield* Effect.result(cached(Effect.fail("bundle failed")));
    const second = yield* Effect.result(cached(Effect.succeed("unexpected")));
    assert.isTrue(Result.isFailure(first));
    assert.isTrue(Result.isFailure(second));
    if (Result.isFailure(second)) assert.equal(second.failure, "bundle failed");
  }).pipe(
    Effect.provideService(
      Artifacts.Artifacts,
      Artifacts.makeScopedArtifacts(Artifacts.createArtifactStore(), "test"),
    ),
  ),
);
