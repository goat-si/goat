import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { ComputerUseHelperError } from "./ComputerUseHelper.ts";
import { fixture, HELPER_BUNDLE, HELPER_ID } from "./DesktopCuaDriver.testkit.ts";

describe("DesktopCuaDriver grants for setup", () => {
  it.effect("reports the helper's own grants for setup, never GOAT's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // GOAT holds no grants and the helper holds both: setup must see the helper's answer.
        const helper = yield* fixture({
          platform: "darwin",
          denyPermissions: true,
          helper: { granted: true },
        });
        const grants = yield* helper.grants;
        assert.deepEqual(grants, {
          principal: "helper",
          name: "GOAT Computer Use",
          bundlePath: HELPER_BUNDLE,
          bundleId: HELPER_ID,
          accessibility: true,
          screenRecording: true,
        });
        // Read without prompting, from a fresh helper each time.
        yield* helper.grants;
        assert.deepEqual(helper.helperProbes, [
          { bundleId: HELPER_ID, prompt: false },
          { bundleId: HELPER_ID, prompt: false },
        ]);

        const broken = yield* fixture({ platform: "darwin", helper: "unusable" });
        assert.deepEqual(yield* broken.grants, {
          principal: "unusable",
          message: "GOAT Computer Use at /Helpers cannot be used (EACCES).",
        });

        // A build without the helper still runs as GOAT, so GOAT's grants are the ones to set up.
        const app = yield* fixture({ platform: "darwin", denyPermissions: true });
        const own = yield* app.grants;
        assert.equal(own.principal, "app");
        assert.isFalse(own.principal === "app" && own.accessibility);
        assert.isEmpty(app.helperProbes);
      }),
    ),
  );

  it.effect(
    "reports a helper that answers as another app or garbled as unusable, and retries one that vanished",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const mismatched = yield* fixture({
            platform: "darwin",
            helper: {
              granted: true,
              fails: new ComputerUseHelperError(
                "bundle_mismatch",
                "GOAT Computer Use is si.goat.desktop.dev.computer-use, expected codes.t3.host-test.computer-use.",
              ),
            },
          });
          assert.deepEqual(yield* mismatched.grants, {
            principal: "unusable",
            message:
              "GOAT Computer Use cannot be used: GOAT Computer Use is si.goat.desktop.dev.computer-use, expected codes.t3.host-test.computer-use.",
          });

          const vanished = yield* fixture({
            platform: "darwin",
            helper: {
              granted: true,
              fails: new ComputerUseHelperError("helper_exited", "The helper exited."),
            },
          });
          const exit = yield* Effect.exit(vanished.grants);
          assert.isTrue(Exit.isFailure(exit));

          // decodeGrants throws a plain schema error for an answer of the wrong shape.
          const malformed = yield* fixture({
            platform: "darwin",
            helper: { granted: true, fails: new Error('Expected boolean, got "yes"') },
          });
          assert.deepEqual(yield* malformed.grants, {
            principal: "unusable",
            message:
              "GOAT Computer Use cannot be used: its answer about permissions could not be read.",
          });
        }),
      ),
  );
});
