/**
 * Writes to GOAT Bot's notes that do not come from the model: reception's own saves, and the two
 * sentences the Memory tab sends to change or forget a note. They share one lock, so a forget and
 * a save never interleave. A forget rewrites memory.md through a temp file and a rename; workers
 * that edit the file by hand do not take this lock (see the residuals in the forget below).
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- staging names only need to be unique.
import * as NodeCrypto from "node:crypto";

import {
  goatBotChangeNoteMessage,
  goatBotForgetNoteMessage,
  type ChannelRequester,
  type ChannelTaskStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { isUnlinkedPrincipal } from "./ChannelGateway.ts";
import {
  collapseNoteText,
  NOTES_HEADER,
  parseChannelBotNoteLines,
  withoutReplacesMarker,
  type ChannelBotNoteLine,
} from "./channelBotNoteLines.ts";
import {
  appendChannelBotNote,
  appendPrefix,
  channelBotNoteLine,
  noteSource,
  type ChannelBotFiles,
} from "./channelBotNotes.ts";
import { readChannelBotNotesTail } from "./channelBotNotesTail.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";

/** The largest notes file a Memory tab edit reads and rewrites. */
const NOTES_EDIT_MAX_BYTES = 1024 * 1024;
const EDIT_ATTEMPTS = 2;
// Tasks that may still be editing memory.md by hand.
const OPEN_STATUSES: ReadonlyArray<ChannelTaskStatus> = [
  "received",
  "dispatching",
  "running",
  "waiting_input",
];

// The fixed words around the notes, taken from the sentences the clients build.
const FORGET_PREFIX = goatBotForgetNoteMessage("").slice(0, -2);
const CHANGE_SAMPLE = goatBotChangeNoteMessage("", "");
const CHANGE_PREFIX = CHANGE_SAMPLE.slice(0, CHANGE_SAMPLE.indexOf('"'));
const CHANGE_TO = CHANGE_SAMPLE.slice(CHANGE_PREFIX.length + 2, -2);

type TabRequest =
  | { readonly kind: "forget"; readonly note: string }
  | { readonly kind: "change"; readonly note: string; readonly next: string };

