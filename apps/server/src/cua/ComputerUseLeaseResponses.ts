// @effect-diagnostics preferSchemaOverJson:off -- Constructs raw MCP JSON-RPC response lines.
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import {
  type ActionOutcomeSafety,
  type ComputerUsePauseReason,
  type ComputerUseRefusalDetail,
  computerUseRefusalReason,
} from "@goat/contracts";
import {
  type Interruption,
  type LeaseEnd,
  FOREGROUND_NOT_APPROVED,
  LEASE_END_MESSAGES,
  RECONNECTING,
  SCREEN_SHARED,
  PAUSE_STATE,
  PAUSE_NEXT,
  PAUSE_MESSAGES,
  isReadOnlyCall,
  MAY_HAVE_ACTED,
  READ_CUT_OFF,
} from "./ComputerUseLeaseMessages.ts";

import { refusalSafety } from "./ComputerUseDriverOutcome.ts";
import { replaceWithTerminal, type ComputerUseTerminalState } from "./ComputerUseTerminal.ts";
import type { Stopping } from "./leaseUpdateFences.ts";

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
  replaced: ComputerUseTerminalState | "none",
  id: JsonRpcId,
  method: string | undefined,
  detail: ComputerUseRefusalDetail,
  message: string,
  app?: string,
  holderThreadId?: import("@goat/contracts").ThreadId,
  call?: { readonly tool?: string | undefined; readonly args?: unknown },
) => {
  const incoming =
    detail === "screen_locked"
      ? "screen_locked"
      : detail === "stopped" || detail === "stopped_all"
        ? "stopped_by_person"
        : undefined;
  const merged = replaceWithTerminal(replaced, incoming);
  if (merged.reason !== undefined && merged.possibleCommit) {
    const cause: Interruption =
      merged.reason === "screen_locked"
        ? { _tag: "pause", reason: "screen_locked" }
        : { _tag: "end", reason: "stopped" };
    return cutOff(id, call?.tool, cause, call?.args, merged);
  }
  if (merged.reason === "stopped_by_person" && incoming !== "stopped_by_person") {
    detail = "stopped";
    message = LEASE_END_MESSAGES.stopped;
  }
  if (merged.reason === "screen_locked" && incoming !== "screen_locked") {
    detail = "screen_locked";
    message = PAUSE_MESSAGES.screen_locked;
  }
  const refused = {
    refused: computerUseRefusalReason(detail),
    detail,
    ...(detail === "screen_locked"
      ? { code: "screen_locked" }
      : detail === "stopped" || detail === "stopped_all"
        ? { code: "stopped_by_person" }
        : {}),
    safety: refusalSafety(detail, call?.tool, call?.args),
  };
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

export const terminalReplacement = (
  id: JsonRpcId,
  tool: string | undefined,
  args: unknown,
  replaced: ComputerUseTerminalState,
  dispatched: boolean,
) => {
  const state = replaceWithTerminal(replaced);
  if (state.reason === undefined)
    throw new Error("A terminal replacement requires a terminal reason.");
  const cause: Interruption =
    state.reason === "screen_locked"
      ? { _tag: "pause", reason: "screen_locked" }
      : { _tag: "end", reason: "stopped" };
  return dispatched || state.possibleCommit
    ? cutOff(id, tool, cause, args, state)
    : refusal(
        state,
        id,
        "tools/call",
        state.reason === "screen_locked" ? "screen_locked" : "stopped",
        state.reason === "screen_locked"
          ? PAUSE_MESSAGES.screen_locked
          : LEASE_END_MESSAGES.stopped,
      );
};

export const pausedDetail = (reason: ComputerUsePauseReason): ComputerUseRefusalDetail =>
  reason === "private"
    ? "private_mode"
    : reason === "screen_locked"
      ? "screen_locked"
      : "waiting_for_human";

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
export const cutOff = (
  id: JsonRpcId,
  tool: string | undefined,
  originalCause: Interruption,
  args: unknown,
  replaced: ComputerUseTerminalState | "none",
) => {
  const state = replaceWithTerminal(replaced);
  const reason = replaceWithTerminal(
    state,
    originalCause._tag === "pause" && originalCause.reason === "screen_locked"
      ? "screen_locked"
      : originalCause._tag === "end" &&
          (originalCause.reason === "stopped" || originalCause.reason === "stopped_all")
        ? "stopped_by_person"
        : undefined,
  ).reason;
  const cause: Interruption =
    reason === "stopped_by_person" &&
    !(
      originalCause._tag === "end" &&
      (originalCause.reason === "stopped" || originalCause.reason === "stopped_all")
    )
      ? { _tag: "end", reason: "stopped" }
      : reason === "screen_locked" &&
          !(originalCause._tag === "pause" && originalCause.reason === "screen_locked")
        ? { _tag: "pause", reason: "screen_locked" }
        : originalCause;
  const read = !state.possibleCommit && isReadOnlyCall(tool, args);
  const outcomeSafety = classifyActionOutcome({
    effect: read ? "read" : "write",
    status: "indeterminate",
    dispatched: true,
  });
  const safety: ActionOutcomeSafety =
    (cause._tag === "end" && (cause.reason === "stopped" || cause.reason === "stopped_all")) ||
    (cause._tag === "pause" && cause.reason === "screen_locked")
      ? { ...outcomeSafety, retryClass: "never" }
      : outcomeSafety;
  const sentence = read ? READ_CUT_OFF : MAY_HAVE_ACTED;
  const detail = interruptionDetail(cause);
  const code =
    detail === "screen_locked"
      ? "screen_locked"
      : detail === "stopped" || detail === "stopped_all"
        ? "stopped_by_person"
        : "interrupted";
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
        ? {
            code,
            detail,
            safety,
          }
        : {
            effect: "unverifiable",
            code,
            detail,
            safety,
          },
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
  args: unknown,
  replaced: ComputerUseTerminalState,
) => {
  const terminal = replaceWithTerminal(replaced);
  if (terminal.reason !== undefined) return terminalReplacement(id, tool, args, terminal, true);
  return isReadOnlyCall(tool, args)
    ? refusal(
        replaced,
        id,
        method,
        "wrong_display",
        verdict === "other" ? LEASE_END_MESSAGES.wrong_display : UNCONFIRMED_DISPLAY,
        undefined,
        undefined,
        { tool, args },
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
            safety: classifyActionOutcome({
              effect: "write",
              status: "indeterminate",
              dispatched: true,
            }),
          },
          isError: true,
        },
      });
};

