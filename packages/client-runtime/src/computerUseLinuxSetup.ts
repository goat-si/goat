import {
  computerUseReady,
  type ComputerUseGrant,
  type ComputerUseReadiness,
} from "@goat/contracts";

/**
 * The Linux variant of computer use setup (D14): what each readiness step from the helper means
 * on a Linux desktop and what the person can do about it at that machine. Clients render the
 * steps in the shared onboarding panel; guidance is shown, never run.
 */

export type ComputerUseSetupStatus =
  /** Proven by a real read; nothing to do. */
  | "done"
  /** The person has something to do. */
  | "action"
  /** Waiting on something outside the person's hands right now, such as an open dialog. */
  | "waiting"
  /** Works, with a limit the person should know about. */
  | "limited"
  /** Not possible on this desktop. */
  | "unavailable";

export interface ComputerUseSetupGuidance {
  /** A command is shown as copyable text; a person runs it in a terminal at that machine. */
  readonly kind: "text" | "command";
  readonly text: string;
}

export interface ComputerUseSetupStep {
  readonly id: "session" | "accessibility" | "capture" | "input" | "helper" | "blocker";
  readonly status: ComputerUseSetupStatus;
  readonly title: string;
  readonly detail: string;
  readonly guidance: ReadonlyArray<ComputerUseSetupGuidance>;
}

export interface ComputerUseSetup {
  /** computerUseReady: every step proven and nothing blocking. */
  readonly ready: boolean;
  readonly steps: ReadonlyArray<ComputerUseSetupStep>;
}

const text = (value: string): ComputerUseSetupGuidance => ({ kind: "text", text: value });
const command = (value: string): ComputerUseSetupGuidance => ({ kind: "command", text: value });

const SESSION_NAMES = {
  x11: "an X11 desktop session",
  xwayland: "a Wayland desktop session with XWayland",
  wayland: "a Wayland desktop session",
} as const;

function sessionStep(readiness: ComputerUseReadiness, machine: string): ComputerUseSetupStep {
  const server = readiness.platform?.linux?.displayServer;
  // A named display is not proof the helper can use it: without a session bus, or on a
  // compositor the driver cannot drive, every step reads unavailable and the reason says why.
  const reached = readiness.input !== "unavailable";
  if (server !== undefined && reached)
    return {
      id: "session",
      status: "done",
      title: "Desktop session",
      detail: "GOAT uses " + SESSION_NAMES[server] + " on " + machine + ".",
      guidance: [],
    };
  if (server !== undefined)
    return {
      id: "session",
      status: "action",
      title: "Desktop session cannot be used",
      detail:
        readiness.reasons[0] ??
        "GOAT found " + SESSION_NAMES[server] + " on " + machine + " but cannot use it.",
      guidance: [],
    };
  // The helper explains which of display or session bus is missing in its first reason.
  return {
    id: "session",
    status: "action",
    title: "No desktop session",
    detail:
      readiness.reasons[0] ?? "GOAT found no desktop session on " + machine + " to see or control.",
    guidance: [
      text(
        "Sign in to a desktop on " +
          machine +
          " and start GOAT from that session, so it shares the session's display and D-Bus.",
      ),
      text(
        "A server without a screen can run computer use inside a virtual display such as Xvfb, with its own D-Bus session and AT-SPI.",
      ),
    ],
  };
}

