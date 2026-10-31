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

export type LeaseEnd =
  | ComputerUseControlEnd
  | "lost"
  | "transport_lost"
  | "helper_restarted"
  | "helper_refused"
  | "helper_unsupported"
  | "wrong_display";

const REQUEST = goatCallText("computer_use.request");

export const FOREGROUND_NOT_APPROVED = `This call can take foreground control and did not run. Ask with ${REQUEST} and args {purpose, foreground:true}, without apps; the request waits for the person's answer in this turn. A full-access thread needs no request except after a pause or Stop in this turn; automatic foreground authority returns only next turn. Respect the pause or Stop.`;

export const DESKTOP_CAPTURE_OFF =
  "Screenshots of the whole display are off in GOAT: they would show every other app on this screen. Look at one window with get_window_state and that window's pid and window_id.";

export const WRONG_DISPLAY =
  "That window is not on the screen GOAT gave computer use, so the call did not run. Use a window from list_windows.";

export const REQUEST_ID_BUSY =
  "This request id still has work in progress. Use a new request id after observing its result.";
/** A screen call still waiting in GOAT, often behind slow checks on a loaded host. */
export const SCREEN_CALL_EXPIRED =
  "This screen call was still waiting in GOAT when its cell stopped waiting for it, often because this computer is busy, so nothing was sent. Try it again.";
export const SCREEN_SHARED =
  "Another thread is using other apps on this screen, so a script, a batch or a call that brings a window forward, moves the pointer or sends foreground input did not run: it would take the screen from that thread. Make single calls that act on this window in the background or through an element, or end your turn and ask the person.";

/**
 * Why the server would not reserve a call (#1462): another thread's window reservation, a screen
 * another thread shares, or no reservation at all.
 */
const POINTER_LOCKED =
  "This computer keeps the person's pointer still, so a call that moves it (foreground pointer delivery or a desktop move_cursor) did not run. Use the element_token, the keyboard, or a background click (the virtual cursor). If the app ignores background clicks, tell the person instead of retrying.";

const BROWSER_CLAIM_GONE =
  "This browser call has no live claim on the server, often because the person ended or revoked it, so the call did not run. Ask for the tab again with goat_browser_claim_request if you still need it.";

/** The server did not answer an admission in time (a loaded host stalls) or could not judge it. */
const ADMISSION_UNANSWERED =
  "GOAT did not answer in time whether this call may run, often because this computer is under heavy load, so the call did not run and nothing was sent. Try it again in a few seconds, and observe first if the screen may have changed.";

export const reservationRefusal = (
  detail: string,
  holder: string | undefined,
  app?: string | undefined,
) =>
  detail === "pointer_locked"
    ? POINTER_LOCKED
    : detail === "outside_manifest"
      ? BROWSER_CLAIM_GONE
      : detail === "screen_shared"
        ? SCREEN_SHARED
        : detail === "reconnecting"
          ? ADMISSION_UNANSWERED
          : detail === "unauthorized"
            ? LEASE_END_MESSAGES.unauthorized
            : detail === "app_busy"
              ? `Thread ${holder ?? "another thread"} is using ${app ?? "an app this call could reach"}. This call did not run. Work in another app, or wait and observe again before retrying.`
              : holder === undefined
                ? "GOAT could not reserve this call under the current control, so it did not run. Observe again after the control is available."
                : `Thread ${holder} is using this target. This call did not run; wait for that thread to finish, then observe again.`;

export const LEASE_END_MESSAGES: Readonly<Record<LeaseEnd, string>> = {
  expired: `Computer use for this thread reached its time limit. A later turn gets it back while the thread is still admitted; otherwise ask again with ${REQUEST}.`,
  revoked: "A person ended computer use for this thread.",
  replaced:
    "A newer control of this thread took over computer use. Computer use is not available for this turn; a new approval or turn restores it.",
  disabled: "Computer use was turned off on this host.",
  unauthorized:
    "GOAT no longer accepts this agent session for computer use (the session ended, or GOAT restarted or updated), so computer use stopped. Do not retry; tell the person that Restart agent session brings it back.",
  stopped: "A person pressed Stop on this thread. Do not continue on the screen in this turn.",
  stopped_all: "A person stopped computer use for every thread on this host.",
  lost: "Computer use for this control ended because its connection to GOAT ended. A later turn or approval restores it.",
  transport_lost:
    "Computer use could not reach GOAT for two minutes, so this thread's control ended and this call did not run. It reconnects by itself; once GOAT answers, a later turn or approval restores control.",
  helper_restarted:
    "GOAT Computer Use or its driver stopped or restarted (for example after an update), so computer use for this thread ended. A call already in progress may have acted before it stopped. Do not retry; end your turn and tell the person that computer use stopped, and that Restart agent session brings it back.",
  // The helper exited 77: its parent check refused the process that started it.
  helper_refused:
    "GOAT Computer Use refused to start for this connection because it did not trust the process that launched it, so computer use is unavailable here. Nothing ran. Restarting the agent session will not fix it. Do not retry; end your turn and tell the person that GOAT Computer Use refused this GOAT's connection and GOAT needs an update.",
  // The helper exited 64, 78 or 79: it could not start its service or driver on this Mac.
  helper_unsupported:
    "GOAT Computer Use could not start on this Mac (its service or bundled driver failed to start), so computer use is unavailable here. Nothing ran. Restarting the agent session will not fix it. Do not retry; end your turn and tell the person that GOAT Computer Use failed to start and GOAT needs an update or reinstall.",
  // The driver answered about another display than the one GOAT gave it (#1358).
  wrong_display:
    "The computer use driver answered about windows that are not on the screen GOAT gave it, so nothing it says or does can be trusted. Computer use stopped for this thread.",
};

