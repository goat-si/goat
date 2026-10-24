import type { ComputerUseCapabilities, ComputerUseReadiness } from "@goat/contracts";

type Readiness = ComputerUseReadiness;

/**
 * What this host's computer use helper has shown so far. Capture and the tree count only once a
 * real read proved them (D10), and stay proven across helper launches until a later check says
 * otherwise; the grants are whatever the last grant check answered.
 */
export interface HelperReadinessState {
  readonly grants: Readiness["grants"];
  readonly running: boolean;
  readonly capture: Readiness["capture"];
  readonly tree: Readiness["tree"];
  readonly blockers: Readiness["blockers"];
  /** Why the last check could not prove capture or the tree. */
  readonly details: ReadonlyArray<string>;
}

/** Neither the macOS nor the Windows helper raises the safety signals yet (#1235). */
export const HELPER_SIGNALS: ComputerUseCapabilities["signals"] = {
  privateMode: "unsupported",
  humanInput: "unsupported",
};

export const initialHelperReadiness: HelperReadinessState = {
  grants: { accessibility: "unknown", screenCapture: "unknown" },
  running: false,
  capture: "pending",
  tree: "unavailable",
  blockers: [],
  details: [],
};

/**
 * A grant check only answers on or off. Off right after asking means the person has not
 * answered yet; off without asking is not known to be a refusal.
 */
export const withGrants = (
  state: HelperReadinessState,
  grants: { readonly accessibility: boolean; readonly screenRecording: boolean },
  prompted: boolean,
): HelperReadinessState => {
  const grant = (on: boolean) => (on ? "granted" : prompted ? "pending" : "unknown");
  return {
    ...state,
    grants: {
      accessibility: grant(grants.accessibility),
      screenCapture: grant(grants.screenRecording),
    },
  };
};

export const withRunning = (state: HelperReadinessState, running: boolean) =>
  state.running === running ? state : { ...state, running };

/** What one readiness check read through a running driver. */
export interface HelperProof {
  /** noWindow: no GOAT window was on screen to capture. */
  readonly capture: "ready" | "blank" | "noWindow" | "unavailable";
  /** Absent when the check stopped before reading the tree. */
  readonly elements?: number;
  readonly screenLocked: boolean;
  readonly details: ReadonlyArray<string>;
}

export const withProof = (
  state: HelperReadinessState,
  proof: HelperProof,
): HelperReadinessState => ({
  ...state,
  capture: proof.capture,
  tree: proof.elements === undefined ? "unavailable" : proof.elements > 0 ? "ready" : "empty",
  blockers: proof.screenLocked ? ["screenLocked"] : [],
  details: proof.details,
});

export const toReadiness = (state: HelperReadinessState, principal: string): Readiness => {
  const off = [
    ...(state.grants.accessibility === "granted" ? [] : ["Accessibility"]),
    ...(state.grants.screenCapture === "granted" ? [] : ["Screen Recording"]),
  ];
  const unproven = state.capture === "pending" && state.details.length === 0;
  return {
    grants: state.grants,
    helper: state.running ? "authenticated" : "unauthenticated",
    capture: state.capture,
    tree: state.tree,
    // The driver delivers input to a window without raising it on macOS and Windows, but only
    // while it runs.
    input: state.running ? "background" : "unavailable",
    blockers: state.blockers,
    reasons: [
      ...(off.length === 0
        ? []
        : [`${off.join(" and ")} ${off.length > 1 ? "are" : "is"} not on for ${principal}.`]),
      ...(state.running ? [] : [`${principal} is not running computer use.`]),
      ...state.details,
      ...(unproven
        ? ["Run the readiness check so a real screenshot and accessibility read prove the rest."]
        : []),
    ],
  };
};
