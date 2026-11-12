import type { ChannelBotNote } from "@goat/contracts";

/** A new wording being written for one note, with what finds that note again in a later read. */
export interface MobileNoteWording {
  readonly wording: string;
  readonly text: string;
  /** The note's text, date and source; notes alike in all three cannot be told apart. */
  readonly identity: string;
  readonly revision: string | null;
  /** Which of the notes with this identity, and how many there were, in that read. */
  readonly nth: number;
  readonly alike: number;
}

export type MobileNoteWordings = ReadonlyMap<string, MobileNoteWording>;

const identityOf = (note: ChannelBotNote) =>
  JSON.stringify([note.text, note.date, note.source ?? null]);

/** Each current note's identity, its place among notes alike, and how many are alike. */
export function mobileNotePlaces(notes: ReadonlyArray<ChannelBotNote>) {
  const seen = new Map<string, number>();
  const places = notes.map((note) => {
    const identity = identityOf(note);
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    return { note, identity, nth };
  });
  return places.map((place) => ({ ...place, alike: seen.get(place.identity) ?? 1 }));
}

/**
 * Where each kept wording belongs in this read: on the same note when it can be told apart (the
 * same read, or the only note alike then and now), or on its own to copy or discard, saying
 * whether its note is gone or ambiguous. Wordings that change nothing are dropped from view.
 */
export function placeMobileNoteWordings(
  places: ReturnType<typeof mobileNotePlaces>,
  revision: string | null,
  wordings: MobileNoteWordings,
) {
  const attached = new Map<number, { readonly key: string; readonly kept: MobileNoteWording }>();
  const apart: Array<{
    readonly key: string;
    readonly kept: MobileNoteWording;
    readonly reason: "gone" | "ambiguous";
  }> = [];
  for (const [key, kept] of wordings) {
    const matches = places.filter((place) => place.identity === kept.identity);
    const match =
      kept.revision === revision
        ? matches[kept.nth]
        : matches.length === 1 && kept.alike === 1
          ? matches[0]
          : undefined;
    if (match !== undefined && !attached.has(match.note.index)) {
      attached.set(match.note.index, { key, kept });
      continue;
    }
    const wording = kept.wording.trim();
    if (wording === "" || wording === kept.text.trim()) continue;
    apart.push({ key, kept, reason: matches.length === 0 ? "gone" : "ambiguous" });
  }
  return { attached, apart };
}
