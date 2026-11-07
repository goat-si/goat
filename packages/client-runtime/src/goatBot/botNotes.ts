import {
  type ChannelBotNote,
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
} from "@goat/contracts";

export const GOAT_BOT_NOTES_COPY =
  "GOAT Bot uses notes from its next conversation session. Notes are shared with Slack and iMessage.";
export const GOAT_BOT_NOTES_SHARED_COPY =
  "Every bot on this computer shares these notes with GOAT Bot.";

/** The message that asks GOAT Bot to forget a note; it quotes the note exactly. */
export const forgetNoteDraft = (note: ChannelBotNote) => goatBotForgetNoteMessage(note.text);

/** The message that asks for new wording, or null when there is nothing new to ask for. */
export function changeNoteDraft(note: ChannelBotNote, newText: string): string | null {
  const wording = newText.trim();
  return wording === "" || wording === note.text.trim()
    ? null
    : goatBotChangeNoteMessage(note.text, wording);
}

export const noteDateLabel = (date: string | null) => date ?? "Undated";

const tagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;

/** Why the notes cannot be shown, and whether trying again can help. */
export function botNotesFailure(error: unknown): { message: string; retry: boolean } {
  if (tagOf(error) === "EnvironmentAuthorizationError")
    return { message: "This device can't read GOAT Bot's notes.", retry: false };
  if (
    tagOf(error) === "ChannelGatewayError" &&
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "not_home"
  )
    return { message: "GOAT Bot's notes are on its home computer.", retry: false };
  return { message: "Couldn't load GOAT Bot's notes.", retry: true };
}

interface NotesRefreshRow {
  readonly kind: string;
  readonly id: string;
  readonly text?: string;
  readonly card?: { readonly key: string; readonly revision: number };
}

/**
 * Changes when GOAT Bot answers or one of its tasks moves on. A note is edited inside a task,
 * and the task's card gets a new revision when it ends, so the key changes after the edit.
 */
export function goatBotNotesRefreshKey(rows: ReadonlyArray<NotesRefreshRow>): string {
  let answer = "";
  const tasks: string[] = [];
  for (const row of rows) {
    if (row.kind === "bot") answer = `${row.id}:${row.text?.length ?? 0}`;
    else if (row.kind === "task" && row.card) tasks.push(`${row.card.key}:${row.card.revision}`);
  }
  return [answer, ...tasks].join("|");
}
