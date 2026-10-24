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
