import * as DateTime from "effect/DateTime";
import { SKILL_MENTION_PATTERN } from "@goat/shared/composerInlineTokens";

export function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.makeUnsafe(seconds * 1000);
}

/**
 * The composers let a skill be typed with any currency sigil (`€review`), but
 * Codex only parses `$name` as a skill mention.
 */
export function codexSkillMentionText(text: string): string {
  return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}