/** The JSON string literal starting at `from`, and the index just after it. */
const jsonStringAt = (text: string, from: number) => {
  if (text[from] !== '"') return undefined;
  for (let at = from + 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === '"') {
      try {
        const value: unknown = JSON.parse(text.slice(from, at + 1));
        return typeof value === "string" ? { value, end: at + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/** The Memory tab's sentences, recognised only when they are the whole message. */
const tabRequest = (text: string): TabRequest | undefined => {
  const message = text.trim();
  if (message.startsWith(FORGET_PREFIX)) {
    const note = jsonStringAt(message, FORGET_PREFIX.length);
    return note?.end === message.length && note.value !== ""
      ? { kind: "forget", note: note.value }
      : undefined;
  }
  if (!message.startsWith(CHANGE_PREFIX)) return undefined;
  const note = jsonStringAt(message, CHANGE_PREFIX.length);
  if (note === undefined || !message.startsWith(CHANGE_TO, note.end)) return undefined;
  const next = jsonStringAt(message, note.end + CHANGE_TO.length);
  return next?.end === message.length && next.value.trim() !== ""
    ? { kind: "change", note: note.value, next: next.value }
    : undefined;
};

/** Whether a message is one of the Memory tab's sentences, which reception answers itself. */
export const isMemoryTabEdit = (message: { readonly intent: string; readonly text?: string }) =>
  message.intent === "message" && tabRequest(message.text ?? "") !== undefined;

/** What a tab edit answers; shaped like an approval answer so reception completes it the same way. */
interface TabEditAnswer {
  readonly text: string;
  readonly options?: undefined;
  readonly task?: undefined;
}

export interface NoteWriterHooks {
  /** Runs after the rewritten notes are staged, before memory.md is compared and replaced. */
  readonly beforeCompare?: Effect.Effect<void>;
  /** Runs right after the rename, before the file is read again to check it. */
  readonly afterRename?: Effect.Effect<void>;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// A forget rewrites the file, so it keeps a byte order mark and refuses bytes that are not UTF-8.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = "\uFEFF";

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * The file without the note `text`: its lines, every earlier line they replaced, every other line
 * with a removed text, and replaces markers that quote a removed text. Every other byte is kept.
 */
const withoutNote = (fileText: string, lines: ReadonlyArray<ChannelBotNoteLine>, text: string) => {
  // Indexed both ways, so a long correction chain is walked once instead of once per link.
  const byText = new Map<string, Array<number>>();
  const replacedLines = new Map<number, Array<number>>();
  const add = <K>(map: Map<K, Array<number>>, key: K, index: number) => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [index]);
    else list.push(index);
  };
  for (const line of lines) {
    add(byText, collapseNoteText(line.text), line.index);
    if (line.replacedBy !== undefined) add(replacedLines, line.replacedBy, line.index);
  }
  const removedTexts = new Set<string>();
  const removed = new Set<number>();
  const queue = [...(byText.get(collapseNoteText(text)) ?? [])];
  for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
    if (removed.has(index)) continue;
    removed.add(index);
    for (const earlier of replacedLines.get(index) ?? []) queue.push(earlier);
    const key = collapseNoteText(lines[index]?.text ?? "");
    if (removedTexts.has(key)) continue;
    removedTexts.add(key);
    for (const same of byText.get(key) ?? []) queue.push(same);
  }
  // Physical lines keep their own endings; parsed notes map onto them with the parser's skips.
  const physical = fileText.split(/(?<=\n)/u);
  const headerLines = fileText.replaceAll("\r\n", "\n").startsWith(NOTES_HEADER)
    ? NOTES_HEADER.split("\n").length - 1
    : 0;
  let index = 0;
  for (let at = headerLines; at < physical.length; at++) {
    const content = (physical[at] ?? "").replace(/\r?\n$/u, "").trim();
    if (content === "" || content.startsWith("#")) continue;
    const line = lines[index++];
    if (line === undefined || line.raw !== content) return undefined;
    if (removed.has(line.index)) physical[at] = "";
    else if (line.replaces !== undefined && removedTexts.has(collapseNoteText(line.replaces)))
      physical[at] = (physical[at] ?? "").replace(line.raw, withoutReplacesMarker(line.raw));
  }
  return index === lines.length ? { text: physical.join(""), removedTexts } : undefined;
};

const stillThere = (fileText: string, removedTexts: ReadonlySet<string>) =>
  parseChannelBotNoteLines(fileText).some(
    (line) =>
      removedTexts.has(collapseNoteText(line.text)) ||
      (line.replaces !== undefined && removedTexts.has(collapseNoteText(line.replaces))),
  );

export const makeChannelBotNoteWriter = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  ledger: Pick<ChannelLedger.ChannelLedger["Service"], "listTasksByStatus">,
  hooks: NoteWriterHooks = {},
) =>
  Effect.map(Semaphore.make(1), (gate) => {
    const grantOpen = Effect.map(ledger.listTasksByStatus(OPEN_STATUSES), (open) =>
      open.some((stored) => stored.task.notesChangeRequested !== undefined),
    );
    /**
     * A restart re-runs an input whose note was saved before a refusal could apply. Its first
     * answer, read from the file and never written again: a task holding a grant may be editing it.
     */
    const savedBefore = (inputId: string, replaces: string | undefined) =>
      readChannelBotNotesTail(files.notes, NOTES_EDIT_MAX_BYTES).pipe(
        Effect.map((read) => {
          const source = noteSource(inputId);
          if (read === null) return undefined;
          const text = decode(read.bytes);
          if (!text.includes(source)) return undefined;
          const first = parseChannelBotNoteLines(text).find((line) => line.raw.includes(source));
          const unmatched = replaces !== undefined && first?.replaces === undefined;
          return { notice: unmatched ? CHANNEL_COPY.noteCorrectionUnmatched : undefined };
        }),
        Effect.orElseSucceed(() => undefined),
      );
    const append = (note: string, readAt: string, inputId: string, replaces?: string) =>
      appendChannelBotNote(fs, files, note, readAt, inputId, replaces).pipe(
        Effect.map(({ correction }) =>
          correction === "unmatched" ? CHANNEL_COPY.noteCorrectionUnmatched : undefined,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("GOAT Bot note was not saved", { cause }).pipe(
            Effect.as(CHANNEL_COPY.noteNotSaved),
          ),
        ),
      );

    /**
     * Saves notes one at a time, so a correction sees the note the one before it saved. Each save
     * answers what the reply must add: a correction that matched nothing, a failed save, or that a
     * task holding a notes grant may be editing the file by hand, so nothing was saved.
     */
    const save = (note: string, readAt: string, inputId: string, replaces?: string) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const busy = yield* grantOpen.pipe(Effect.orElseSucceed(() => true));
          if (busy) {
            const prior = yield* savedBefore(inputId, replaces);
            return prior === undefined ? CHANNEL_COPY.noteEditBusy : prior.notice;
          }
          return yield* append(note, readAt, inputId, replaces);
        }),
      );

    /**
     * A save that holds only if `guard`, checked under the lock right before writing, finds no
     * reason to refuse, or the input's note is already saved; otherwise it answers that reason and
     * writes nothing.
     */
    const saveIf = <R extends string, E>(
      guard: Effect.Effect<R | undefined, E>,
      note: string,
      readAt: string,
      inputId: string,
      replaces?: string,
    ) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const refused = yield* guard;
          if (refused !== undefined) return (yield* savedBefore(inputId, replaces)) ?? { refused };
          return { notice: yield* append(note, readAt, inputId, replaces) };
        }),
      );

    /** Runs `effect` under the writers' lock, so a notes grant is checked and recorded as one step. */
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect);

    const readNotes = readChannelBotNotesTail(files.notes, NOTES_EDIT_MAX_BYTES);

    const change = Effect.fn("channelBotNoteTabEdits.change")(function* (
      note: string,
      next: string,
      text: string,
      exists: boolean,
      inputId: string,
      readAt: string,
    ) {
      // A pass re-run after a restart finds its own line and answers as the first pass did.
      if (text.includes(noteSource(inputId))) return CHANNEL_COPY.noteChanged;
      const inForce = parseChannelBotNoteLines(text).some(
        (line) => line.replacedBy === undefined && line.text === note,
      );
      const line = inForce ? channelBotNoteLine(next, readAt, inputId, note) : undefined;
      if (line === undefined) return CHANNEL_COPY.noteNotFound;
      yield* fs.writeFileString(files.notes, appendPrefix(exists, text) + line + "\n", {
        flag: "a",
      });
      return CHANNEL_COPY.noteChanged;
    });

    // Residuals, accepted: a write that lands between the compare and the rename is lost, and a
    // writer holding a copy read before the rename can write the removed words back afterwards.
    const forget = Effect.fn("channelBotNoteTabEdits.forget")(function* (
      note: string,
      original: Uint8Array,
    ) {
      const decoded = yield* Effect.try({
        try: () => strictDecoder.decode(original),
        catch: () => "not UTF-8",
      }).pipe(Effect.option);
      if (decoded._tag === "None") return CHANNEL_COPY.noteEditFailed;
      const bom = decoded.value.startsWith(BOM) ? BOM : "";
      const text = decoded.value.slice(bom.length);
      const lines = parseChannelBotNoteLines(text);
      const target = lines.find((line) => line.replacedBy === undefined && line.text === note);
      if (target === undefined) return CHANNEL_COPY.noteNotFound;
      const next = withoutNote(text, lines, target.text);
      if (next === undefined) return CHANNEL_COPY.noteEditFailed;
      const mode = (yield* fs.stat(files.notes)).mode;
      // Created exclusively under a fresh name, so no existing file or link is ever written.
      const staged = files.notes + ".edit-" + NodeCrypto.randomUUID();
      let created = false;
      const replaced = yield* Effect.gen(function* () {
        yield* fs.writeFileString(staged, bom + next.text, { flag: "wx" });
        created = true;
        yield* fs.chmod(staged, mode & 0o777);
        yield* hooks.beforeCompare ?? Effect.void;
        const current = yield* readNotes;
        if (current === null || !sameBytes(current.bytes, original)) return false;
        yield* fs.rename(staged, files.notes);
        return true;
      }).pipe(Effect.onExit(() => (created ? fs.remove(staged).pipe(Effect.ignore) : Effect.void)));
      if (!replaced) return undefined;
      yield* hooks.afterRename ?? Effect.void;
      const check = yield* readNotes.pipe(Effect.option);
      if (check._tag === "None" || check.value === null || check.value.truncated)
        return CHANNEL_COPY.noteUnverified;
      return stillThere(decode(check.value.bytes), next.removedTexts)
        ? CHANNEL_COPY.noteCameBack
        : CHANNEL_COPY.noteForgotten;
    });

    const apply = Effect.fn("channelBotNoteTabEdits.apply")(function* (
      request: TabRequest,
      inputId: string,
      readAt: string,
    ) {
      const open = yield* ledger.listTasksByStatus(OPEN_STATUSES);
      if (open.some((stored) => stored.task.notesChangeRequested !== undefined))
        return CHANNEL_COPY.noteEditBusy;
      for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
        const read = yield* readNotes;
        if (read?.truncated === true) return CHANNEL_COPY.noteFileTooLarge;
        const original = read?.bytes ?? new Uint8Array();
        if (request.kind === "change")
          return yield* change(
            request.note,
            request.next,
            decode(original),
            read !== null,
            inputId,
            readAt,
          );
        const answer = yield* forget(request.note, original);
        if (answer !== undefined) return answer;
      }
      return CHANNEL_COPY.noteEditFailed;
    });

    /**
     * Answers a message that is exactly one of the Memory tab's change or forget sentences, without
     * the model; anything else is left to reception. `judged` is the requester as linked now,
     * absent for routines, which never change notes.
     */
    const tabEdit = Effect.fn("channelBotNoteTabEdits.tabEdit")(function* <E>(
      message: { readonly intent: string; readonly text: string },
      inputId: string,
      readAt: string,
      judged: Effect.Effect<ChannelRequester | undefined, E> | undefined,
    ) {
      const request = message.intent === "message" ? tabRequest(message.text) : undefined;
      if (request === undefined || judged === undefined) return undefined;
      const who = yield* judged.pipe(Effect.orElseSucceed(() => undefined));
      const allowed =
        who !== undefined && who.originKind !== "mcp" && !isUnlinkedPrincipal(who.principalId);
      const text = !allowed
        ? CHANNEL_COPY.noteEditNotAllowed
        : yield* gate
            .withPermits(1)(apply(request, inputId, readAt))
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("GOAT Bot notes edit failed", { cause }).pipe(
                  Effect.as(CHANNEL_COPY.noteEditFailed),
                ),
              ),
            );
      const answer: TabEditAnswer = { text };
      return answer;
    });

    return { save, saveIf, exclusive, tabEdit, grantOpen };
  });

/**
 * The sentence a reply gains when reception dropped a note the model asked to keep, or a request
 * to change notes from someone who may not: neither is dropped without saying so.
 */
export const droppedNoteNotice = (refusal: string | undefined, editRequested = false) =>
  refusal === "missing_quote" || refusal === "quote_not_in_input"
    ? CHANNEL_COPY.noteNotSaved
    : refusal === "not_linked" || refusal === "not_a_person" || editRequested
      ? CHANNEL_COPY.noteEditNotAllowed
      : undefined;