export const PAUSE_STATE: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: "A person is using this computer, so computer use is paused",
  takeover: "A person took over the screen, so computer use is paused",
  private: "A password or other secret field has focus on this computer, so computer use is paused",
  screen_locked: "The screen is locked, so computer use is paused",
};

export const PAUSE_NEXT: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  takeover:
    "Do not retry now: end your turn or wait for them to hand control back, then observe the screen again before acting.",
  private: "Do not retry now; observe the screen again after the person leaves it.",
  screen_locked: "Do not retry; wait for the person to unlock the screen and hand control back.",
};

const pauseMessage = (reason: ComputerUsePauseReason) =>
  `${PAUSE_STATE[reason]} and your call did not run. ${PAUSE_NEXT[reason]}`;

export const PAUSE_MESSAGES: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: pauseMessage("human_input"),
  takeover: pauseMessage("takeover"),
  private: pauseMessage("private"),
  screen_locked: pauseMessage("screen_locked"),
};

export const RECONNECTING =
  "Computer use lost its connection to GOAT for a moment and is reconnecting, so this call did not run and nothing was sent. Try again in a few seconds, and observe the screen again before acting once it is back.";
export const RECONNECT_CUT_OFF =
  "Computer use lost its connection to GOAT, so work in progress was stopped. Observe again once it is back.";

export const TURN_ENDED: Interruption = {
  _tag: "other",
  detail: "control_idle",
  message: "This thread's turn has ended. Computer use is idle until its next turn.",
};

/** A window GOAT used turned private or a person took it over; the proxy replaced its driver. */
export const targetClosedInterruption = (reason: "private" | "takeover"): Interruption => ({
  _tag: "other",
  detail: "helper_restarted",
  message:
    reason === "private"
      ? "A window GOAT was using became private, so GOAT is restarting its driver. Observe again before acting."
      : "A person took over a window GOAT was using, so GOAT is restarting its driver. Observe again before acting.",
});

/**
 * Reads allowed while the lease stream reconnects. None shows window content or pixels: a Stop,
 * pause or private field that happened meanwhile cannot reach the proxy until it reconnects.
 */
export const TRANSPORT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "get_config",
  "get_screen_size",
  "get_cursor_position",
  "get_agent_cursor_state",
  "get_session",
  "list_sessions",
]);

/**
 * Tools that only read. One the driver already had when a pause or Stop cut it off changed
 * nothing on the screen; any other tool, a script or batch included, may have acted.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "list_menu_bar_extras",
  "get_accessibility_tree",
  "get_window_state",
  "wait_for_window_settle",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
  "get_config",
]);

/**
 * menu_bar_extras shares one tool between reads and presses: system finds SystemUIServer and
 * list names status items, while open, click and close press them.
 */
export const readsMenuBarExtras = (tool: unknown, args: unknown): boolean => {
  if (tool !== "menu_bar_extras" || typeof args !== "object" || args === null) return false;
  const operation = (args as Record<string, unknown>).operation;
  return operation === "system" || operation === "list";
};

/** Whether one call only reads, judged by its tool and, for menu_bar_extras, its operation. */
export const isReadOnlyCall = (tool: unknown, args?: unknown): boolean =>
  (typeof tool === "string" && READ_ONLY_TOOLS.has(tool)) || readsMenuBarExtras(tool, args);

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
        ? `${app ?? "This app"} is not approved for this thread, so the call did not run. Ask with ${REQUEST} and args {purpose, apps:[${JSON.stringify(app ?? "<bundle_id from list_apps>")}]}. It waits for the person's answer, and once approved this turn can go on.`
        : opaque
          ? "This thread may control only its approved apps, and this script or batch is not kept to them by an app_scope of approved apps, so it did not run. Name only approved apps in app_scope, or make the calls one at a time, each with the pid and window_id of an approved app's window."
          : `This call would act on the whole desktop, and this thread may control only its approved apps, so it did not run. Target an approved app's window with its pid and window_id, or ask for the whole screen with ${REQUEST} without apps.`;
