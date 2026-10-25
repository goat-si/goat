import {
  computerUseReady,
  type ComputerUseCapabilities,
  type ComputerUseGrant,
  type ComputerUseMethod,
  type ComputerUseReadiness,
  type CuaAgentBlock,
  cuaAgentBlockMessage,
  type CuaHostStatus,
  type CuaToolsAvailability,
} from "@goat/contracts";

import { linuxComputerUseSetup } from "../computerUseLinuxSetup.ts";

export type ReadinessStepState = "ok" | "pending" | "blocked" | "unsupported" | "unknown";
type GrantId = keyof ComputerUseReadiness["grants"];
type StepId = "grants" | "helper" | "capture" | "tools";
type Blocker = ComputerUseReadiness["blockers"][number];
export interface ReadinessGrantRow {
  readonly grant: GrantId;
  readonly state: ComputerUseGrant;
  readonly status: ReadinessStepState;
  readonly title: string;
  readonly detail: ReadonlyArray<string>;
  readonly isCurrent: boolean;
}
export interface ReadinessStep {
  readonly id: StepId;
  readonly state: ReadinessStepState;
  readonly title: string;
  readonly detail: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<ReadinessGrantRow>;
}

const grantCopy = {
  granted: { state: "ok", detail: "Access granted." },
  pending: {
    state: "pending",
    detail: "Waiting for your answer to the permission request on this computer.",
  },
  denied: {
    state: "blocked",
    detail: "Access denied. Allow this permission in this computer's system settings.",
  },
  abandoned: {
    state: "blocked",
    detail:
      "The permission request closed without an answer. Request access again on this computer.",
  },
  unknown: {
    state: "unknown",
    detail: "Permission has not been checked. Check access on this computer.",
  },
} as const satisfies Record<ComputerUseGrant, { state: ReadinessStepState; detail: string }>;
const helperCopy = {
  authenticated: { state: "ok", detail: "The helper is authenticated." },
  unauthenticated: {
    state: "blocked",
    detail:
      "The helper has not been confirmed yet. Run the readiness check; if it fails, restart GOAT on this computer.",
  },
  incompatible: {
    state: "unsupported",
    detail: "The helper protocol is incompatible. Update GOAT and its helper together.",
  },
} as const satisfies Record<
  ComputerUseReadiness["helper"],
  { state: ReadinessStepState; detail: string }
>;
const captureCopy = {
  ready: { state: "ok", detail: "A real window capture succeeded." },
  blank: {
    state: "blocked",
    detail: "The capture is blank. Check screen capture access and open a visible window.",
  },
  noWindow: {
    state: "pending",
    detail: "No window is available. Open a window on this computer to check capture.",
  },
  pending: { state: "pending", detail: "Waiting for screen capture consent on this computer." },
  unavailable: {
    state: "unsupported",
    detail: "Window capture is unavailable in this desktop session.",
  },
} as const satisfies Record<
  ComputerUseReadiness["capture"],
  { state: ReadinessStepState; detail: string }
>;
const treeCopy = {
  ready: { state: "ok", detail: "A real accessibility tree read succeeded." },
  empty: {
    state: "blocked",
    detail: "The accessibility tree is empty. Open an app with accessible controls.",
  },
  unavailable: {
    state: "unsupported",
    detail: "The accessibility tree is unavailable. Check accessibility access on this computer.",
  },
} as const satisfies Record<
  ComputerUseReadiness["tree"],
  { state: ReadinessStepState; detail: string }
>;
const inputCopy = {
  background: { state: "ok", detail: "Background input is available." },
  foregroundOnly: {
    state: "ok",
    detail: "Input is available only in the foreground; a computer use lease is required.",
  },
  unavailable: { state: "unsupported", detail: "Input is unavailable in this desktop session." },
} as const satisfies Record<
  ComputerUseReadiness["input"],
  { state: ReadinessStepState; detail: string }
>;
const toolsCopy = {
  available: {
    state: "ok",
    detail:
      "Computer use is enabled and the driver is running on this host. Agents can attach the tools.",
  },
  off: { state: "blocked", detail: "Computer use is off. Enable it in this host's settings." },
  unavailable: {
    state: "blocked",
    detail:
      "The driver is not running or attachable on this host. Start computer use on this computer.",
  },
} as const satisfies Record<CuaToolsAvailability, { state: ReadinessStepState; detail: string }>;
// A passing check stops its own helper, so with nothing failed the driver is only idle (#1538).
const STARTS_WITH_NEXT_TURN =
  "Starts with the next agent turn. GOAT starts the driver when an agent needs it.";

