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
    "drops a passing check's proof when the Mac %s, and says GOAT proves it again by itself",
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
          const reasons = after?.reasons.join(" ") ?? "";
          assert.include(reasons, "GOAT proves them again by itself");
          assert.notInclude(reasons, "Run the readiness check");
        }),
      ),
  );

  it.effect.each(["resume", "unlock-screen"] as const)(
    "re-proves a proof the Mac's %s dropped before the next agent start, and the agent's driver starts",
    (event) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
          assert.isTrue((yield* test.verify).verified);
          yield* test.power(event);
          assert.isFalse(ready(test.readiness));

          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          // The same check a person runs, through its own helper, then the agent's helper.
          assert.deepEqual(
            test.helperLaunches.map(({ verify }) => verify),
            [true, true, false],
          );
          assert.isTrue(ready(test.readiness));
        }),
      ),
  );

  it.effect("proves capture and the tree on the first agent start after GOAT starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        assert.isTrue(ready(test.readiness));

        // Proven once: a later start of the same helper does not check again.
        yield* test.request("detach", false);
        assert.equal((yield* test.next).status, "stopped");
        yield* test.request("again");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(
          test.helperLaunches.map(({ verify }) => verify),
          [true, false, false],
        );
      }),
    ),
  );

  it.effect("starts the agent's driver when the automatic check cannot prove capture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools,
          blankCapture: true,
        });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        const after = test.readiness.at(-1)?.readiness;
        assert.equal(after?.capture, "blank");
        assert.isFalse(ready(test.readiness));
      }),
    ),
  );

  it.effect("stops at a grant macOS really took away and names it, without checking capture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        assert.isTrue((yield* test.verify).verified);
        yield* test.answerAsHelper({ granted: false });
        yield* test.power("resume");

        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.deepEqual(report.status === "unavailable" ? report.block : undefined, {
          reason: "permissionsNotGranted",
          missing: ["accessibility", "screenRecording"],
          holder: "helper",
        });
        // Only the person's first check ran; nothing started without the grants.
        assert.deepEqual(
          test.helperLaunches.map(({ verify }) => verify),
          [true],
        );
        const reasons = test.readiness.at(-1)?.readiness.reasons.join(" ") ?? "";
        assert.include(
          reasons,
          "Accessibility and Screen Recording are not on for GOAT Computer Use",
        );
        // The grant is what the person fixes; no check would help before it.
        assert.notInclude(reasons, "readiness check");
      }),
    ),
  );

  it.effect(
    "re-proves a proof a new helper generation dropped before the agent's driver starts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
          assert.isTrue((yield* test.verify).verified);
          assert.isTrue(ready(test.readiness));

          // The app update installs a new generation; an agent starts it, not a check.
          yield* test.applyHelperUpdate;
          yield* test.request("after-update");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(
            test.helperLaunches.map(({ verify, driverPath }) => [
              verify,
              driverPath.includes("/new"),
            ]),
            [
              [true, false],
              [true, true],
              [false, true],
            ],
          );
          assert.isTrue(ready(test.readiness));
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
