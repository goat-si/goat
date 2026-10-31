import * as Schema from "effect/Schema";
import type { ActionOutcomeSafety, ScreenRunError } from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import {
  isReadOnlyCall,
  LEASE_END_MESSAGES,
  PAUSE_MESSAGES,
  MAY_HAVE_ACTED,
  PAUSE_STATE,
  PAUSE_NEXT,
} from "./ComputerUseLeaseMessages.ts";
import { refusalSafety } from "./ComputerUseDriverOutcome.ts";

export type ComputerUseTerminalReason = "stopped_by_person" | "screen_locked";

export const mergeTerminal = (
  first: {
    readonly reason?: ComputerUseTerminalReason | undefined;
    readonly possibleCommit?: boolean | undefined;
  },
  second: {
    readonly reason?: ComputerUseTerminalReason | undefined;
    readonly possibleCommit?: boolean | undefined;
  },
) => {
  // A person's Stop outranks a lock because it forbids retrying the turn; possible input only accumulates.
  const reason: ComputerUseTerminalReason | undefined =
    first.reason === "stopped_by_person" || second.reason === "stopped_by_person"
      ? "stopped_by_person"
      : (first.reason ?? second.reason);
  return {
    ...(reason === undefined ? {} : { reason }),
    possibleCommit: first.possibleCommit === true || second.possibleCommit === true,
  };
};

export type ComputerUseTerminalState = {
  readonly reason?: ComputerUseTerminalReason | undefined;
  readonly possibleCommit: boolean;
};

export const replaceWithTerminal = (
  replaced:
    | "none"
    | string
    | {
        readonly reason?: ComputerUseTerminalReason | undefined;
        readonly possibleCommit?: boolean | undefined;
      }
    | undefined,
  ...sources: readonly (
    | string
    | {
        readonly reason?: ComputerUseTerminalReason | undefined;
        readonly possibleCommit?: boolean | undefined;
      }
    | undefined
  )[]
): ComputerUseTerminalState => {
  const stateOf = (source: typeof replaced) =>
    typeof source === "string"
      ? {
          reason: source === "stopped_by_person" || source === "screen_locked" ? source : undefined,
        }
      : (source ?? {});
  return sources.reduce<ComputerUseTerminalState>(
    (state, source) => mergeTerminal(state, stateOf(source)),
    mergeTerminal(stateOf(replaced), {}),
  );
};

export const terminalState = (reason: unknown, possibleCommit: boolean): ComputerUseTerminalState =>
  mergeTerminal(
    {
      reason: reason === "stopped_by_person" || reason === "screen_locked" ? reason : undefined,
      possibleCommit,
    },
    {},
  );

export const terminalFailure = (
  state: ComputerUseTerminalState,
  tool: string,
  args: unknown,
  dispatched = false,
): ScreenRunError | undefined => {
  const reason = state.reason;
  if (reason === undefined) return undefined;
  const mayHaveInput = state.possibleCommit;
  dispatched = dispatched || mayHaveInput;
  const read = !mayHaveInput && isReadOnlyCall(tool, args);
  const safety: ActionOutcomeSafety = dispatched
    ? {
        ...classifyActionOutcome({
          effect: read ? "read" : "write",
          status: "indeterminate",
          dispatched: true,
        }),
        retryClass: "never",
      }
    : refusalSafety(reason === "screen_locked" ? "screen_locked" : "stopped", tool, args);
  return {
    code: reason,
    effectStarted: safety.possibleCommit,
    nextStep: dispatched
      ? `${read ? "This read was interrupted before it answered." : MAY_HAVE_ACTED} ${reason === "screen_locked" ? `${PAUSE_STATE.screen_locked}. ${PAUSE_NEXT.screen_locked}` : LEASE_END_MESSAGES.stopped}`
      : reason === "screen_locked"
        ? PAUSE_MESSAGES.screen_locked
        : LEASE_END_MESSAGES.stopped,
    safety,
  };
};

const decodeTerminalReply = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.optionalKey(Schema.Unknown),
    structuredContent: Schema.Struct({
      code: Schema.optionalKey(Schema.Unknown),
      refusal: Schema.optionalKey(Schema.Unknown),
      safety: Schema.optionalKey(Schema.Unknown),
    }),
  }),
);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.optionalKey(Schema.Unknown) }),
);
const decodeSafety = Schema.decodeUnknownOption(
  Schema.Struct({
    retryClass: Schema.optionalKey(Schema.Unknown),
    possibleCommit: Schema.optionalKey(Schema.Unknown),
  }),
);

export const terminalReplyState = (
  value: unknown,
  status?: "settled" | "not_started" | "unknown_outcome",
) => {
  const decoded = decodeTerminalReply(value);
  if (decoded._tag === "None")
    return {
      reason: undefined,
      possibleCommit: false,
      wireReason: undefined,
      terminalSafety: false,
    };
  const content = decoded.value.structuredContent;
  const safety = decodeSafety(content.safety);
  if (decoded.value.isError !== true && status !== "not_started" && status !== "unknown_outcome")
    return {
      reason: undefined,
      possibleCommit: safety._tag === "Some" && safety.value.possibleCommit === true,
      wireReason: undefined,
      terminalSafety: false,
    };
  const terminal = (code: unknown) =>
    code === "stopped_by_person" || code === "screen_locked" ? code : undefined;
  const refusal = decodeRefusal(content.refusal);
  const wireReason = terminal(content.code);
  return {
    ...mergeTerminal(
      {
        reason: wireReason,
        possibleCommit: safety._tag === "Some" && safety.value.possibleCommit === true,
      },
      { reason: refusal._tag === "Some" ? terminal(refusal.value.code) : undefined },
    ),
    wireReason,
    terminalSafety: safety._tag === "Some" && safety.value.retryClass === "never",
  };
};

const decodeRpcError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.Unknown),
    data: Schema.optionalKey(Schema.Unknown),
  }),
);

export const terminalErrorState = (value: unknown) => {
  const error = decodeRpcError(value);
  if (error._tag === "None") return mergeTerminal({}, {});
  return mergeTerminal(
    terminalReplyState({ isError: true, structuredContent: error.value }),
    terminalReplyState({ isError: true, structuredContent: error.value.data }),
  );
};

export const terminalReason = (
  latched: ComputerUseTerminalReason | undefined,
  state?: { readonly _tag: string; readonly reason?: string },
): ComputerUseTerminalReason | undefined =>
  mergeTerminal(
    { reason: latched },
    {
      reason:
        state?._tag === "paused" && state.reason === "screen_locked"
          ? "screen_locked"
          : state?._tag === "ended" &&
              (state.reason === "stopped" || state.reason === "stopped_all")
            ? "stopped_by_person"
            : undefined,
    },
  ).reason;
