import type { GoatBotFaceState } from "./face.ts";

/** A bot's chosen avatar emoji, or null for the default face. */
export function goatBotAvatarEmoji(avatar: string | null | undefined): string | null {
  const trimmed = avatar?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** A member's emoji, else its name's first letter, so members never share the main bot's face. */
export function goatBotMemberPicture(bot: {
  readonly avatar?: string | null | undefined;
  readonly name: string;
}): string | null {
  return (
    goatBotAvatarEmoji(bot.avatar) ?? Array.from(bot.name.trim())[0]?.toLocaleUpperCase() ?? null
  );
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
