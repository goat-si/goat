// @effect-diagnostics nodeBuiltinImport:off -- Manifest tests use a trap driver script on a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { computerUseReady } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import { bitmapHasContent, prepareDesktopManifest } from "./DesktopCuaDriver.ts";
import { ComputerUseHelperError } from "./ComputerUseHelper.ts";

import {
  privacyEnvironment,
  descriptor,
  HOST_PID,
  HELPER_PID,
  HELPER_ID,
  HELPER_BUNDLE,
  toolResult,
  healthyTools,
  fixture,
  VERIFICATION_IDS,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver", () => {
  it.effect("hosts with the app identity, preserves the descriptor, reuses and releases once", () =>
    Effect.gen(function* () {
      vi.stubEnv("GOAT_CUA_DRIVER_PATH", "/ignored-in-packaged-app");
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture();
          yield* test.request("first");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "first",
            status: "ready",
            mcp: descriptor,
          });
          assert.deepEqual(test.constructors, [
            {
              path: "/resources/cua-driver/cua-driver",
              bundleId: "codes.t3.host-test",
              environment: privacyEnvironment,
            },
          ]);
          yield* test.request("reuse");
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "reuse",
            status: "ready",
            mcp: descriptor,
          });
          yield* test.request("disable", false);
          assert.equal((yield* test.next).status, "stopped");
          yield* test.request("disable-again", false);
          assert.equal((yield* test.next).status, "stopped");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("new-session");
          assert.equal((yield* test.next).status, "ready");
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
    }),
  );

  it.effect("requires a development override and uses it to host without a bundled driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("GOAT_CUA_DRIVER_PATH", " ");
        const missing = yield* fixture({ isPackaged: false });
        yield* missing.request("unconfigured");
        assert.equal((yield* missing.next).status, "unavailable");
        assert.isEmpty(missing.constructors);

        vi.stubEnv("GOAT_CUA_DRIVER_PATH", " /dev/cua-driver ");
        const configured = yield* fixture({ isPackaged: false });
        yield* configured.request("configured");
        assert.equal((yield* configured.next).status, "ready");
        assert.deepEqual(configured.constructors, [
          {
            path: "/dev/cua-driver",
            bundleId: "codes.t3.host-test",
            environment: privacyEnvironment,
          },
        ]);
      }),
    ),
  );

  it.effect("denies missing macOS permissions and restarts the host after permission changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", denyPermissions: true });
        yield* test.request("denied");
        const denied = yield* test.next;
        assert.equal(denied.status, "unavailable");
        if (denied.status !== "ready")
          assert.match(denied.message ?? "", /Accessibility|Screen Recording/);
        assert.isEmpty(test.constructors);
        yield* test.grantPermissions;
        yield* test.restart;
        yield* test.request("granted");
        assert.equal((yield* test.next).status, "ready");
        assert.equal(test.constructors[0]?.path, "/resources/cua-driver");
        yield* test.restart;
        assert.deepEqual(yield* test.next, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "granted",
          status: "stopped",
        });
        yield* test.request("fresh-permissions");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
      }),
    ),
  );

  it.effect(
    "releases failed starts and crashed hosts, correlates failure, and permits recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ failFirstStart: true });
          yield* test.request("failed-start");
          const failed = yield* test.next;
          assert.equal(failed.status, "unavailable");
          assert.equal(failed.requestId, "failed-start");
          assert.notInclude(JSON.stringify(failed), "private native failure");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("recover");
          assert.equal((yield* test.next).status, "ready");
          yield* test.request("current-request");
          yield* test.next;
          yield* test.crash;
          const crashed = yield* test.next;
          assert.equal(crashed.status, "unavailable");
          assert.equal(crashed.requestId, "current-request");
          assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
          yield* test.request("after-crash");
          assert.equal((yield* test.next).status, "ready");
          assert.lengthOf(test.constructors, 3);
        }),
      ),
  );

  it.effect(
    "retains a timed-out native start through bounded shutdown and releases its late result",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const test = yield* fixture({ hold: "start" }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        yield* test.request("pending-start");
        yield* test.starting;
        yield* TestClock.adjust("23 seconds");
        assert.equal((yield* test.next).status, "unavailable");
        yield* test.request("cannot-replace");
        assert.equal((yield* test.next).status, "unavailable");
        assert.lengthOf(test.constructors, 1);
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(closing);
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        yield* test.release;
        yield* test.destroyed;
        assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
        assert.equal(yield* test.pendingReports, 0);
      }),
  );

  it.effect.each(["stop", "monitor"] as const)(
    "bounds restart but retains ownership until the native %s settles",
    (hold) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ hold });
          yield* test.request("active");
          assert.equal((yield* test.next).status, "ready");
          const restarting = yield* test.restart.pipe(Effect.forkChild);
          yield* test.stopping;
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(restarting);
          const report = yield* test.next;
          assert.equal(report.requestId, "active");
          assert.equal(report.status, "unavailable");
          yield* test.request("cannot-replace");
          assert.equal((yield* test.next).status, "unavailable");
          assert.lengthOf(test.constructors, 1);
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 0 });
          yield* test.release;
          yield* test.destroyed;
          yield* test.request("after-settlement");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
        }),
      ),
  );
});

