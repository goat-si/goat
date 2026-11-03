import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { liveInCheckPhase } from "./checkPhase.ts";

it.live("turns a check-phase throw into an Effect defect", () =>
  Effect.gen(function* () {
    const error = new Error("check failed");
    const exit = yield* Effect.exit(
      liveInCheckPhase(() => {
        throw error;
      }),
    );
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(error);
  }),
);
