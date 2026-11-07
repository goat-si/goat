import type { GoatBotFaceState } from "./face.ts";

/** A bot's chosen avatar emoji, or null for the default face. */
export function goatBotAvatarEmoji(avatar: string | null | undefined): string | null {
  const trimmed = avatar?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** How a round avatar shows the bot's state around its picture. */
export interface GoatBotAvatarSignal {
  readonly ring: "active" | "failed" | "finished" | null;
  readonly waitingDot: boolean;
  readonly dimmed: boolean;
}

/**
 * The face shows reading, finished and sleeping with its eyes. An emoji has none, so those get a
 * ring or a dimmed picture; every signal is still, and finished lasts only as long as that state.
 */
export function goatBotAvatarSignal(state: GoatBotFaceState, emoji: boolean): GoatBotAvatarSignal {
  const waitingDot = state === "waiting";
  const ring =
    state === "working" || (emoji && state === "reading")
      ? "active"
      : state === "failed"
        ? "failed"
        : emoji && state === "finished"
          ? "finished"
          : null;
  return { ring, waitingDot, dimmed: emoji && state === "sleeping" };
}
