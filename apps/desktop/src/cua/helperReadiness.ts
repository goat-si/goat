import {
  CUA_STALE_ACCESSIBILITY_ADVICE,
  type ComputerUseCapabilities,
  type ComputerUseReadiness,
} from "@goat/contracts";

type Readiness = ComputerUseReadiness;
type Blocker = Readiness["blockers"][number];

/**
 * What this host's computer use helper has shown so far. Capture and the tree count only once a
 * real read proved them (D10), and only until the grants change or a later check fails; then
 * they need fresh proof.
 */
export interface HelperReadinessState {
  readonly grants: Readiness["grants"];
  readonly running: boolean;
  /**
   * A readiness check got past the helper's identity and read through it. The helper stays
   * confirmed while idle, because it starts when an agent needs it, until a proof is dropped.
   */
  readonly confirmed: boolean;
  readonly capture: Readiness["capture"];
  readonly tree: Readiness["tree"];
  /** What the last check found blocking capture, such as a locked screen. */
  readonly blockers: ReadonlyArray<Blocker>;
  /** Why the last check could not prove capture or the tree. */
  readonly details: ReadonlyArray<string>;
  /** Why the helper says this desktop cannot be used at all (Windows), until it says otherwise. */
  readonly desktop?: { readonly detail: string; readonly blocker?: Blocker };
}

/**
 * The safety signals a desktop host's helper raises (#1235): a focused secure field when the
 * running helper said it can watch for one, and a person's input when its agent connections
 * report it (macOS, through the lease proxy). Without both, unattended turns stay refused.
 */
export const helperSignals = (
  canWatch: boolean,
  reportsInput: boolean,
): ComputerUseCapabilities["signals"] => ({
  privateMode: canWatch ? "supported" : "unsupported",
  humanInput: reportsInput ? "supported" : "unsupported",
});

export const initialHelperReadiness: HelperReadinessState = {
  grants: { accessibility: "unknown", screenCapture: "unknown" },
  running: false,
  confirmed: false,
  capture: "pending",
  tree: "unavailable",
  blockers: [],
  details: [],
};

/** Forgets capture and tree proofs; detail says why the check that would renew them failed. */
export const withoutProof = (
  state: HelperReadinessState,
  detail?: string,
): HelperReadinessState => ({
  ...state,
  confirmed: false,
  capture: "pending",
  tree: "unavailable",
  blockers: [],
  details: detail === undefined ? [] : [detail],
});

/**
 * A grant check only answers on or off. Off right after asking means the person has not
 * answered yet; off without asking is not known to be a refusal. A grant that changed voids
 * what was proven under the old one.
 */
export const withGrants = (
  state: HelperReadinessState,
  answer: {
    readonly accessibility: boolean;
    readonly screenRecording: boolean;
    readonly detail?: string;
    readonly blocker?: Blocker;
  },
  prompted: boolean,
): HelperReadinessState => {
  const grant = (on: boolean): Readiness["grants"]["accessibility"] =>
    on ? "granted" : prompted ? "pending" : "unknown";
  const grants = {
    accessibility: grant(answer.accessibility),
    screenCapture: grant(answer.screenRecording),
  };
  const changed =
    grants.accessibility !== state.grants.accessibility ||
    grants.screenCapture !== state.grants.screenCapture;
  const { desktop: _previous, ...rest } = changed ? withoutProof(state) : state;
  return {
    ...rest,
    grants,
    ...(answer.detail === undefined
      ? {}
      : {
          desktop: {
            detail: answer.detail,
            ...(answer.blocker === undefined ? {} : { blocker: answer.blocker }),
          },
        }),
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
  // Only a check that passed the identity step reads a window through the helper.
  confirmed: true,
  capture: proof.capture,
  tree: proof.elements === undefined ? "unavailable" : proof.elements > 0 ? "ready" : "empty",
  blockers: proof.screenLocked ? ["screenLocked"] : [],
  details: proof.details,
});

export const toReadiness = (
  state: HelperReadinessState,
  principal: string,
  platform: NodeJS.Platform = "darwin",
): Readiness => {
  const off = [
    ...(state.grants.accessibility === "granted" ? [] : ["Accessibility"]),
    ...(state.grants.screenCapture === "granted" ? [] : ["Screen Recording"]),
  ];
  const unproven = state.capture === "pending" && state.details.length === 0;
  // A grant macOS reports on proves nothing by itself (AXIsProcessTrusted stays true for a switch
  // macOS no longer honors, trycua/cua#3170); a tree read that fails under it is the tell.
  const stale =
    platform === "darwin" &&
    state.confirmed &&
    state.grants.accessibility === "granted" &&
    state.capture !== "pending" &&
    state.tree === "empty";
  const blockers = [
    ...new Set([
      ...state.blockers,
      ...(stale ? (["accessibilityStale"] as const) : []),
      ...(state.desktop?.blocker === undefined ? [] : [state.desktop.blocker]),
    ]),
  ];
  const usable = state.running || state.confirmed;
  return {
    grants: state.grants,
    helper: usable ? "authenticated" : "unauthenticated",
    capture: state.capture,
    tree: state.tree,
    // The driver delivers input to a window without raising it on macOS and Windows; a confirmed
    // helper that is idle does so once it starts.
    input: usable ? "background" : "unavailable",
    blockers,
    reasons: [
      // The helper's own refusal names the real cause; the grant pair it zeroed would mislead.
      ...(state.desktop !== undefined
        ? [state.desktop.detail]
        : off.length === 0
          ? []
          : [
              `${off.join(" and ")} ${off.length > 1 ? "are" : "is"} not on for ${principal}.`,
              ...(platform !== "darwin" || state.grants.accessibility === "granted"
                ? []
                : [CUA_STALE_ACCESSIBILITY_ADVICE]),
            ]),
      ...(usable ? [] : [`${principal} has not been confirmed by a readiness check yet.`]),
      ...state.details,
      ...(unproven
        ? ["Run the readiness check so a real screenshot and accessibility read prove the rest."]
        : []),
    ],
  };
};
