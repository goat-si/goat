import {
  type ChannelBotNote,
  type ChannelBotNoteSource,
  type ChannelKind,
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

/** A moment's calendar day as YYYY-MM-DD in the given time zone (the device's when absent). */
const localDay = (epochMs: number, timeZone: string | undefined) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(epochMs);
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

/**
 * The day a note row shows. A note with a request time is dated by it in the viewer's time zone,
 * the same day its source label shows; the line's own date is the server's and may be another
 * zone's day. Hand-written lines and notes from another conversation keep the line's date.
 */
export function noteDateLabel(
  note: { readonly date: string | null; readonly source?: ChannelBotNoteSource | undefined },
  timeZone?: string,
): string {
  if (note.source?.kind === "shown") {
    const at = Date.parse(note.source.at);
    if (Number.isFinite(at)) return localDay(at, timeZone);
  }
  return note.date ?? "Undated";
}

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
/** Said above a list that is only the newest part of memory.md; makes no claim about what the bot reads. */
export const GOAT_BOT_NOTES_TRUNCATED_COPY =
  "memory.md is larger than 64 KB, so this list shows only complete notes from its newest 64 KB. The rest of the file is unchanged.";

const CHANNEL_LABELS = {
  goat: "GOAT",
  slack: "Slack",
  imessage: "iMessage",
  mcp: "an agent",
} as const satisfies Record<ChannelKind, string>;

const yearIn = (epochMs: number, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(epochMs);

/**
 * Where a note was asked for, read in the viewer's time zone: "Slack, Juni, Nov 7". Null for a
 * line written by hand.
 */
export function goatBotNoteSourceLabel(
  source: ChannelBotNoteSource | undefined,
  options: { readonly now: number; readonly timeZone?: string },
): string | null {
  if (source === undefined) return null;
  if (source.kind === "elsewhere") return "Asked in another conversation";
  const at = Date.parse(source.at);
  const { timeZone } = options;
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(yearIn(at, timeZone) === yearIn(options.now, timeZone) ? {} : { year: "numeric" }),
    timeZone,
  }).format(at);
  return [CHANNEL_LABELS[source.channel], source.from.trim(), day].filter(Boolean).join(", ");
}

/**
 * The Memory tab's notes: current ones get Ask actions; ones a correction replaced sit behind a
 * toggle with the text that replaced them.
 */
export function goatBotNotesView(result: {
  readonly notes: ReadonlyArray<ChannelBotNote>;
  readonly truncated: boolean;
}) {
  const current = result.notes.filter((note) => note.replacedBy === undefined);
  const replaced = result.notes.filter((note) => note.replacedBy !== undefined);
  const byIndex = new Map(result.notes.map((note) => [note.index, note.text]));
  const empty: "none" | "no_current" | "none_in_window" | null =
    result.notes.length === 0
      ? result.truncated
        ? "none_in_window"
        : "none"
      : current.length === 0
        ? "no_current"
        : null;
  return {
    current,
    replaced,
    empty,
    replacingText: (note: ChannelBotNote) =>
      note.replacedBy === undefined ? null : (byIndex.get(note.replacedBy) ?? null),
  };
}
