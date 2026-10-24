// @effect-diagnostics preferSchemaOverJson:off -- Constructs raw MCP JSON-RPC response lines.
import {
  type ComputerUseControlEnd,
  type ComputerUsePauseReason,
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

export type JsonRpcId = string | number;

export type LeaseEnd = ComputerUseControlEnd | "lost" | "helper_restarted" | "wrong_display";

const REQUEST = goatCallText("computer_use.request");

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

const PAUSE_STATE: Readonly<Record<ComputerUsePauseReason, string>> = {
  human_input: "A person is using this computer, so computer use is paused",
  takeover: "A person took over the screen, so computer use is paused",
  private: "A password or other secret field has focus on this computer, so computer use is paused",
};

const PAUSE_NEXT: Readonly<Record<ComputerUsePauseReason, string>> = {
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
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
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

export const UNCONFIRMED_DISPLAY =
  "GOAT could not confirm that computer use is on the screen GOAT gave it, so this did not run. Call list_windows, then try again.";
/** For a call that reached the driver: its answer is withheld, but it may have acted. */
const REPLY_WITHHELD =
  "This call reached the driver, so it may already have acted, but GOAT could not confirm its answer is about the screen GOAT gave it and withheld it. Never resend it unchanged.";
const REPLY_UNCONFIRMED = `${REPLY_WITHHELD} Call list_windows and observe the window before any later action.`;

export const refusal = (
  id: JsonRpcId,
  method: string | undefined,
  detail: ComputerUseRefusalDetail,
  message: string,
  app?: string,
  holderThreadId?: import("@goat/contracts").ThreadId,
) => {
  const refused = { refused: computerUseRefusalReason(detail), detail };
  return JSON.stringify(
    method === "tools/call"
      ? {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            structuredContent: {
              ...refused,
              ...(app === undefined ? {} : { app }),
              ...(holderThreadId === undefined ? {} : { holderThreadId }),
            },
            isError: true,
          },
        }
      : { jsonrpc: "2.0", id, error: { code: -32000, message, data: refused } },
  );
};

export const pausedDetail = (reason: ComputerUsePauseReason): ComputerUseRefusalDetail =>
  reason === "private" ? "private_mode" : "waiting_for_human";

export const interruptionDetail = (cause: Interruption): ComputerUseRefusalDetail =>
  cause._tag === "end"
    ? cause.reason
    : cause._tag === "pause"
      ? pausedDetail(cause.reason)
      : cause.detail;

/** What a call that never reached the driver is told: it did not run. */
export const interruptionRefusal = (cause: Interruption) =>
  cause._tag === "end"
    ? LEASE_END_MESSAGES[cause.reason]
    : cause._tag === "pause"
      ? PAUSE_MESSAGES[cause.reason]
      : cause.message;

/**
 * The answer for a call the driver already had when a pause or end cut it off. The driver may
 * have dispatched its input before its transport was killed, so this is not a refusal: an agent
 * told "did not run" resends, and a resent keystroke can submit twice.
 */
export const cutOff = (id: JsonRpcId, tool: string | undefined, cause: Interruption) => {
  const read = tool !== undefined && READ_ONLY_TOOLS.has(tool);
  const sentence = read ? READ_CUT_OFF : MAY_HAVE_ACTED;
  const detail = interruptionDetail(cause);
  const text =
    cause._tag === "pause"
      ? `${PAUSE_STATE[cause.reason]}. ${sentence} ${PAUSE_NEXT[cause.reason]}`
      : cause._tag === "end"
        ? `${sentence} ${LEASE_END_MESSAGES[cause.reason]}`
        : `${cause.message} ${sentence}`;
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      structuredContent: read
        ? { code: "interrupted", detail }
        : { effect: "unverifiable", code: "interrupted", detail },
      isError: true,
    },
  });
};

/**
 * The answer for a call whose reply names windows GOAT cannot place on its screen. The driver
 * already acted on it, so only a read keeps the refusal; anything else may have landed.
 */
export const offScreenAnswer = (
  id: JsonRpcId,
  method: string,
  tool: string | undefined,
  verdict: "other" | "unknown",
) =>
  tool !== undefined && READ_ONLY_TOOLS.has(tool)
    ? refusal(
        id,
        method,
        "wrong_display",
        verdict === "other" ? LEASE_END_MESSAGES.wrong_display : UNCONFIRMED_DISPLAY,
      )
    : JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                verdict === "other"
                  ? `${REPLY_WITHHELD} ${LEASE_END_MESSAGES.wrong_display}`
                  : REPLY_UNCONFIRMED,
            },
          ],
          structuredContent: {
            effect: "unverifiable",
            code: "interrupted",
            detail: "wrong_display",
          },
          isError: true,
        },
      });
