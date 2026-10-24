import { assert, describe, it } from "@effect/vitest";
import { computerUseReady } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";
import {
  fixture,
  helperTools,
  healthyTools,
  toolResult,
  HELPER_BUNDLE,
  HELPER_ID,
  HELPER_PID,
  HOST_PID,
  privacyEnvironment,
  VERIFICATION_IDS,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver with the GOAT Computer Use helper", () => {
  it.effect("asks the helper for grants and lets it own the driver agents cannot target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Electron's own grants no longer matter once the helper owns the TCC identity.
        const test = yield* fixture({
          platform: "darwin",
          denyPermissions: true,
          helper: { granted: true },
        });
        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "ready");
        assert.equal(
          report.status === "ready" ? report.mcp.command : "",
          `${HELPER_BUNDLE}/Contents/MacOS/GOAT Computer Use`,
        );
        assert.deepEqual(test.helperProbes, [{ bundleId: HELPER_ID, prompt: true }]);
        assert.isEmpty(test.constructors);
        assert.deepEqual(
          test.helperLaunches.map(({ bundleId, driverPath }) => ({ bundleId, driverPath })),
          [
            {
              bundleId: HELPER_ID,
              driverPath: `${HELPER_BUNDLE}/Contents/Resources/cua-driver/cua-driver`,
            },
          ],
        );
        assert.deepEqual(test.helperLaunches[0]?.environment, privacyEnvironment);
        assert.deepEqual(test.launches[0]?.scope, "agents");
        assert.include(test.launches[0]?.hostBundleIds ?? [], HELPER_ID);
        assert.include(test.launches[0]?.hostBundleIds ?? [], "codes.t3.host-test");
      }),
    ),
  );

  it.effect("refuses to start without the helper's grants and names the helper", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: false } });
        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.match(
          report.status === "unavailable" ? (report.message ?? "") : "",
          /for GOAT Computer Use in System Settings/,
        );
        assert.isEmpty(test.helperLaunches);
      }),
    ),
  );

  it.effect("verifies the helper's grants and the helper as the driver's parent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          denyPermissions: true,
          helper: { granted: true },
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
        });
        assert.deepEqual(yield* test.verify, {
          verified: true,
          steps: VERIFICATION_IDS.map((id) => ({ id, ok: true })),
        });
        assert.deepEqual(test.helperProbes, [{ bundleId: HELPER_ID, prompt: false }]);
        assert.equal(test.launches[0]?.scope, "verify");
      }),
    ),
  );

  it.effect.each([
    {
      name: "Electron is the parent",
      identity: { bundle: "codes.t3.host-test", parent: HOST_PID },
    },
    { name: "another helper process is the parent", identity: { bundle: HELPER_ID, parent: 1 } },
  ])("fails identity when $name", ({ identity }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools: helperTools(identity),
        });
        const result = yield* test.verify;
        assert.isFalse(result.verified);
        assert.deepEqual(result.steps.at(-1)?.id, "identity");
        assert.isFalse(result.steps.at(-1)?.ok ?? true);
      }),
    ),
  );

  it.effect("names the helper when its grants are off", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: false } });
        const result = yield* test.verify;
        assert.deepEqual(result.steps, [
          {
            id: "grants",
            ok: false,
            detail: "Accessibility and Screen Recording are off for GOAT Computer Use.",
          },
        ]);
      }),
    ),
  );

  it.effect(
    "reports grants the helper asked for as waiting, with no safety signal before a helper runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: false } });
          yield* test.request("agent");
          yield* test.next;
          const report = test.readiness.at(-1);
          assert.deepEqual(report?.readiness.grants, {
            accessibility: "pending",
            screenCapture: "pending",
          });
          assert.equal(report?.readiness.helper, "unauthenticated");
          assert.deepEqual(report?.signals, {
            privateMode: "unsupported",
            humanInput: "unsupported",
          });
          assert.isFalse(report ? computerUseReady(report.readiness) : true);
        }),
      ),
  );

  it.effect(
    "is ready once the check proved the helper, capture and the tree, also while the helper is idle",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "darwin",
            helper: { granted: true },
            tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
          });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          const started = test.readiness.at(-1);
          // Running, but nothing has read a window yet.
          assert.equal(started?.readiness.helper, "authenticated");
          assert.equal(started?.readiness.capture, "pending");
          assert.isFalse(started ? computerUseReady(started.readiness) : true);

          assert.isTrue((yield* test.verify).verified);
          const checked = test.readiness.at(-1);
          assert.equal(checked?.readiness.capture, "ready");
          assert.equal(checked?.readiness.tree, "ready");
          // The check retired the agent's driver to see fresh grants.
          assert.equal((yield* test.next).status, "stopped");
          // Idle is not a failure: the helper proved itself and starts when an agent needs it.
          assert.equal(checked?.readiness.helper, "authenticated");
          assert.equal(checked?.readiness.input, "background");
          assert.isTrue(checked ? computerUseReady(checked.readiness) : false);
          assert.isFalse(
            (checked?.readiness.reasons ?? []).some((reason) => /not running/.test(reason)),
          );

          yield* test.request("agent-again");
          assert.equal((yield* test.next).status, "ready");
          const running = test.readiness.at(-1);
          assert.isTrue(running ? computerUseReady(running.readiness) : false);
          assert.isAbove(running?.generation ?? 0, started?.generation ?? 0);
          assert.deepEqual(running?.readiness.reasons, []);
        }),
      ),
  );

  it.effect("reports a blank capture from the check as blank, not ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          blankCapture: true,
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
        });
        assert.isFalse((yield* test.verify).verified);
        assert.equal(test.readiness.at(-1)?.readiness.capture, "blank");
        assert.equal(test.readiness.at(-1)?.readiness.tree, "unavailable");
      }),
    ),
  );

  it.effect("needs a fresh check after the helper's grants were taken away and given back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
        });
        assert.isTrue((yield* test.verify).verified);
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        const proven = test.readiness.at(-1);
        assert.isTrue(proven ? computerUseReady(proven.readiness) : false);

        yield* test.restart;
        assert.equal((yield* test.next).status, "stopped");
        yield* test.answerAsHelper({ granted: false });
        yield* test.request("revoked");
        assert.equal((yield* test.next).status, "unavailable");
        yield* test.answerAsHelper({ granted: true });
        yield* test.request("given-back");
        assert.equal((yield* test.next).status, "ready");
        const running = test.readiness.at(-1);
        assert.equal(running?.readiness.helper, "authenticated");
        assert.equal(running?.readiness.capture, "pending");
        assert.isFalse(running ? computerUseReady(running.readiness) : true);
      }),
    ),
  );

  it.effect.each([
    { platform: "darwin", how: "unusable" },
    { platform: "darwin", how: "absent" },
    { platform: "win32", how: "unusable" },
    { platform: "win32", how: "absent" },
  ] as const)(
    "drops earlier proofs when the helper becomes $how on $platform",
    ({ platform, how }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform,
            helper: { granted: true },
            tools:
              platform === "win32"
                ? {
                    ...healthyTools(),
                    check_permissions: toolResult({ elevated: false, uia: true }),
                  }
                : helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
          });
          assert.isTrue((yield* test.verify).verified);
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          const proven = test.readiness.at(-1);
          assert.isTrue(proven ? computerUseReady(proven.readiness) : false);

          yield* test.loseHelper(how);
          yield* test.verify;
          const after = test.readiness.at(-1)?.readiness;
          assert.isFalse(after ? computerUseReady(after) : true);
          assert.equal(after?.capture, "pending");
          assert.equal(after?.helper, "unauthenticated");
          assert.isTrue(
            (after?.reasons ?? []).some((reason) =>
              how === "absent" ? /could not be found/.test(reason) : /cannot be used/.test(reason),
            ),
          );
        }),
      ),
  );

  it.effect("a start request that cannot use the helper drops its earlier proofs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
        });
        assert.isTrue((yield* test.verify).verified);
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        yield* test.restart;
        assert.equal((yield* test.next).status, "stopped");

        yield* test.loseHelper("unusable");
        yield* test.request("unusable");
        assert.equal((yield* test.next).status, "unavailable");
        const after = test.readiness.at(-1)?.readiness;
        assert.isFalse(after ? computerUseReady(after) : true);
        assert.isTrue((after?.reasons ?? []).some((reason) => /cannot be used/.test(reason)));
      }),
    ),
  );

  it.effect("a driver GOAT runs itself never counts as the helper running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          tools: helperTools({ bundle: HELPER_ID, parent: HELPER_PID }),
        });
        assert.isTrue((yield* test.verify).verified);
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        yield* test.restart;
        assert.equal((yield* test.next).status, "stopped");

        // Without the helper this build runs the driver under GOAT's own identity.
        yield* test.loseHelper("absent");
        yield* test.request("embedded");
        assert.equal((yield* test.next).status, "ready");
        yield* test.restoreHelper;
        yield* test.request("helper-back");
        assert.equal((yield* test.next).status, "ready");
        const after = test.readiness.at(-1)?.readiness;
        assert.equal(after?.helper, "unauthenticated");
        assert.isFalse(after ? computerUseReady(after) : true);
      }),
    ),
  );

  it.effect("drops earlier proofs when a later check fails before reading a window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools: Record<string, ReturnType<typeof toolResult>> = helperTools({
          bundle: HELPER_ID,
          parent: HELPER_PID,
        });
        const test = yield* fixture({ platform: "darwin", helper: { granted: true }, tools });
        assert.isTrue((yield* test.verify).verified);
        // The driver now runs outside the helper's permissions.
        tools.check_permissions = toolResult({
          accessibility: true,
          screen_recording: true,
          source: { attribution: "process" },
        });
        const failed = yield* test.verify;
        assert.equal(failed.steps.at(-1)?.id, "permissions");
        const after = test.readiness.at(-1);
        assert.equal(after?.readiness.capture, "pending");
        assert.equal(after?.readiness.tree, "unavailable");
        assert.include(after?.readiness.reasons ?? [], failed.steps.at(-1)?.detail);

        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        const running = test.readiness.at(-1);
        assert.isFalse(running ? computerUseReady(running.readiness) : true);
      }),
    ),
  );
  it.effect("starts no driver daemon for agents or readiness checks on macOS", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true } });
        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "ready");
        // What the server hands each agent's proxy: the helper itself, and no socket to reach.
        assert.deepEqual(report.status === "ready" ? report.mcp.args.slice(0, 1) : [], ["--mcp"]);
        assert.isUndefined(report.status === "ready" ? report.mcp.socketPath : "missing");
        yield* test.verify;
        assert.deepEqual(
          test.helperLaunches.map(({ direct }) => direct),
          [true, true],
        );
      }),
    ),
  );
});

