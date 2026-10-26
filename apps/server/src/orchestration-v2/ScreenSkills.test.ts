import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveAttachedScreenSkills, screenSurfaceAttached } from "./ScreenSkills.ts";

it.effect("a browser-only turn carries screen-code without a desktop driver", () =>
  Effect.gen(function* () {
    const browserOnly = {
      browserToolsAvailable: true,
      usableThread: true,
      computerUseAttached: false,
    };
    assert.isTrue(screenSurfaceAttached(browserOnly));
    const builtInSkills = yield* resolveAttachedScreenSkills({
      ...browserOnly,
      serverSettings: Option.none(),
      projectId: undefined,
      requested: ["browser"],
    });
    assert.deepEqual(builtInSkills, ["screen-code"]);
  }),
);
