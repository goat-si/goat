import type {
  CuaHostStatus,
  CuaVerificationStepId,
  DesktopCuaGrants,
  DesktopCuaVerification,
  HostComputerUse,
} from "@goat/contracts";

export type CuaPermission = "accessibility" | "screen-recording";
export const CUA_PERMISSIONS: readonly CuaPermission[] = ["accessibility", "screen-recording"];

/** The grants of an app that can hold them; an unusable helper has none to show. */
export type CuaGrantHolder = Exclude<DesktopCuaGrants, { principal: "unusable" }>;

export const cuaGranted = (grants: CuaGrantHolder, permission: CuaPermission) =>
  permission === "accessibility" ? grants.accessibility : grants.screenRecording;

/**
 * allowed: macOS answers yes. next: the step to do now. waiting: its System Settings pane is
 * open and the switch is not on yet. later: after the step in progress.
 */
export type CuaGrantStepState = "allowed" | "next" | "waiting" | "later";

export interface CuaGrantStep {
  readonly id: CuaPermission;
  readonly title: string;
  readonly description: string;
  readonly state: CuaGrantStepState;
}

const GRANT_STEP_COPY: Record<CuaPermission, { title: string; description: string }> = {
  accessibility: {
    title: "Accessibility",
    description: "Click, type, and read controls in other apps.",
  },
  "screen-recording": {
    title: "Screen & System Audio Recording",
    description: "See windows to decide what to do next.",
  },
};

/** One step per grant, in the order macOS is asked; only the first missing one is actionable. */
export function cuaGrantSteps(
  grants: CuaGrantHolder,
  opened: CuaPermission | null,
): readonly CuaGrantStep[] {
  let current: CuaPermission | undefined;
  return CUA_PERMISSIONS.map((id) => {
    const copy = GRANT_STEP_COPY[id];
    if (cuaGranted(grants, id)) return { id, ...copy, state: "allowed" };
    if (current !== undefined) return { id, ...copy, state: "later" };
    current = id;
    return { id, ...copy, state: opened === id ? "waiting" : "next" };
  });
}

/**
 * Remedies for the ways a grant goes missing: an older copy's entry left on, the wrong app
 * switched on, no entry at all, and a rebuilt app. GOAT shows the reset command and never runs it.
 */
export function cuaGrantTroubleshooting(grants: CuaGrantHolder): readonly string[] {
  const name = grants.name;
  return [
    `${name} is already on in the list but setup still waits: that entry belongs to an older copy. Select it, remove it with the − button, then drag ${name} in again and turn it on.`,
    ...(grants.principal === "helper"
      ? [
          `Only the switch for ${name} counts. Turning on GOAT, Terminal, or another app does not let agents use this Mac.`,
        ]
      : []),
    `If ${name} is not in the list, drag it in from the panel next to System Settings, or show it in Finder and drag it from there.`,
    `After an update or a new development build, macOS can treat ${name} as a new app. Remove its old entry and allow it again.`,
    `To clear every entry for it, run these in Terminal, then allow it again: tccutil reset Accessibility ${grants.bundleId} and tccutil reset ScreenCapture ${grants.bundleId}`,
  ];
}

/**
 * Whether quitting and reopening GOAT is the remedy. GOAT reads its own grants once per
 * process, so a grant to GOAT can stay unseen until it restarts; a helper is read fresh each
 * check, so only a check whose restarted driver still lacks the grants calls for it.
 */
export function cuaNeedsRelaunch(input: {
  readonly grants: CuaGrantHolder | null;
  readonly opened: CuaPermission | null;
  readonly verification: DesktopCuaVerification | null;
}): boolean {
  const failed = input.verification?.steps.find((step) => !step.ok)?.id;
  if (failed === "permissions" || failed === "capture") return true;
  return (
    input.grants?.principal === "app" &&
    input.opened !== null &&
    !cuaGranted(input.grants, input.opened)
  );
}

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

/** The host checked its screen and the driver cannot run there; older hosts never say so. */
export function computerUseUnavailable(status: CuaHostStatus | null): boolean {
  return status?.platform === "other" || status?.display?.capability === "unavailable";
}

const VERIFICATION_ORDER: readonly CuaVerificationStepId[] = [
  "grants",
  "restart",
  "permissions",
  "identity",
  "capture",
  "accessibility",
];

const VERIFICATION_LABELS: Record<CuaVerificationStepId, string> = {
  grants: "Permissions allowed",
  restart: "Computer use restarted with them",
  permissions: "Computer use sees both permissions",
  identity: "Computer use runs as the allowed app",
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
  const display = input.status.display;
  if (!input.enabled) return display && display.capability !== "available" ? display.reason : null;
  if (input.missingGrants.length > 0) {
    const names = input.missingGrants.map((permission) =>
      permission === "accessibility" ? "Accessibility" : "Screen Recording",
    );
    return `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} off. Choose Set up to allow it again.`;
  }
  if (input.status.running)
    return display?.capability === "partial" ? `Running with limits. ${display.reason}` : "Running";
  return input.status.failure ?? "Starts with the next agent turn";
}

/** One line for a host card: whether computer use is on and what the host's screen allows. */
export function hostComputerUseText(computerUse: HostComputerUse | undefined): string | null {
  if (computerUse === undefined) return null;
  const state = computerUse.enabled ? (computerUse.running ? "On, running" : "On") : "Off";
  if (computerUse.capability === "unavailable") return `Unavailable. ${computerUse.reason}`;
  if (computerUse.capability === "partial") return `${state}, limited. ${computerUse.reason}`;
  // A Mac's only screen is its console, which says nothing to the reader.
  return computerUse.display && computerUse.display !== "console"
    ? `${state} (${computerUse.display})`
    : state;
}
