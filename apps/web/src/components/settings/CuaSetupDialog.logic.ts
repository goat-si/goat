import type { CuaHostStatus, CuaVerificationStepId, DesktopCuaVerification } from "@goat/contracts";

export type CuaPermission = "accessibility" | "screen-recording";
export const CUA_PERMISSIONS: readonly CuaPermission[] = ["accessibility", "screen-recording"];

/** What the person at a host must provide when this client cannot grant macOS permissions. */
export function cuaHostRequirements(
  platform: CuaHostStatus["platform"],
  hostLabel: string,
): string {
  switch (platform) {
    case "darwin":
      return `${hostLabel} needs Accessibility and Screen Recording. Someone at that Mac grants them in System Settings → Privacy & Security, to the app or process running GOAT there.`;
    case "linux":
      return `${hostLabel} needs a signed-in graphical session.`;
    case "win32":
      return `${hostLabel} needs a signed-in desktop session. If Windows asks about Cua Driver, someone at that computer must respond.`;
    default:
      return `Computer use is not available on ${hostLabel}.`;
  }
}

export const CUA_WAYLAND_NOTE =
  "This computer uses Wayland, where computer use works with fewer apps than on X11. Your desktop may ask you to approve screen capture.";

const VERIFICATION_ORDER: readonly CuaVerificationStepId[] = [
  "grants",
  "restart",
  "permissions",
  "identity",
  "capture",
  "accessibility",
];

const VERIFICATION_LABELS: Record<CuaVerificationStepId, string> = {
  grants: "Permissions allowed for GOAT",
  restart: "Computer use restarted with them",
  permissions: "Computer use sees both permissions",
  identity: "Computer use runs inside GOAT",
  capture: "Captured a GOAT window",
  accessibility: "Read the window's controls",
};

export interface CuaVerificationRow {
  readonly id: CuaVerificationStepId;
  readonly label: string;
  readonly state: "passed" | "failed" | "not-checked";
  readonly detail?: string;
}

/** Steps after the first failure did not run, so they show as not checked. */
export function cuaVerificationRows(result: DesktopCuaVerification): readonly CuaVerificationRow[] {
  return VERIFICATION_ORDER.map((id) => {
    const step = result.steps.find((candidate) => candidate.id === id);
    if (!step) return { id, label: VERIFICATION_LABELS[id], state: "not-checked" };
    return {
      id,
      label: VERIFICATION_LABELS[id],
      state: step.ok ? "passed" : "failed",
      ...(step.detail === undefined ? {} : { detail: step.detail }),
    };
  });
}

export function computerUseStatusText(input: {
  readonly enabled: boolean;
  readonly status: CuaHostStatus | null;
  readonly error: string | null;
  readonly missingGrants: readonly CuaPermission[];
}): string | null {
  if (input.error) return `Could not check computer use: ${input.error}`;
  if (input.status === null) return "Checking this host…";
  if (input.status.platform === "other") return "Computer use is not available on this host.";
  if (!input.enabled) return null;
  if (input.missingGrants.length > 0) {
    const names = input.missingGrants.map((permission) =>
      permission === "accessibility" ? "Accessibility" : "Screen Recording",
    );
    return `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} off. Choose Set up to allow it again.`;
  }
  if (input.status.running) return "Running";
  return input.status.failure ?? "Starts with the next agent turn";
}