describe("DesktopCuaDriver verification", () => {
  it.effect("gives agents the general manifest and the grant check one that admits only GOAT", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin" });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        assert.isTrue((yield* test.verify).verified);
        assert.deepEqual(test.launches, [
          {
            scope: "agents",
            hostBundleIds: ["codes.t3.host-test"],
            manifestPath: "/home/test/.goat/desktop/userdata/cua-driver/agents.yaml",
            permissionMode: 0,
            approved: true,
          },
          {
            scope: "verify",
            hostBundleIds: ["codes.t3.host-test"],
            manifestPath: "/home/test/.goat/desktop/userdata/cua-driver/verify.yaml",
            permissionMode: 0,
            approved: true,
          },
        ]);
      }),
    ),
  );

  it.effect("names a refused manifest instead of a generic failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ refuseStart: true });
        yield* test.request("refused");
        const report = yield* test.next;
        assert.equal(report.status, "unavailable");
        assert.match(
          report.status === "unavailable" ? (report.message ?? "") : "",
          /refused GOAT's capability manifest/,
        );
      }),
    ),
  );

  it.effect("verifies only after a restarted driver reads and captures a GOAT window", () =>
    Effect.gen(function* () {
      const test = yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin" });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(yield* test.verify, {
            verified: true,
            steps: VERIFICATION_IDS.map((id) => ({ id, ok: true })),
          });
          // The agent's driver predates the grants; its session must reconnect to a fresh one.
          assert.deepEqual(yield* test.next, {
            version: 1,
            type: "cuaDriverReport",
            requestId: "agent",
            status: "stopped",
          });
          assert.deepEqual(test.toolCalls, [
            { name: "check_permissions", input: {} },
            { name: "health_report", input: { include: ["bundle_identity"] } },
            { name: "list_windows", input: { pid: HOST_PID, on_screen_only: true } },
            { name: "get_window_state", input: { pid: HOST_PID, window_id: 77 } },
          ]);
          // The check's own driver is retired, so nothing runs until the next agent session.
          assert.deepEqual(test.counts(), { starts: 2, stops: 2, destroys: 2 });
          assert.equal(test.clientsOpen(), 0);
          yield* test.request("next-session");
          assert.equal((yield* test.next).status, "ready");
          return test;
        }),
      );
      assert.deepEqual(test.counts(), { starts: 3, stops: 3, destroys: 3 });
    }),
  );

  const failures: ReadonlyArray<{
    readonly name: string;
    readonly options: Parameters<typeof fixture>[0];
    readonly failedAt: (typeof VERIFICATION_IDS)[number];
    readonly detail: RegExp;
  }> = [
    {
      name: "Electron reports a missing grant",
      options: { denyPermissions: true },
      failedAt: "grants",
      detail: /^Accessibility and Screen Recording are off for GOAT\.$/,
    },
    {
      name: "the driver answers for itself instead of GOAT",
      options: {
        tools: {
          ...healthyTools(),
          check_permissions: toolResult({
            accessibility: true,
            screen_recording: true,
            source: { attribution: "caller" },
          }),
        },
      },
      failedAt: "permissions",
      detail: /not running under GOAT's permissions/,
    },
    {
      name: "the restarted driver still sees a denied grant",
      options: {
        tools: {
          ...healthyTools(),
          check_permissions: toolResult({
            accessibility: true,
            screen_recording: false,
            source: { attribution: "host" },
          }),
        },
      },
      failedAt: "permissions",
      detail: /does not see Screen Recording/,
    },
    {
      name: "the parent is not an identifiable app",
      options: {
        tools: {
          ...healthyTools(),
          health_report: toolResult({
            checks: [
              {
                name: "bundle_identity",
                status: "fail",
                message:
                  "Embedded mode is set, but the parent process is not an identifiable macOS application.",
                data: { identity_source: "parent_application", parent_process_id: HOST_PID },
              },
            ],
          }),
        },
      },
      failedAt: "identity",
      detail: /not an identifiable macOS application/,
    },
    {
      name: "no GOAT window is on screen",
      options: { tools: { ...healthyTools(), list_windows: toolResult({ windows: [] }) } },
      failedAt: "capture",
      detail: /Keep a GOAT window open/,
    },
    {
      name: "the screen is locked",
      options: {
        tools: {
          ...healthyTools(),
          get_window_state: toolResult({
            degraded: true,
            degraded_reason:
              "screen_locked: window_id 77 has no accessibility tree because the screen is locked.",
            element_count: 0,
          }),
        },
      },
      failedAt: "capture",
      detail: /screen is locked/,
    },
    {
      name: "the capture is blank",
      options: { blankCapture: true },
      failedAt: "capture",
      detail: /screenshot was blank/,
    },
    {
      name: "the window has no accessibility tree",
      options: {
        tools: {
          ...healthyTools(),
          get_window_state: toolResult({ element_count: 0 }, [
            { mimeType: "image/png", dataBase64: "cGl4ZWxz" },
          ]),
        },
      },
      failedAt: "accessibility",
      detail: /could not read GOAT's window/,
    },
  ];

  it.effect.each(failures)("stops at $failedAt when $name", (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", ...failure.options });
        const result = yield* test.verify;
        const index = VERIFICATION_IDS.indexOf(failure.failedAt);
        assert.isFalse(result.verified);
        assert.deepEqual(
          result.steps.map((step) => [step.id, step.ok]),
          VERIFICATION_IDS.slice(0, index + 1).map((id) => [id, id !== failure.failedAt]),
        );
        assert.match(result.steps.at(-1)?.detail ?? "", failure.detail);
        // A failed check never leaves its driver or SDK client running.
        assert.equal(test.counts().starts, test.counts().destroys);
        assert.equal(test.clientsOpen(), 0);
      }),
    ),
  );

  it.effect("an early failure leaves the agent's running driver alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin" });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        // Grants revoked after the driver started: the check stops before its own restart.
        yield* test.denyPermissions;
        const result = yield* test.verify;
        assert.deepEqual(
          result.steps.map((step) => [step.id, step.ok]),
          [["grants", false]],
        );
        // Stopping it here would leave the server holding a dead descriptor it was never told about.
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        assert.equal(yield* test.pendingReports, 0);
        yield* test.request("reuse");
        assert.equal((yield* test.next).status, "ready");
        assert.equal(test.counts().starts, 1);
      }),
    ),
  );

  it.effect("reports that only macOS and Windows have readiness to verify", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "linux" });
        assert.deepEqual(yield* test.verify, {
          verified: false,
          steps: [
            { id: "grants", ok: false, detail: "Readiness checks run on macOS and Windows." },
          ],
        });
        assert.isEmpty(test.constructors);
      }),
    ),
  );

  it("treats an all-black capture as blank and any visible content as captured", () => {
    const black = new Uint8Array(64 * 64 * 4);
    assert.isFalse(bitmapHasContent(black));
    assert.isFalse(bitmapHasContent(new Uint8Array()));
    const content = black.slice();
    for (let offset = 0; offset < content.length; offset += 4 * 20) content[offset + 1] = 200;
    assert.isTrue(bitmapHasContent(content));
  });
});

