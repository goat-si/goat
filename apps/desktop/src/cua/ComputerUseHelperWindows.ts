// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only module names the helper's pipe and files.

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { ComputerUseReadiness } from "@goat/contracts";
import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import * as Schema from "effect/Schema";

import { type HelperBundle, type HelperProcess, openHelperSession } from "./ComputerUseHelper.ts";

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

/** The helper's readiness answer: the macOS grant pair plus what decides it on Windows. */
export const WindowsReadiness = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
  interactiveSession: Schema.Boolean,
  connectState: Schema.String,
  inputDesktop: Schema.String,
  uiAutomation: Schema.Boolean,
  helperElevated: Schema.Boolean,
});
export type WindowsReadiness = typeof WindowsReadiness.Type;
const decodeReadiness = Schema.decodeUnknownSync(WindowsReadiness);

/**
 * Windows has no grant to give. What stands in for one is a desktop to work on: an interactive,
 * connected session showing the normal desktop, with UI Automation answering, and a helper that
 * is not elevated. The first missing piece is the reason, in the words onboarding shows.
 */
export function windowsReadinessFailure(readiness: WindowsReadiness): string | undefined {
  if (!readiness.interactiveSession)
    return "GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Start GOAT from the signed-in desktop on this computer to use computer use.";
  if (readiness.helperElevated)
    return "GOAT is running as administrator, and computer use never runs elevated. Start GOAT without Run as administrator.";
  if (readiness.connectState === "disconnected")
    return "This Windows session is disconnected, so there is no screen to see. Reconnect to it, then try again.";
  if (readiness.inputDesktop !== "Default")
    return "The screen is locked or showing a Windows security prompt. Unlock it, then try again.";
  if (!readiness.uiAutomation) return "UI Automation did not answer on this desktop. Try again.";
  if (!readiness.screenRecording)
    return "This Windows session is not showing a screen right now. Sign in to it, then try again.";
  return undefined;
}

/**
 * The typed cause behind windowsReadinessFailure's reason, where one fits, so clients can offer
 * the remedy. Checked in the same order, so the two always describe the same failure.
 */
export function windowsReadinessBlocker(
  readiness: WindowsReadiness,
): ComputerUseReadiness["blockers"][number] | undefined {
  if (!readiness.interactiveSession) return "noInteractiveDesktop";
  if (readiness.helperElevated) return undefined;
  if (readiness.connectState === "disconnected") return "noInteractiveDesktop";
  if (readiness.inputDesktop !== "Default") return "screenLocked";
  return undefined;
}

/** Readiness from a fresh helper, in the grant shape the desktop host checks. */
export async function probeWindowsReadiness(
  process: HelperProcess,
  expectedBundleId: string,
): Promise<{
  accessibility: boolean;
  screenRecording: boolean;
  detail?: string;
  blocker?: ComputerUseReadiness["blockers"][number];
}> {
  const session = await openHelperSession(process, expectedBundleId);
  try {
    const readiness = decodeReadiness(await session.request("permissions", { prompt: false }));
    const detail = windowsReadinessFailure(readiness);
    const blocker = windowsReadinessBlocker(readiness);
    return detail === undefined
      ? { accessibility: readiness.accessibility, screenRecording: readiness.screenRecording }
      : {
          accessibility: false,
          screenRecording: false,
          detail,
          ...(blocker === undefined ? {} : { blocker }),
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
