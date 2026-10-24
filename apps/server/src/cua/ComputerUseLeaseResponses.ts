// @effect-diagnostics preferSchemaOverJson:off -- Constructs raw MCP JSON-RPC response lines.
import {
  type ComputerUsePauseReason,
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
} from "@goat/contracts";
import {
  type Interruption,
  LEASE_END_MESSAGES,
  PAUSE_STATE,
  PAUSE_NEXT,
  PAUSE_MESSAGES,
  READ_ONLY_TOOLS,
  MAY_HAVE_ACTED,
  READ_CUT_OFF,
} from "./ComputerUseLeaseMessages.ts";

export type JsonRpcId = string | number;

export const UNCONFIRMED_DISPLAY =
  "GOAT could not confirm that computer use is on the screen GOAT gave it, so this did not run. Call list_windows, then try again.";
/** For a call that reached the driver: its answer is withheld, but it may have acted. */
const REPLY_WITHHELD =
  "This call reached the driver, so it may already have acted, but GOAT could not confirm its answer is about the screen GOAT gave it and withheld it. Never resend it unchanged.";
const REPLY_UNCONFIRMED = `${REPLY_WITHHELD} Call list_windows and observe the window before any later action.`;

/** The answer to a provider request under an id the proxy keeps for its own requests. */
export const reservedIdAnswer = (id: string, prefix: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32600, message: `Request ids starting with ${prefix} are reserved.` },
  });

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
