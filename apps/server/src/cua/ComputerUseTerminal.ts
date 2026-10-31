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

export type ComputerUseTerminalSource =
  | string
  | boolean
  | undefined
  | {
      readonly reason?: unknown;
      readonly possibleCommit?: boolean | undefined;
      readonly code?: unknown;
      readonly effectStarted?: boolean | undefined;
      readonly safety?: { readonly possibleCommit: boolean } | undefined;
    };

export const replaceWithTerminal = (
  replaced: ComputerUseTerminalSource,
  ...sources: readonly ComputerUseTerminalSource[]
): ComputerUseTerminalState => {
  const stateOf = (source: ComputerUseTerminalSource): ComputerUseTerminalState => {
    if (typeof source === "boolean") return { possibleCommit: source };
    if (typeof source === "string")
      return {
        reason: source === "stopped_by_person" || source === "screen_locked" ? source : undefined,
        possibleCommit: false,
      };
    if (source === undefined) return { possibleCommit: false };
    const code = source.code;
    const reason = source.reason;
    return mergeTerminal(
      { reason: reason === "stopped_by_person" || reason === "screen_locked" ? reason : undefined },
      {
        reason: code === "stopped_by_person" || code === "screen_locked" ? code : undefined,
        possibleCommit:
          source.possibleCommit === true ||
          source.effectStarted === true ||
          source.safety?.possibleCommit === true,
      },
    );
  };
  return sources.reduce<ComputerUseTerminalState>(
    (state, source) => mergeTerminal(state, stateOf(source)),
    mergeTerminal(stateOf(replaced), {}),
  );
};

export const terminalState = (reason: unknown, possibleCommit: boolean): ComputerUseTerminalState =>
  replaceWithTerminal(
    "none",
    reason === "stopped_by_person" || reason === "screen_locked" ? reason : undefined,
    possibleCommit,
  );

export const terminalFailure = (
  state: ComputerUseTerminalState,
  tool: string,
  args: unknown,
  dispatched = false,
): ScreenRunError | undefined => {
  const terminal = replaceWithTerminal(state);
  const reason = terminal.reason;
  if (reason === undefined) return undefined;
  const mayHaveInput = terminal.possibleCommit;
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
    ...replaceWithTerminal(
      safety._tag === "Some" && safety.value.possibleCommit === true,
      wireReason,
      refusal._tag === "Some" ? terminal(refusal.value.code) : undefined,
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
  if (error._tag === "None") return replaceWithTerminal("none");
  return replaceWithTerminal(
    terminalReplyState({ isError: true, structuredContent: error.value }),
    terminalReplyState({ isError: true, structuredContent: error.value.data }),
  );
};

export const terminalReason = (
  latched: ComputerUseTerminalReason | undefined,
  state?: { readonly _tag: string; readonly reason?: string },
): ComputerUseTerminalReason | undefined =>
  replaceWithTerminal(
    latched,
    state?._tag === "paused" && state.reason === "screen_locked"
      ? "screen_locked"
      : state?._tag === "ended" && (state.reason === "stopped" || state.reason === "stopped_all")
        ? "stopped_by_person"
        : undefined,
  ).reason;
