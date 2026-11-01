import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { database, fixture, serviceLayer } from "./ComputerUseCallReservations.testkit.ts";
import { foregroundGrant } from "./ComputerUseForeground.testkit.ts";

const withSettings = (cuaStrictInputGuards: boolean) =>
  Layer.mergeAll(
    serviceLayer,
    database,
    ServerSettings.ServerSettingsService.layerTest({
      enableCua: true,
      cuaDeniedApps: ["com.example.Blocked"],
      cuaStrictInputGuards,
    }),
  );
const FOREGROUND = { pid: 43, window_id: 8, dispatch: "foreground" };
const LAUNCH_DENIED = { bundle_id: "com.example.Blocked" };

describe("reservation admission follows the strict input guards setting", () => {
  it.effect(
    "without strict guards foreground and denied apps are admitted with a relaxed scope",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const foreground = yield* f.reserve(f.b, FOREGROUND, "click");
        assert.equal(foreground.status, "admitted");
        if (foreground.status === "admitted")
          assert.equal(foreground.permissions?.strictInputGuards, false);
        assert.equal((yield* f.reserve(f.b, LAUNCH_DENIED, "launch_app")).status, "admitted");
      }).pipe(Effect.provide(withSettings(false))),
  );

  it.effect("with strict guards the same calls are refused before admission", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.deepEqual(yield* f.reserve(f.b, FOREGROUND, "click"), {
        status: "refused",
        detail: "foreground_not_approved",
      });
      // Granted foreground, the launch reaches the denied-apps check.
      const focus = yield* foregroundGrant(f.b, "handoff:strict-denied");
      assert.deepInclude(
        yield* f.reserve(f.b, LAUNCH_DENIED, "launch_app", "driver:1", 0, focus.handoffId),
        { status: "refused", detail: "app_not_allowed" },
      );
    }).pipe(Effect.provide(withSettings(true))),
  );
});
