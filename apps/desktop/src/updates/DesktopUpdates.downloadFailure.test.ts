import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("shows why a download failed, not only the channel", () => {
    const harness = makeHarness({
      downloadUpdate: Effect.fail(
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: "nightly",
          cause: new Error("net::ERR_CONTENT_LENGTH_MISMATCH"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isFalse(result.completed);

        const state = yield* updates.getState;
        assert.equal(state.errorContext, "download");
        assert.include(state.message ?? "", "ERR_CONTENT_LENGTH_MISMATCH");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