function accessibilityStep(readiness: ComputerUseReadiness): ComputerUseSetupStep {
  if (readiness.tree === "ready")
    return {
      id: "accessibility",
      status: "done",
      title: "App controls",
      detail: "GOAT can read buttons, fields and menus through AT-SPI.",
      guidance: [],
    };
  if (readiness.tree === "empty")
    return {
      id: "accessibility",
      status: "waiting",
      title: "App controls",
      detail:
        "AT-SPI answers, but the app GOAT checked shows it no windows. Open the app you want GOAT to use.",
      guidance: [],
    };
  // AT-SPI is proven by reading a window; with none open there was nothing to read, so it is
  // not known to be off (#1394).
  if (readiness.capture === "noWindow")
    return {
      id: "accessibility",
      status: "waiting",
      title: "App controls",
      detail:
        "Open any app window. GOAT reads app controls through AT-SPI, the Linux accessibility service, and checks it on an open window.",
      guidance: [
        text(
          "If AT-SPI does not answer once a window is open, the next check says how to turn it on.",
        ),
      ],
    };
  // AT-SPI answered, yet app controls are unavailable: the driver will not list windows for
  // agents on this desktop (#1610). Turning accessibility on would change nothing.
  if (readiness.grants.accessibility === "granted")
    return {
      id: "accessibility",
      status: "unavailable",
      title: "App controls",
      detail:
        "Cua Driver cannot read this Wayland desktop's screen layout, so agents cannot list or use windows here.",
      guidance: [text("Use an X11 or XWayland session.")],
    };
  return {
    id: "accessibility",
    status: "action",
    title: "Turn on accessibility support",
    detail:
      "GOAT reads app controls through AT-SPI, the Linux accessibility service, and it is not answering in this session.",
    guidance: [
      text(
        "On GNOME, turn on any assistive technology in Settings → Accessibility, or turn on the toolkit accessibility setting:",
      ),
      command("gsettings set org.gnome.desktop.interface toolkit-accessibility true"),
      text("Apps that were already open read this at start, so restart them afterwards."),
      text("If AT-SPI is not installed, install at-spi2-core from your distribution."),
    ],
  };
}

const CONSENT_DETAIL: Partial<Record<ComputerUseGrant, string>> = {
  denied:
    "Screen sharing for GOAT Computer Use was declined. GOAT asks again the next time it checks; choose the screen and allow it.",
  abandoned:
    "The screen sharing dialog closed without an answer. GOAT asks again the next time it checks.",
};

function captureStep(readiness: ComputerUseReadiness): ComputerUseSetupStep {
  const wayland = readiness.platform?.linux?.displayServer === "wayland";
  const consent = readiness.grants.screenCapture;
  if (readiness.capture === "ready")
    return {
      id: "capture",
      status: "done",
      title: "Screen capture",
      detail: "GOAT captured a window and saw real content.",
      guidance: [],
    };
  if (wayland && (consent === "denied" || consent === "abandoned"))
    return {
      id: "capture",
      status: "action",
      title: "Allow screen sharing",
      detail: CONSENT_DETAIL[consent] ?? "",
      guidance: [],
    };
  if (readiness.capture === "pending")
    return {
      id: "capture",
      status: "waiting",
      title: "Screen sharing",
      // The helper reports pending both while consent is unanswered and when the compositor
      // cannot capture one window, so neither is promised.
      detail:
        "GOAT has not captured a window yet. On Wayland your desktop asks before any app can see the screen, and some desktops cannot show GOAT a single window at all.",
      guidance: [
        text(
          "If a sharing dialog for GOAT Computer Use is open at that machine, choose the screen or window GOAT should see and allow it. If the dialog offers to remember the choice, keep it on so it does not ask every time.",
        ),
        text(
          "If no dialog appears, this desktop may not support capturing one window." +
            (readiness.tree === "ready" ? " GOAT can still read and use app controls." : ""),
        ),
      ],
    };
  if (readiness.capture === "noWindow")
    return {
      id: "capture",
      status: "waiting",
      title: "Screen capture",
      detail: "There is no open window to check capture with. Open any app window.",
      guidance: [],
    };
  if (readiness.capture === "blank")
    return {
      id: "capture",
      status: "action",
      title: "Screen capture is blank",
      detail:
        "A window capture came back as one solid color. The screen may be locked or turned off, or the desktop may hide windows from capture.",
      guidance: [text("Unlock the screen and keep the app window visible, then check again.")],
    };
  return {
    id: "capture",
    status: "unavailable",
    title: "Screen capture",
    detail: wayland
      ? "This Wayland desktop cannot show GOAT a single window." +
        (readiness.tree === "ready" ? " GOAT can still read and use app controls." : "")
      : "GOAT could not capture a window on this desktop.",
    guidance: [],
  };
}

