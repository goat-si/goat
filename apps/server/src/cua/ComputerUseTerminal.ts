import * as Schema from "effect/Schema";
import type { ActionOutcomeSafety, ScreenRunError } from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import { isReadOnlyCall, LEASE_END_MESSAGES, PAUSE_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import { refusalSafety } from "./ComputerUseDriverOutcome.ts";

export type ComputerUseTerminalReason = "stopped_by_person" | "screen_locked";

export const terminalFailure = (
  reason: ComputerUseTerminalReason | undefined,
  tool: string,
  args: unknown,
  dispatched = false,
): ScreenRunError | undefined => {
  if (reason === undefined) return undefined;
  const safety: ActionOutcomeSafety = dispatched
    ? {
        ...classifyActionOutcome({
          effect: isReadOnlyCall(tool, args) ? "read" : "write",
          status: "indeterminate",
          dispatched: true,
        }),
        retryClass: "never",
      }
    : refusalSafety(reason === "screen_locked" ? "screen_locked" : "stopped", tool, args);
  return {
    code: reason,
    effectStarted: safety.possibleCommit,
    nextStep:
      reason === "screen_locked" ? PAUSE_MESSAGES.screen_locked : LEASE_END_MESSAGES.stopped,
    safety,
  };
};

const decodeTerminalReply = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.Literal(true),
    structuredContent: Schema.Struct({
      code: Schema.Literals(["stopped_by_person", "screen_locked"]),
      safety: Schema.Struct({ retryClass: Schema.Literal("never") }),
    }),
  }),
);

export const terminalReplyReason = (value: unknown): ComputerUseTerminalReason | undefined => {
  const decoded = decodeTerminalReply(value);
  return decoded._tag === "Some" ? decoded.value.structuredContent.code : undefined;
};

export const terminalReason = (
  latched: ComputerUseTerminalReason | undefined,
  state?: { readonly _tag: string; readonly reason?: string },
): ComputerUseTerminalReason | undefined =>
  latched ??
  (state?._tag === "paused" && state.reason === "screen_locked"
    ? "screen_locked"
    : state?._tag === "ended" && (state.reason === "stopped" || state.reason === "stopped_all")
      ? "stopped_by_person"
      : undefined);