describe("DesktopCuaDriver with the GOAT Computer Use helper", () => {
  const helperTools = (identity: { bundle: string; parent: number }) => ({
    ...healthyTools(),
    health_report: toolResult({
      checks: [
        {
          name: "bundle_identity",
          status: "pass",
          data: {
            bundle_identifier: identity.bundle,
            identity_source: "parent_application",
            parent_process_id: identity.parent,
          },
        },
      ],
    }),
  });

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
          `${HELPER_BUNDLE}/Contents/Resources/cua-driver/cua-driver`,
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

  it.effect("reports grants the helper asked for as waiting, with neither safety signal", () =>
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
    "is ready only after the check proved capture and the tree and while the helper runs the driver",
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
          assert.equal(checked?.readiness.helper, "unauthenticated");

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

describe("DesktopCuaDriver app listing for the agents' manifest", () => {
  it.effect(
    "lists apps through the macOS helper, so its driver never runs outside the helper's seal check",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: true } });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(test.manifestListings, [
            { scope: "agents", through: "helper", apps: 1 },
          ]);
          assert.deepEqual(test.helperAppListings, [HELPER_ID]);
        }),
      ),
  );

  it.effect.each([
    { name: "a build without the helper", platform: "darwin" as const, helper: undefined },
  ])("keeps listing by running the driver for $name", ({ platform, helper }) =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("GOAT_CUA_DRIVER_PATH", "/dev/cua-driver");
        const test = yield* fixture({ platform, ...(helper ? { helper } : {}) });
        yield* test.request("agent");
        yield* test.next;
        assert.deepEqual(
          test.manifestListings.map(({ through }) => through),
          ["driver"],
        );
        assert.isEmpty(test.helperAppListings);
      }),
    ),
  );
});