// The Linux helper reports pending both before a Wayland desktop's consent and when its
// compositor cannot capture one window, so it is not described as a prompt to answer.
const LINUX_CAPTURE_UNPROVEN =
  "Screen capture is not proven yet. A Wayland desktop may be waiting for consent, or may not capture one window at all.";
// Windows asks nobody for consent: pending there means no check has read a window since the
// helper started, and the tree it reports unavailable meanwhile is unread, not refused (#1520).
// Only GOAT's desktop app on that computer can run the check; a remote client only saves.
const windowsCaptureUnchecked = (machine: string) =>
  `Not checked yet. Turning computer use on in the GOAT desktop app on ${machine} restarts the helper and proves a real window capture.`;
const WINDOWS_TREE_UNCHECKED = "The accessibility tree is read by the same check.";

const blockerRemedies = {
  screenLocked: { step: "capture", remedy: "Unlock the screen on this computer." },
  userIntervened: { step: "capture", remedy: "Computer use resumes when the person's input ends." },
  noInteractiveDesktop: {
    step: "capture",
    remedy:
      "Start GOAT from the signed-in desktop, not a service or SSH session (including Windows Session 0).",
  },
  otherUserAtConsole: {
    step: "capture",
    remedy: "Another user is signed in at the console. Switch to the desktop session running GOAT.",
  },
  restartRequired: {
    step: "grants",
    remedy: "Restart the helper or GOAT so the permission grant takes effect.",
  },
} as const satisfies Record<Blocker, { step: StepId; remedy: string }>;

// Windows has no permission prompt to walk through; what stops computer use there is the
// session, the secure desktop, elevation and app control (#1137, D14).
const windowsRemedies: Partial<Record<Blocker, string>> = {
  screenLocked:
    "Unlock the screen, or answer the Windows security prompt (User Account Control) on this computer. Computer use waits while either is shown.",
};
const WINDOWS_ELEVATED =
  "Apps running as administrator stay out of reach: GOAT never runs its helper as administrator.";
// Smart App Control has no per-app exceptions, so only a signed build gets past it.
const WINDOWS_APP_CONTROL =
  "If Windows blocked GOAT Computer Use: under your organization's app control policy, ask your administrator to allow it; under Smart App Control, which allows no exceptions, install a signed GOAT release. Then restart GOAT.";

const combine = (states: ReadonlyArray<ReadinessStepState>): ReadinessStepState => {
  for (const state of ["blocked", "unsupported", "unknown", "pending"] as const) {
    if (states.includes(state)) return state;
  }
  return "ok";
};

