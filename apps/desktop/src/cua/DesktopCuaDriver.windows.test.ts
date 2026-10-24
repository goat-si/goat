import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";

import {
  fixture,
  healthyTools,
  HELPER_ID,
  toolResult,
  VERIFICATION_IDS,
} from "./DesktopCuaDriver.testkit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("DesktopCuaDriver with the GOAT Computer Use helper on Windows", () => {
  const WINDOWS_DRIVER = "\\Helpers\\GOAT Computer Use.app\\cua-driver\\cua-driver.exe";
  // check_permissions as the pinned 0.37.0 daemon answers on Windows (recorded on mini).
  const windowsTools = (permissions: { elevated: boolean; uia: boolean }) => ({
    ...healthyTools(),
    check_permissions: toolResult({
      ...permissions,
      integrity_level: "Medium",
      integrity_level_rid: 8192,
      post_message: true,
    }),
  });

  it.effect(
    "refreshes an app started after the host when approved, retiring the Windows host",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "win32", helper: { granted: true } });
          const app = "C:\\work\\fixture.exe";
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.notInclude(test.manifest(), app);
          yield* test.listApps([{ executable: app, name: "fixture.exe" }]);
          yield* test.approveApps([app]);
          assert.include(test.manifest(), JSON.stringify(app));
          assert.equal((yield* test.next).status, "stopped");
          assert.deepEqual(test.counts(), { starts: 1, stops: 1, destroys: 1 });
          yield* test.request("resumed");
          assert.equal((yield* test.next).status, "ready");
          yield* test.approveApps([app]);
          assert.deepEqual(test.counts(), { starts: 2, stops: 1, destroys: 1 });
          assert.deepEqual(test.helperAppListings, [HELPER_ID, HELPER_ID, HELPER_ID]);
        }),
      ),
  );

  it.effect("refreshes a late app for macOS direct connections without restarting the host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "darwin", helper: { granted: true } });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        yield* test.listApps([{ bundle_id: "com.example.late", name: "Late" }]);
        yield* test.approveApps(["com.example.late"]);
        assert.include(test.manifest(), "com.example.late");
        assert.isTrue(test.helperLaunches[0]?.direct);
        yield* test.approveApps(["COM.EXAMPLE.LATE"]);
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        assert.deepEqual(test.helperAppListings, [HELPER_ID, HELPER_ID]);
      }),
    ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "does not restart %s for an approved app still absent or excluded",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform, helper: { granted: true } });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          yield* test.approveApps(["com.example.not-running"]);
          yield* test.listApps([{ bundle_id: "com.apple.Passwords", name: "Passwords" }]);
          yield* test.approveApps(["com.apple.Passwords"]);
          assert.notInclude(test.manifest(), "com.apple.Passwords");
          assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
          // With no host an approval must neither list nor start one.
          yield* test.restart;
          yield* test.next;
          const listings = test.helperAppListings.length;
          yield* test.approveApps(["com.example.not-running"]);
          assert.equal(test.helperAppListings.length, listings);
        }),
      ),
  );

  it.effect("keeps the Windows host and manifest when verified app listing fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "win32", helper: { granted: true } });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        const manifest = test.manifest();
        yield* test.failAppListing;
        yield* test.approveApps(["C:\\work\\fixture.exe"]);
        assert.equal(test.manifest(), manifest);
        assert.deepEqual(test.counts(), { starts: 1, stops: 0, destroys: 0 });
        assert.isEmpty(test.constructors);
      }),
    ),
  );

  it.effect("runs the helper folder's driver once the desktop is ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({ platform: "win32", helper: { granted: true } });
        yield* test.request("agent");
        const report = yield* test.next;
        assert.equal(report.status, "ready");
        assert.equal(report.status === "ready" ? report.mcp.command : "", WINDOWS_DRIVER);
        // Windows has no grant to prompt for.
        assert.deepEqual(test.helperProbes, [{ bundleId: HELPER_ID, prompt: false }]);
        assert.isEmpty(test.constructors);
        assert.include(test.launches[0]?.hostBundleIds ?? [], HELPER_ID);
        // The agents' app list comes from the helper's verified driver, never a direct run.
        assert.deepEqual(test.manifestListings, [{ scope: "agents", through: "helper", apps: 1 }]);
        assert.deepEqual(test.helperAppListings, [HELPER_ID]);
      }),
    ),
  );

  it.effect("keeps computer use off on a desktop it cannot use and says why", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const detail =
          "GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Start GOAT from the signed-in desktop on this computer to use computer use.";
        const test = yield* fixture({ platform: "win32", helper: { granted: false, detail } });
        yield* test.request("agent");
        assert.deepEqual(yield* test.next, {
          version: 1,
          type: "cuaDriverReport",
          requestId: "agent",
          status: "unavailable",
          message: detail,
        });
        assert.isEmpty(test.helperLaunches);
        assert.deepEqual((yield* test.verify).steps, [{ id: "grants", ok: false, detail }]);
      }),
    ),
  );

  it.effect(
    "verifies readiness, a non-elevated driver, the helper's daemon, capture and tree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "win32",
            helper: { granted: true },
            tools: windowsTools({ elevated: false, uia: true }),
          });
          assert.deepEqual(yield* test.verify, {
            verified: true,
            steps: VERIFICATION_IDS.map((id) => ({ id, ok: true })),
          });
          // The driver matches Windows apps by executable path; only that admits GOAT's window.
          assert.include(
            test.launches[0]?.hostBundleIds ?? [],
            "C:\\Program Files\\GOAT\\GOAT.exe",
          );
          // health_report has no bundle identity on Windows; the helper's admission stands in.
          assert.notInclude(
            test.toolCalls.map(({ name }) => name),
            "health_report",
          );
        }),
      ),
  );

  it.effect("fails permissions for an elevated driver", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "win32",
          helper: { granted: true },
          tools: windowsTools({ elevated: true, uia: true }),
        });
        const result = yield* test.verify;
        assert.isFalse(result.verified);
        assert.deepEqual(result.steps.at(-1), {
          id: "permissions",
          ok: false,
          detail:
            "The driver runs elevated or did not say. Start GOAT without Run as administrator.",
        });
      }),
    ),
  );

  it.effect("needs the helper to check a Windows desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubEnv("GOAT_CUA_DRIVER_PATH", "C:\\driver\\cua-driver.exe");
        const test = yield* fixture({ platform: "win32", isPackaged: false });
        assert.deepEqual((yield* test.verify).steps, [
          {
            id: "grants",
            ok: false,
            detail:
              "Readiness checks on Windows run through GOAT Computer Use, which this build does not include.",
          },
        ]);
      }),
    ),
  );
});
