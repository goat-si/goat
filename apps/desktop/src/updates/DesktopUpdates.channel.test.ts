import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates track switches", () => {
  it.effect("keeps the current track's offers when a track switch fails to save", () => {
    const harness = makeHarness({
      setUpdateChannelError: new DesktopAppSettings.DesktopSettingsWriteError({
        operation: "replace-settings-file",
        path: "desktop-settings.json",
        cause: new Error("rename failed"),
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);
        assert.equal(error._tag, "DesktopUpdateChannelPersistenceError");
        assert.equal((yield* updates.getState).channel, "latest");

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
