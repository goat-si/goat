/**
 * What the lease proxy tells the agent when it refuses, ends or cuts off a call, and the tools it
 * treats as read-only. Kept apart from the proxy's control flow (ComputerUseLeaseProxy.ts).
 *
 * @module ComputerUseLeaseMessages
 */
import type {
  ComputerUseControlEnd,
  ComputerUsePauseReason,
  ComputerUseRefusalDetail,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

export type LeaseEnd = ComputerUseControlEnd | "lost" | "helper_restarted" | "wrong_display";

const REQUEST = goatCallText("computer_use.request");

export const FOREGROUND_NOT_APPROVED = `This call can take foreground control and did not run. Ask with ${REQUEST} and args {purpose, foreground:true}, without apps, then end your turn. Pause or Stop requires new foreground approval.`;

export const DESKTOP_CAPTURE_OFF =
  "Screenshots of the whole display are off in GOAT: they would show every other app on this screen. Look at one window with get_window_state and that window's pid and window_id.";

export const SCREEN_SHARED =
  "Another thread is using other apps on this screen, so a script, a batch or a call that brings a window forward, moves the pointer or sends foreground input did not run: it would take the screen from that thread. Make single calls that act on this window in the background or through an element, or end your turn and ask the person.";

/**
 * Why the server would not reserve a call (#1462): another thread's window reservation, a screen
 * another thread shares, or no reservation at all.
 */
export const reservationRefusal = (detail: string, holder: string | undefined) =>
  detail === "screen_shared"
    ? SCREEN_SHARED
    : holder === undefined
      ? "GOAT could not reserve this call under the current control, so it did not run. Observe again after the control is available."
      : `Thread ${holder} is using this target. This call did not run; wait for that thread to finish, then observe again.`;

export const LEASE_END_MESSAGES: Readonly<Record<LeaseEnd, string>> = {
  expired: `Computer use for this thread reached its time limit. A later turn gets it back while the thread is still admitted; otherwise ask again with ${REQUEST}.`,
  revoked: "A person ended computer use for this thread.",
  replaced: "A newer turn of this thread took over computer use; this connection is closed.",
  disabled: "Computer use was turned off on this host.",
  unauthorized:
    "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
  stopped: "A person pressed Stop on this thread. Do not continue on the screen in this turn.",
  stopped_all: "A person stopped computer use for every thread on this host.",
  lost: "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
  helper_restarted:
    "GOAT Computer Use or its driver stopped or restarted (for example after an update), so computer use for this thread ended. A call already in progress may have acted before it stopped. Do not retry; end your turn and tell the person that computer use stopped, and that Restart agent session brings it back.",
  // The driver answered about another display than the one GOAT gave it (#1358).
  wrong_display:
    "The computer use driver answered about windows that are not on the screen GOAT gave it, so nothing it says or does can be trusted. Computer use stopped for this thread.",
};

export const PAUSE_STATE: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: "A person is using this computer, so computer use is paused",
  takeover: "A person took over the screen, so computer use is paused",
  private: "A password or other secret field has focus on this computer, so computer use is paused",
};

export const PAUSE_NEXT: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  takeover:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  private: "Do not retry now; observe the screen again after the person leaves it.",
};

const pauseMessage = (reason: ComputerUsePauseReason) =>
  `${PAUSE_STATE[reason]} and your call did not run. ${PAUSE_NEXT[reason]}`;

export const PAUSE_MESSAGES: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: pauseMessage("human_input"),
  takeover: pauseMessage("takeover"),
  private: pauseMessage("private"),
};

/**
 * Tools that only read. One the driver already had when a pause or Stop cut it off changed
 * nothing on the screen; any other tool, a script or batch included, may have acted.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_window_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
]);

export const MAY_HAVE_ACTED =
  "This call was already with the driver when it was cut off, so it may already have acted. Never resend it unchanged, and observe the window before any later action.";
export const READ_CUT_OFF =
  "This read was cut off before it answered and changed nothing; read again before acting.";

/** Why a cut-off call ended, worded without claiming it did not run. */
export type Interruption =
  | { readonly _tag: "end"; readonly reason: LeaseEnd }
  | { readonly _tag: "pause"; readonly reason: ComputerUsePauseReason }
  | { readonly _tag: "other"; readonly detail: ComputerUseRefusalDetail; readonly message: string };

export const scopeMessage = (
  reason: "app_not_approved" | "desktop_not_approved",
  app?: string,
  opaque?: boolean,
  launch?: "bundle_id" | "unverifiable",
) =>
  launch === "bundle_id"
    ? "Launch an approved app by its bundle_id alone, as list_apps reports it; a name can open another app than the one approved, so the call did not run."
    : launch === "unverifiable"
      ? "On this computer the driver may open another app than the name, path or URL given, so a thread limited to approved apps cannot launch apps here and the call did not run. Work in an approved app's window that is already open, or ask the person to open the app."
      : reason === "app_not_approved"
        ? `${app ?? "This app"} is not approved for this thread, so the call did not run. Ask with ${REQUEST} and args {purpose, apps:[${JSON.stringify(app ?? "<bundle_id from list_apps>")}]}, then end your turn.`
        : opaque
          ? "This thread may control only its approved apps, and a script or batch cannot be checked against them, so it did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window."
          : `This call would act on the whole desktop, and this thread may control only its approved apps, so it did not run. Target an approved app's window with its pid and window_id, or ask for the whole screen with ${REQUEST} without apps.`;
