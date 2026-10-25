// @effect-diagnostics nodeBuiltinImport:off -- Manifest tests use a trap driver script on a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import { bitmapHasContent } from "./DesktopCuaDriver.ts";
import { prepareDesktopManifest } from "./DesktopCuaManifest.ts";

import {
  privacyEnvironment,
  descriptor,
  HOST_PID,
  HELPER_ID,
  HELPER_BUNDLE,
  toolResult,
  healthyTools,
  fixture,
  VERIFICATION_IDS,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver", () => {
  it.effect.each(["darwin", "win32"] as const)(
    "answers fresh app-list requests through the %s helper, and refuses disabled or failed listings",
    (platform) =>
      Effect.gen(function* () {
        const test = yield* fixture({ platform, helper: { granted: true } });
        yield* test.listApps([
          { bundle_id: " com.example.Editor ", name: "Editor window" },
          { name: "fixture.exe", executable: "C:\\Apps\\fixture.exe" },
          { bundle_id: HELPER_ID, name: "GOAT Computer Use" },
          { bundle_id: "codes.t3.host-test", name: "GOAT" },
          { bundle_id: "com.apple.Passwords", name: "Passwords" },
        ]);
        yield* test.requestApps("apps-1");
        assert.deepEqual(yield* test.nextApps, {
          version: 1,
          type: "cuaApps",
          requestId: "apps-1",
          status: "listed",
          apps: ["com.example.Editor", "fixture.exe"],
        });
        yield* test.listApps([{ name: "New app" }]);
        yield* test.requestApps("apps-2");
        assert.deepEqual(yield* test.nextApps, {
          version: 1,
          type: "cuaApps",
          requestId: "apps-2",
          status: "listed",
          apps: ["New app"],
        });
        assert.equal(test.helperAppListings.length, 2);
        yield* test.setComputerUseEnabled(false);
        yield* test.requestApps("off");
        assert.deepEqual(yield* test.nextApps, {
          version: 1,
          type: "cuaApps",
          requestId: "off",
          status: "unavailable",
        });
        assert.equal(
          test.helperAppListings.length,
          2,
          "disabled requests do not run the helper listing",
        );
        yield* test.setComputerUseEnabled(true);
        yield* test.failAppListing;
        yield* test.requestApps("failed");
        assert.deepEqual(yield* test.nextApps, {
          version: 1,
          type: "cuaApps",
          requestId: "failed",
          status: "unavailable",
        });
        assert.equal(test.helperAppListings.length, 3);
        assert.equal(test.constructors.length, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("starts an updated helper after the running generation is restarted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
        });
        yield* test.request("before-update");
        assert.equal((yield* test.next).status, "ready");
        yield* test.applyHelperUpdate;
        yield* test.restart;
        assert.equal((yield* test.next).status, "stopped");
        yield* test.request("after-update");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(
          test.helperLaunches.map(({ driverPath }) => driverPath),
          [
            HELPER_BUNDLE + "/Contents/Resources/cua-driver/cua-driver",
            HELPER_BUNDLE + "/generations/new/Contents/Resources/cua-driver/cua-driver",
          ],
        );
      }),
    ),
  );

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
        if (denied.status !== "ready") {
          assert.match(denied.message ?? "", /Accessibility|Screen Recording/);
          // The typed reason the tile, Settings and the agent name (#1399).
          assert.deepEqual(denied.block, {
            reason: "permissionsNotGranted",
            missing: ["accessibility", "screenRecording"],
            holder: "app",
          });
        }
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