describe("DesktopCuaDriver manifest preparation", () => {
  const trap = (onTestFinished: (cleanup: () => void) => void) => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "goat-cu-desktop-manifest-"),
    );
    onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const marker = NodePath.join(directory, "ran");
    const binaryPath = NodePath.join(directory, "cua-driver");
    NodeFS.writeFileSync(binaryPath, "#!/bin/sh\ntouch '" + marker + "'\nexit 3\n", {
      mode: 0o755,
    });
    return { directory, binaryPath, ran: () => NodeFS.existsSync(marker) };
  };

  it("hands the helper's listing to the shared manifest, so the driver never runs here", async ({
    onTestFinished,
  }) => {
    const driver = trap(onTestFinished);
    const path = await prepareDesktopManifest({
      binaryPath: driver.binaryPath,
      scope: "agents",
      hostBundleIds: ["si.goat.desktop"],
      directory: driver.directory,
      platform: "darwin",
      listApplications: async () => [{ bundle_id: "com.apple.TextEdit", name: "TextEdit" }],
    });
    expect(driver.ran()).toBe(false);
    expect(NodeFS.readFileSync(path, "utf8")).toContain("com.apple.TextEdit");
  });

  it("writes the grant check's manifest without listing anything", async ({ onTestFinished }) => {
    const driver = trap(onTestFinished);
    await prepareDesktopManifest({
      binaryPath: driver.binaryPath,
      scope: "verify",
      hostBundleIds: ["si.goat.desktop"],
      directory: driver.directory,
      platform: "darwin",
    });
    expect(driver.ran()).toBe(false);
  });
});

describe("DesktopCuaDriver when the helper cannot list apps", () => {
  it.effect("stays off instead of starting a driver or listing another way", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          helperAppsFail: true,
        });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "unavailable");
        assert.isEmpty(test.helperLaunches);
        assert.isEmpty(test.constructors);
      }),
    ),
  );
});
