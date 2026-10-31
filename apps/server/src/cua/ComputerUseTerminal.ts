import * as Schema from "effect/Schema";

export type ComputerUseTerminalReason = "stopped_by_person" | "screen_locked";

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