export function computerUseReadinessSteps({
  readiness,
  platform,
  tools,
  signals,
  machine,
  block,
  failure,
  display,
}: {
  readonly readiness?: ComputerUseReadiness | undefined;
  readonly platform?: CuaHostStatus["platform"] | undefined;
  readonly tools?: CuaToolsAvailability | undefined;
  readonly signals?: ComputerUseCapabilities["signals"] | undefined;
  /** The host's name in the Linux guide, which tells a person where to act. */
  readonly machine?: string | undefined;
  /** Why the desktop gave agents no driver, when it was a grant macOS has not given (#1399). */
  readonly block?: CuaAgentBlock | undefined;
  /** Why the driver last failed to start on the host, when it did. */
  readonly failure?: string | undefined;
  /** What the host's screen allows now; an unusable one stops agents before any start fails. */
  readonly display?: CuaHostStatus["display"] | undefined;
}) {
  const noScreen = display?.capability === "unavailable" ? display.reason : undefined;
  const report = platform === "other" ? "unsupported" : readiness ? "reported" : "notReported";
  const unreported = "The helper has not reported readiness yet.";
  const unavailable = {
    state: report === "unsupported" ? "unsupported" : "unknown",
    detail: report === "unsupported" ? "Computer use is unsupported on this platform." : unreported,
  } as const;
  const titles = {
    accessibility:
      platform === "win32" ? "UI Automation" : platform === "linux" ? "AT-SPI" : "Accessibility",
    screenCapture:
      platform === "darwin"
        ? "Screen & System Audio Recording"
        : platform === "win32"
          ? "Screen capture"
          : platform === "linux"
            ? "Screen capture / desktop portal"
            : "Screen capture",
  };
  const linuxUnproven = platform === "linux";
  const grantIds = ["accessibility", "screenCapture"] as const;
  const current = grantIds.find((id) => readiness?.grants[id] !== "granted");
  const grants: ReadinessGrantRow[] = grantIds.map((grant) => {
    const state = readiness?.grants[grant] ?? "unknown";
    return {
      grant,
      state,
      status: readiness ? grantCopy[state].state : unavailable.state,
      title: titles[grant],
      detail: [
        !readiness
          ? unavailable.detail
          : linuxUnproven && grant === "screenCapture" && state === "pending"
            ? LINUX_CAPTURE_UNPROVEN
            : grantCopy[state].detail,
      ],
      isCurrent: grant === current,
    };
  });
  const blockers = (readiness?.blockers ?? []).map((id) => ({
    id,
    ...blockerRemedies[id],
    ...(platform === "win32" && windowsRemedies[id] ? { remedy: windowsRemedies[id] } : {}),
  }));
  const helper = readiness ? helperCopy[readiness.helper] : unavailable;
  // Capture, the tree and input are read through a confirmed helper; before that, or while it
  // does not answer (#1514), they are unchecked, not unsupported.
  const unconfirmed = readiness !== undefined && readiness.helper !== "authenticated";
  const windowsUnchecked = platform === "win32" && readiness?.capture === "pending";
  const capture = readiness
    ? [
        linuxUnproven && readiness.capture === "pending"
          ? ({ state: "pending", detail: LINUX_CAPTURE_UNPROVEN } as const)
          : windowsUnchecked
            ? ({
                state: "pending",
                detail: windowsCaptureUnchecked(machine ?? "this computer"),
              } as const)
            : unconfirmed && readiness.capture === "unavailable"
              ? ({
                  state: "unknown",
                  detail: "Window capture is checked once the helper is confirmed.",
                } as const)
              : captureCopy[readiness.capture],
        unconfirmed && readiness.tree === "unavailable"
          ? ({
              state: "unknown",
              detail: "The accessibility tree is read once the helper is confirmed.",
            } as const)
          : windowsUnchecked && readiness.tree === "unavailable"
            ? ({ state: "pending", detail: WINDOWS_TREE_UNCHECKED } as const)
            : treeCopy[readiness.tree],
        unconfirmed && readiness.input === "unavailable"
          ? ({
              state: "unknown",
              detail: "Input is checked once the helper is confirmed.",
            } as const)
          : inputCopy[readiness.input],
      ]
    : [unavailable];
  const toolsStatus =
    block !== undefined && tools !== "off" && tools !== "available"
      ? ({ state: "blocked", detail: cuaAgentBlockMessage(block) } as const)
      : tools === "available" && unconfirmed
        ? ({
            state: "unknown",
            detail:
              "The driver is running. Whether agents can use computer use is not proven until the helper is confirmed.",
          } as const)
        : tools === "unavailable" && noScreen !== undefined
          ? ({ state: "blocked", detail: noScreen } as const)
          : tools === "unavailable" && failure === undefined
            ? ({ state: "pending", detail: STARTS_WITH_NEXT_TURN } as const)
            : tools === "unavailable"
              ? ({
                  state: "blocked",
                  detail: `${failure} ${toolsCopy.unavailable.detail}`,
                } as const)
              : tools
                ? toolsCopy[tools]
                : ({
                    state: "unknown",
                    detail: "The server has not reported whether agent tools are available yet.",
                  } as const);
  const steps: ReadinessStep[] = [
    {
      id: "grants",
      title: "OS grants",
      state: readiness ? combine(grants.map((row) => row.status)) : unavailable.state,
      detail: [readiness ? "Permissions on the computer running the helper." : unavailable.detail],
      grants,
    },
    {
      id: "helper",
      title: "Helper authenticated",
      state: helper.state,
      detail: [helper.detail],
      grants: [],
    },
    {
      id: "capture",
      title: "Capture and tree ready",
      state: combine(capture.map((part) => part.state)),
      detail: capture.map((part) => part.detail),
      grants: [],
    },
    {
      id: "tools",
      title: "Tools available to the agent",
      state: toolsStatus.state,
      detail: [toolsStatus.detail],
      grants: [],
    },
  ];
  for (const blocker of blockers) {
    const index = steps.findIndex((step) => step.id === blocker.step);
    const step = steps[index];
    if (step)
      steps[index] = { ...step, state: "blocked", detail: [...step.detail, blocker.remedy] };
  }
  // Linux reasons come from capture/tree/input probes, including foreground-only limitations,
  // unless the helper is unconfirmed: then they say why. Other helpers give one reason per
  // not-ready step in onboarding order; reasons never gate readiness.
  const notReady =
    platform === "linux"
      ? [unconfirmed ? 1 : 2]
      : steps.slice(0, 3).flatMap((step, index) => (step.state !== "ok" ? [index] : []));
  for (const [index, reason] of (readiness?.reasons ?? []).entries()) {
    const stepIndex = notReady[Math.min(index, notReady.length - 1)] ?? 2;
    const step = steps[stepIndex];
    if (step && reason.trim()) steps[stepIndex] = { ...step, detail: [...step.detail, reason] };
  }
  const helperStep = steps[1];
  if (helperStep) {
    const signalDetail = (["humanInput", "privateMode"] as const).map((signal) => {
      const label = signal === "humanInput" ? "Human input detection" : "Private mode detection";
      return `${label}: ${signals?.[signal] ?? "not reported"}.`;
    });
    steps[1] = {
      ...helperStep,
      detail: [
        ...helperStep.detail,
        ...signalDetail,
        "Interactive turns may proceed without both detection signals. Unattended turns require both signals to be supported.",
      ],
    };
  }
  const linux = readiness?.platform?.linux;
  const captureStep = steps[2];
  if (platform === "linux" && linux && captureStep)
    steps[2] = {
      ...captureStep,
      detail: [...captureStep.detail, `Linux display server: ${linux.displayServer}.`],
    };
  if (platform === "win32" && readiness) {
    const [, helperNow, captureNow] = steps;
    // A helper that read a real window ran; only one that never got that far may be blocked.
    const neverRan =
      readiness.helper !== "authenticated" &&
      readiness.capture !== "ready" &&
      readiness.tree !== "ready";
    if (helperNow && neverRan)
      steps[1] = { ...helperNow, detail: [...helperNow.detail, WINDOWS_APP_CONTROL] };
    if (captureNow) steps[2] = { ...captureNow, detail: [...captureNow.detail, WINDOWS_ELEVATED] };
  }
  return {
    ready: readiness !== undefined && computerUseReady(readiness) && tools === "available",
    // Everything is proven and nothing failed; the driver only waits for an agent's turn.
    startsWithNextTurn:
      readiness !== undefined &&
      computerUseReady(readiness) &&
      tools === "unavailable" &&
      failure === undefined &&
      noScreen === undefined &&
      block === undefined,
    report,
    steps,
    blockers,
    // What each step means on a Linux desktop and what to do there, with copyable commands.
    linuxSetup:
      platform === "linux" && readiness !== undefined
        ? linuxComputerUseSetup(readiness, machine ?? "this computer")
        : undefined,
  } as const;
}

type PlatformMethods = Record<ComputerUseMethod, "supported" | { readonly unsupported: string }>;
const protocolMethods = {
  capabilities: "supported",
  permissions: "supported",
  listWindows: "supported",
  observe: "supported",
  watch: "supported",
  unwatch: "supported",
  click: "supported",
  doubleClick: "supported",
  rightClick: "supported",
  typeText: "supported",
  pressKey: "supported",
  scroll: "supported",
  drag: "supported",
  setValue: "supported",
  performAction: "supported",
} as const satisfies PlatformMethods;

// A supported protocol method may still return a typed unsupported refusal for a desktop session.
export const COMPUTER_USE_PLATFORM_PARITY = {
  darwin: protocolMethods,
  win32: protocolMethods,
  linux: {
    ...protocolMethods,
    // The Linux helper does not watch for the safety signals yet (#1235).
    watch: { unsupported: "The Linux helper does not watch for safety signals yet." },
    unwatch: { unsupported: "The Linux helper does not watch for safety signals yet." },
  },
} as const satisfies Record<"darwin" | "win32" | "linux", PlatformMethods>;
