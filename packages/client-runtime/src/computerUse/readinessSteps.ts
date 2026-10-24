import {
  computerUseReady,
  type ComputerUseCapabilities,
  type ComputerUseGrant,
  type ComputerUseMethod,
  type ComputerUseReadiness,
  type CuaHostStatus,
  type CuaToolsAvailability,
} from "@goat/contracts";

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
    detail: "The helper is not authenticated. Reconnect or restart GOAT on this computer.",
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
}: {
  readonly readiness?: ComputerUseReadiness | undefined;
  readonly platform?: CuaHostStatus["platform"] | undefined;
  readonly tools?: CuaToolsAvailability | undefined;
  readonly signals?: ComputerUseCapabilities["signals"] | undefined;
}) {
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
  const grantIds = ["accessibility", "screenCapture"] as const;
  const current = grantIds.find((id) => readiness?.grants[id] !== "granted");
  const grants: ReadinessGrantRow[] = grantIds.map((grant) => {
    const state = readiness?.grants[grant] ?? "unknown";
    return {
      grant,
      state,
      status: readiness ? grantCopy[state].state : unavailable.state,
      title: titles[grant],
      detail: [readiness ? grantCopy[state].detail : unavailable.detail],
      isCurrent: grant === current,
    };
  });
  const blockers = (readiness?.blockers ?? []).map((id) => ({
    id,
    ...blockerRemedies[id],
    ...(platform === "win32" && windowsRemedies[id] ? { remedy: windowsRemedies[id] } : {}),
  }));
  const helper = readiness ? helperCopy[readiness.helper] : unavailable;
  const capture = readiness
    ? [captureCopy[readiness.capture], treeCopy[readiness.tree], inputCopy[readiness.input]]
    : [unavailable];
  const toolsStatus = tools
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
  // Linux reasons come from capture/tree/input probes, including foreground-only limitations.
  // Other helpers give one reason per not-ready step in onboarding order; reasons never gate readiness.
  const notReady =
    platform === "linux"
      ? [2]
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
    report,
    steps,
    blockers,
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