function inputStep(readiness: ComputerUseReadiness): ComputerUseSetupStep | undefined {
  if (readiness.input === "unavailable") return undefined;
  if (readiness.input === "background")
    return {
      id: "input",
      status: "done",
      title: "Input",
      detail: "GOAT can type and click in a window without bringing it to the front.",
      guidance: [],
    };
  const wayland = readiness.platform?.linux?.displayServer === "wayland";
  // AT-SPI answered but the driver will not list windows for agents (#1610): no control works,
  // in the background or in front.
  const controls = !(
    readiness.tree === "unavailable" && readiness.grants.accessibility === "granted"
  );
  return {
    id: "input",
    status: "limited",
    title: "Typing and pointing need the window in front",
    detail:
      (controls ? "GOAT presses buttons and fills fields in the background through AT-SPI. " : "") +
      "Typing keys and clicking at a point bring the window to the front, which a computer use approval has to allow.",
    guidance: wayland
      ? [
          text(
            "Wayland does not let apps send input to a window behind others; this cannot be changed.",
          ),
        ]
      : [
          text(
            "Background typing on X11 needs write access to /dev/uinput, which lets every program you run create input devices. Leave it off unless you need it.",
          ),
        ],
  };
}

function helperStep(
  readiness: ComputerUseReadiness,
  machine: string,
): ComputerUseSetupStep | undefined {
  if (readiness.helper === "authenticated") return undefined;
  if (readiness.helper === "incompatible")
    return {
      id: "helper",
      status: "action",
      title: "Update GOAT",
      detail:
        "This GOAT and its computer use helper speak different versions. Update GOAT on that machine.",
      guidance: [],
    };
  // The server reports an unconfirmed helper when it stops answering, with that as the reason.
  return {
    id: "helper",
    status: "action",
    title: "Computer use helper",
    detail: readiness.reasons[0] ?? "GOAT could not confirm its computer use helper.",
    guidance: [
      text(
        "GOAT checks the helper again shortly. If this stays, restart GOAT on " +
          machine +
          "; if it still fails, reinstall or update GOAT there.",
      ),
    ],
  };
}

const BLOCKERS: Record<ComputerUseReadiness["blockers"][number], string> = {
  screenLocked: "The screen is locked. Unlock it to let the agent continue.",
  noInteractiveDesktop: "GOAT runs outside a desktop session here, so there is no screen to use.",
  otherUserAtConsole: "Another user is signed in at this computer's screen.",
  restartRequired: "A permission changed. Restart GOAT so its helper sees it.",
};

/** The setup steps for a Linux machine's readiness, in the order a person works through them. */
export function linuxComputerUseSetup(
  readiness: ComputerUseReadiness,
  machine: string,
): ComputerUseSetup {
  const steps: ComputerUseSetupStep[] = [];
  // Without a confirmed helper nothing below was checked, so it is not judged.
  const helper = helperStep(readiness, machine);
  if (helper) steps.push(helper);
  else {
    const session = sessionStep(readiness, machine);
    steps.push(session);
    // Without a session there is nothing for the other steps to talk about.
    if (session.status === "done") {
      steps.push(accessibilityStep(readiness), captureStep(readiness));
      const input = inputStep(readiness);
      if (input) steps.push(input);
    }
  }
  for (const blocker of readiness.blockers)
    steps.push({
      id: "blocker",
      status: "action",
      title: "Paused",
      detail: BLOCKERS[blocker],
      guidance: [],
    });
  return { ready: computerUseReady(readiness), steps };
}