describe("DesktopCuaDriver readiness on Windows", () => {
  it.effect(
    "reports the helper's own refusal and its typed cause, and clears both on recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const detail = "GOAT runs in Windows Session 0 (a service or SSH session).";
          const test = yield* fixture({
            platform: "win32",
            helper: { granted: false, detail, blocker: "noInteractiveDesktop" },
          });
          yield* test.request("session-zero");
          assert.equal((yield* test.next).status, "unavailable");
          const refused = test.readiness.at(-1)?.readiness;
          assert.deepEqual(refused?.blockers, ["noInteractiveDesktop"]);
          assert.include(refused?.reasons ?? [], detail);

          yield* test.answerAsHelper({ granted: true });
          yield* test.request("desktop");
          assert.equal((yield* test.next).status, "ready");
          const recovered = test.readiness.at(-1)?.readiness;
          assert.deepEqual(recovered?.blockers, []);
          assert.notInclude(recovered?.reasons ?? [], detail);
        }),
      ),
  );
});

describe("DesktopCuaDriver when the helper cannot be used", () => {
  it.effect("keeps computer use off instead of running it under GOAT's own grants", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // GOAT itself holds the grants here; falling back would silently use them.
        const test = yield* fixture({ platform: "darwin", helper: "unusable" });
        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.match(report.status === "unavailable" ? (report.message ?? "") : "", /EACCES/);
        assert.isEmpty(test.constructors);
        assert.isEmpty(test.helperLaunches);
        const result = yield* test.verify;
        assert.deepEqual(result.steps, [
          {
            id: "grants",
            ok: false,
            detail: "GOAT Computer Use at /Helpers cannot be used (EACCES).",
          },
        ]);
      }),
    ),
  );
});