/** Receipt-time restrictions outrank the last applied state when a call has not run. */
export const unsentCallRefusal = (
  id: JsonRpcId,
  method: string | undefined,
  state: {
    /** The lease stream is reconnecting and this call is no transport-safe read. */
    readonly held?: boolean;
    readonly pending: Stopping | undefined;
    readonly finished: LeaseEnd | undefined;
    readonly paused: ComputerUsePauseReason | undefined;
    readonly idle: boolean;
    readonly foregroundRevoked: boolean;
    readonly lastInterruption: Interruption;
  },
) => {
  const { pending, lastInterruption } = state;
  const ending =
    state.finished ?? (pending !== undefined && "end" in pending ? pending.end : undefined);
  const pausing =
    state.paused ?? (pending !== undefined && "pause" in pending ? pending.pause : undefined);
  if (ending !== undefined) return refusal("none", id, method, ending, LEASE_END_MESSAGES[ending]);
  if (pausing !== undefined)
    return refusal("none", id, method, pausedDetail(pausing), PAUSE_MESSAGES[pausing]);
  if (state.idle || (pending !== undefined && "idle" in pending))
    return refusal(
      "none",
      id,
      method,
      "control_idle",
      "This thread's turn has ended. Computer use is idle until its next turn.",
    );
  if (state.held === true) return refusal("none", id, method, "reconnecting", RECONNECTING);
  if (pending !== undefined && "narrowed" in pending)
    return refusal(
      "none",
      id,
      method,
      "app_not_approved",
      "The apps this thread may control changed while this call waited, so it did not run. Observe again, then act only on an app that is still approved.",
    );
  if (state.foregroundRevoked)
    return refusal("none", id, method, "foreground_not_approved", FOREGROUND_NOT_APPROVED);
  return refusal(
    "none",
    id,
    method,
    interruptionDetail(lastInterruption),
    // The cause reads the same for a call the driver already had; this one never reached it.
    lastInterruption._tag === "other"
      ? `${interruptionRefusal(lastInterruption)} Nothing was sent.`
      : interruptionRefusal(lastInterruption),
  );
};

export const unsentOutcome = (
  outcome: "shared" | "expired" | "stale",
  id: JsonRpcId,
  method: string | undefined,
  notSent: () => string,
) =>
  outcome === "shared"
    ? refusal("none", id, method, "screen_shared", SCREEN_SHARED)
    : outcome === "expired"
      ? refusal(
          "none",
          id,
          method,
          "expired",
          "This call’s permission expired before dispatch, so it did not run. Observe the current approval before trying again.",
        )
      : notSent();
