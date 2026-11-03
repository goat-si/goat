import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { bootstrapScenario } from "./serverRuntimeStartup.testkit.ts";

it.effect("startup attaches a retained goal-only Codex instance before readiness", () =>
  Effect.gen(function* () {
    let opened = 0;
    yield* bootstrapScenario(
      "disabled-codex",
      Effect.void,
      undefined,
      Option.none(),
      Effect.succeedNone,
      Effect.void,
      () => {
        opened++;
      },
    );
    assert.equal(opened, 1);
  }),
);

it.effect("a failed detached cleanup does not attempt goal reconnection", () =>
  Effect.gen(function* () {
    let opened = 0;
    yield* bootstrapScenario(
      "disabled-codex",
      Effect.void,
      undefined,
      Option.none(),
      Effect.succeedNone,
      Effect.void,
      () => {
        opened++;
      },
      true,
    );
    assert.equal(opened, 0);
  }),
);
