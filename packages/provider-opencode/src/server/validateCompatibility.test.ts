import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { ProviderHost } from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import { validateOpenCodeCompatibility } from "./validateCompatibility.ts";

it.effect(
  "the same detected OpenCode version is refused or accepted as the host policy changes",
  () =>
    Effect.gen(function* () {
      let broken = true;
      const host = {
        compatibility: () =>
          Effect.succeed({
            status: broken ? ("broken" as const) : ("supported" as const),
            message: null,
            recommendedVersion: null,
            recommendedRange: ">=1.14.19",
          }),
      } as unknown as ProviderHost["Service"];
      const instance = ProviderInstanceId.make("opencode");
      const error = yield* Effect.flip(validateOpenCodeCompatibility(host, instance, "1.14.18"));
      assert.include(error.detail, ">=1.14.19");
      broken = false;
      yield* validateOpenCodeCompatibility(host, instance, "1.14.18");
    }),
);
