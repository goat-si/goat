// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only module names the helper's pipe and files.

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  windowsComputerUseReadiness,
  WindowsHelperReadiness,
} from "@goat/shared/computerUseWindows";
import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import * as Schema from "effect/Schema";

import { type HelperBundle, type HelperProcess, openHelperSession } from "./ComputerUseHelper.ts";

const decodeReadiness = Schema.decodeUnknownSync(WindowsHelperReadiness);

/**
 * GOAT Computer Use on Windows (apps/desktop/native/computer-use-helper-windows): a folder with
 * the helper executable and the pinned driver beside it. Packaged builds carry it in
 * resources\computer-use-helper; development points GOAT_CUA_HELPER_PATH at a built folder.
 */
export const windowsHelperBundle = (directory: string, bundleId: string): HelperBundle => ({
  bundlePath: directory,
  executable: NodePath.win32.join(directory, COMPUTER_USE_HELPER_NAME + ".exe"),
  driverPath: NodePath.win32.join(directory, "cua-driver", "cua-driver.exe"),
  bundleId,
});

/** A pipe name per driver start; the helper refuses any other shape and any pipe already served. */
export const windowsDriverPipe = async () => ({
  path: "\\\\.\\pipe\\goat-cu-" + process.pid + "-" + NodeCrypto.randomBytes(8).toString("hex"),
  release: async () => undefined,
});

/**
 * Readiness from a fresh helper, in the grant shape the desktop host checks. The protocol's
 * readiness (computerUseWindows.ts) decides it; a desktop that cannot be used yet says why with
 * its first reason.
 */
export async function probeWindowsReadiness(
  process: HelperProcess,
  expectedBundleId: string,
): Promise<{ accessibility: boolean; screenRecording: boolean; detail?: string }> {
  const session = await openHelperSession(process, expectedBundleId);
  try {
    const readiness = windowsComputerUseReadiness({
      facts: decodeReadiness(await session.request("permissions", { prompt: false })),
      helper: "authenticated",
    });
    const usable =
      readiness.blockers.length === 0 &&
      readiness.input !== "unavailable" &&
      readiness.grants.accessibility === "granted" &&
      readiness.grants.screenCapture === "granted";
    return usable
      ? { accessibility: true, screenRecording: true }
      : {
          accessibility: false,
          screenRecording: false,
          detail: readiness.reasons[0] ?? "GOAT Computer Use cannot use this desktop.",
        };
  } finally {
    await session.close();
  }
}

/**
 * The driver's check_permissions on Windows answers whether UI Automation works and whether it
 * runs elevated; an elevated driver could reach administrator windows, which ADR-0023 forbids.
 */
export function windowsPermissionsFailure(structured: unknown): string | undefined {
  const read = (key: string) =>
    typeof structured === "object" && structured !== null
      ? (structured as Record<string, unknown>)[key]
      : undefined;
  if (read("elevated") !== false)
    return "The driver runs elevated or did not say. Start GOAT without Run as administrator.";
  if (read("uia") !== true) return "The driver cannot reach UI Automation on this desktop.";
  return undefined;
}
