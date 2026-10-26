import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

const feedsAfterConfigure = (env: Record<string, string>) => {
  const harness = makeHarness({ env });
  return Effect.scoped(
    DesktopUpdates.DesktopUpdates.pipe(Effect.flatMap((updates) => updates.configure)),
  ).pipe(Effect.provide(harness.layer), Effect.as(harness.feedUrls()));
};

describe("DesktopUpdates feed", () => {
  // Pointing electron-updater at a feed constructs it, and an unpackaged Linux dev build's
  // "0.0" version makes that throw at startup.
  it.effect("sets the mock feed only when updates are enabled (#1545)", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* feedsAfterConfigure({ GOAT_DISABLE_AUTO_UPDATE: "true" }), []);
      assert.deepEqual(yield* feedsAfterConfigure({}), [
        { provider: "generic", url: "http://localhost:4141" },
      ]);
    }),
  );
});
