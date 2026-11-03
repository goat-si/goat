import { it as effectIt } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect.each([false, true])(
  "reports a session-open failure with OOM attribution only when marked (%s)",
  (oomKilled) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        openFailure: new Error("provider session rejected"),
        oomKilled,
      });
      yield* harness.start;
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            message: oomKilled ? "Killed: out of memory." : "provider session rejected",
            ...(oomKilled ? { code: "oom_kill" } : {}),
          },
        },
      ]);
    }),
);
