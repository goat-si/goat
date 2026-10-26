import { assert, describe, it } from "@effect/vitest";
import { computerUseReady, type DesktopCuaReadinessReport } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { fixture, HELPER_ID, HELPER_PID, helperTools } from "./DesktopCuaDriver.testkit.ts";

const tools = helperTools({ bundle: HELPER_ID, parent: HELPER_PID });
const ready = (reports: ReadonlyArray<DesktopCuaReadinessReport>) => {
  const latest = reports.at(-1)?.readiness;
  return latest ? computerUseReady(latest) : false;
};

describe("DesktopCuaDriver readiness proof outlives nothing that can change it (readiness-ui F4)", () => {
  it.effect.each(["resume", "unlock-screen"] as const)(
    "drops a passing check's proof when the Mac %s, so the next check proves it again",
    (event) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
          assert.isTrue((yield* test.verify).verified);
          assert.isTrue(ready(test.readiness));

          yield* test.power(event);
          const after = test.readiness.at(-1)?.readiness;
          assert.equal(after?.helper, "unauthenticated");
          assert.equal(after?.capture, "pending");
          assert.isFalse(ready(test.readiness));
          assert.include(after?.reasons.join(" ") ?? "", "Run the readiness check");
        }),
      ),
  );

  it.effect("drops a passing check's proof when a new helper generation is installed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        assert.isTrue((yield* test.verify).verified);
        assert.isTrue(ready(test.readiness));

        // The app update installs a new generation; an agent starts it, not a check.
        yield* test.applyHelperUpdate;
        yield* test.request("after-update");
        assert.equal((yield* test.next).status, "ready");
        const after = test.readiness.at(-1)?.readiness;
        assert.equal(after?.capture, "pending");
        assert.isFalse(ready(test.readiness));
      }),
    ),
  );

  it.effect("keeps a running agent's helper usable after a wake, without its old proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        assert.isTrue((yield* test.verify).verified);
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");

        yield* test.power("resume");
        const after = test.readiness.at(-1)?.readiness;
        // The running helper still serves its turn; only the check's proof is gone.
        assert.equal(after?.helper, "authenticated");
        assert.equal(after?.capture, "pending");
      }),
    ),
  );
});

describe("DesktopCuaDriver readiness captures a window the way live pictures do (readiness-ui F5)", () => {
  it.effect("asks the helper to capture GOAT's own window and passes when it pictures it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools,
          captureCheck: "pictured",
        });
        assert.isTrue((yield* test.verify).verified);
        // GOAT's window from list_windows (HOST_PID 4242, window 77), through the helper.
        assert.deepEqual(test.captureChecks, [{ bundleId: HELPER_ID, pid: 4242, windowId: 77 }]);
      }),
    ),
  );

  it.effect("fails capture when the helper dies capturing, as the CGS_REQUIRE_INIT crash did", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools,
          captureCheck: "crashed",
        });
        const result = yield* test.verify;
        assert.isFalse(result.verified);
        const capture = result.steps.find((step) => step.id === "capture");
        assert.isFalse(capture?.ok);
        assert.include(capture?.ok === false ? capture.detail : "", "code 134");
        assert.isFalse(ready(test.readiness));
      }),
    ),
  );

  it.effect("fails capture with the helper's own answer when it cannot picture the window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools,
          captureCheck: { error: "Screen Recording is off." },
        });
        const result = yield* test.verify;
        const capture = result.steps.find((step) => step.id === "capture");
        assert.isFalse(capture?.ok);
        assert.include(capture?.ok === false ? capture.detail : "", "Screen Recording is off.");
      }),
    ),
  );

  it.effect("skips the extra capture for a helper that does not offer the check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        assert.isTrue((yield* test.verify).verified);
        assert.deepEqual(test.captureChecks, []);
      }),
    ),
  );
});
