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

const FORGET_PREFIX = goatBotForgetNoteMessage("").slice(0, -1);
const CHANGE_PREFIX = goatBotChangeNoteMessage("", "").split('" to: "')[0] ?? "";

type TabRequest = { readonly kind: "forget" | "change"; readonly message: string };

/** The Memory tab's sentences, recognised only when they are the whole message. */
const tabRequest = (text: string): TabRequest | undefined => {
  const message = text.trim();
  if (!message.endsWith('"')) return undefined;
  if (message.startsWith(FORGET_PREFIX) && message.length > FORGET_PREFIX.length + 1)
    return { kind: "forget", message };
  if (message.startsWith(CHANGE_PREFIX) && message.includes('" to: "', CHANGE_PREFIX.length))
    return { kind: "change", message };
  return undefined;
};

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

/** Every in-force note whose change sentence, with some non-empty new text, is `message`. */
const changeCandidates = (lines: ReadonlyArray<ChannelBotNoteLine>, message: string) => {
  const found = new Map<string, string>();
  for (const line of lines) {
    if (line.replacedBy !== undefined) continue;
    const prefix = goatBotChangeNoteMessage(line.text, "").slice(0, -1);
    if (!message.startsWith(prefix)) continue;
    const next = message.slice(prefix.length, -1);
    if (next.trim() !== "") found.set(line.text, next);
  }
  return [...found];
};

/**
 * The file without the note `text`: its lines, every earlier line they replaced, every other line
 * with a removed text, and replaces markers that quote a removed text. Every other byte is kept.
 */
const withoutNote = (fileText: string, lines: ReadonlyArray<ChannelBotNoteLine>, text: string) => {
  const removedTexts = new Set([collapseNoteText(text)]);
  const removed = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    for (const line of lines) {
      if (removed.has(line.index)) continue;
      const replacedByRemoved = line.replacedBy !== undefined && removed.has(line.replacedBy);
      if (!replacedByRemoved && !removedTexts.has(collapseNoteText(line.text))) continue;
      removed.add(line.index);
      removedTexts.add(collapseNoteText(line.text));
      grew = true;
    }
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
    /**
     * Saves notes one at a time, so a correction sees the note the one before it saved. Each save
     * answers what the reply must add: a correction that matched nothing, or a failed save.
     */
    const save = (note: string, readAt: string, inputId: string, replaces?: string) =>
      gate
        .withPermits(1)(appendChannelBotNote(fs, files, note, readAt, inputId, replaces))
        .pipe(
          Effect.map(({ correction }) =>
            correction === "unmatched" ? CHANNEL_COPY.noteCorrectionUnmatched : undefined,
          ),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot note was not saved", { cause }).pipe(
              Effect.as(CHANNEL_COPY.noteNotSaved),
            ),
          ),
        );

    const readNotes = readChannelBotNotesTail(files.notes, NOTES_EDIT_MAX_BYTES);

    const change = Effect.fn("channelBotNoteTabEdits.change")(function* (
      message: string,
      text: string,
      exists: boolean,
      inputId: string,
      readAt: string,
    ) {
      // A pass re-run after a restart finds its own line and answers as the first pass did.
      if (text.includes(noteSource(inputId))) return CHANNEL_COPY.noteChanged;
      const candidates = changeCandidates(parseChannelBotNoteLines(text), message);
      const [only] = candidates;
      if (only === undefined) return CHANNEL_COPY.noteNotFound;
      if (candidates.length > 1) return CHANNEL_COPY.noteAmbiguous;
      const line = channelBotNoteLine(only[1], readAt, inputId, only[0]);
      if (line === undefined) return CHANNEL_COPY.noteNotFound;
      yield* fs.writeFileString(files.notes, appendPrefix(exists, text) + line + "\n", {
        flag: "a",
      });
      return CHANNEL_COPY.noteChanged;
    });

    // Residuals, accepted: a write that lands between the compare and the rename is lost, and a
    // writer holding a copy read before the rename can write the removed words back afterwards.
    const forget = Effect.fn("channelBotNoteTabEdits.forget")(function* (
      message: string,
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
      const target = lines.find(
        (line) => line.replacedBy === undefined && goatBotForgetNoteMessage(line.text) === message,
      );
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
          return yield* change(request.message, decode(original), read !== null, inputId, readAt);
        const answer = yield* forget(request.message, original);
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

    return { save, tabEdit };
  });

/** The sentence a reply gains when reception dropped a note the model asked to keep. */
export const droppedNoteNotice = (refusal: string | undefined) =>
  refusal === "missing_quote" || refusal === "quote_not_in_input"
    ? CHANNEL_COPY.noteNotSaved
    : undefined;
