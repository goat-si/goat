export type ComputerUseTerminalReason = "stopped_by_person" | "screen_locked";

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
