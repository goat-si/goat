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
  currentNoteNamedBy,
  NOTES_HEADER,
  parseChannelBotNoteLines,
  withoutReplacesMarker,
  type ChannelBotNoteLine,
} from "./channelBotNoteLines.ts";
import {
  appendChannelBotNote,
  appendPrefix,
  channelBotNoteLine,
  noteDay,
  noteSource,
  type ChannelBotFiles,
} from "./channelBotNotes.ts";
import { readChannelBotNotesTail, type NotesTail } from "./channelBotNotesTail.ts";
import { CHANNEL_COPY, notesAlikeAnswer, notesAlikeNotSaved } from "./channelCopy.ts";

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

/** The one current note a request's words name; words several current notes read name none. */
const addressedNote = (
  lines: ReadonlyArray<ChannelBotNoteLine>,
  note: string,
):
  | { readonly line: ChannelBotNoteLine }
  | { readonly line?: undefined; readonly answer: string } => {
  const named = currentNoteNamedBy(lines, note);
  if (named.line !== undefined) return { line: named.line };
  return {
    answer:
      named.alike === 0
        ? CHANNEL_COPY.noteNotFound
        : notesAlikeAnswer(collapseNoteText(note), named.alike),
  };
};

/** What a tab edit answers; shaped like an approval answer so reception completes it the same way. */
interface TabEditAnswer {
  readonly text: string;
  readonly options?: undefined;
  readonly task?: undefined;
}

export interface NoteWriterHooks {
  /** Runs after an edit is prepared (a forget's file staged), before memory.md is compared. */
  readonly beforeCompare?: Effect.Effect<void>;
  /** Runs right after the rename, before the file is read again to check it. */
  readonly afterRename?: Effect.Effect<void>;
  /** Runs after a save, change, or forget that changed the notes file. A failure here is ignored. */
  readonly onWrote?: (inputId: string) => Effect.Effect<void>;
}

/** A note GOAT kept after refusing to forget it while other work held a notes grant. */
export interface KeptNote {
  readonly note: string;
  /** The tasks that held a grant when the forget was refused. */
  readonly holders: ReadonlyArray<string>;
}

interface RefusedForget {
  readonly note: string;
  readonly raw: string;
  readonly holders: ReadonlySet<string>;
}

/** What a save adds to the reply; `held` when nothing was saved and the reply is only `notice`. */
export interface NoteSaveAnswer {
  readonly notice: string | undefined;
  readonly held?: true;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// A forget rewrites the file, so it keeps a byte order mark and refuses bytes that are not UTF-8.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = "\uFEFF";

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const sameRead = (left: NotesTail | null, right: NotesTail | null) =>
  left === null || right === null ? left === right : sameBytes(left.bytes, right.bytes);

/**
 * Whether `after` holds exactly the lines kept, each replacing the same kept line as before. Removing
 * a note with the notes it replaced keeps every other binding, but it can change how other lines
 * parse: a note above the header, once removed, makes the header start the file again.
 */
const sameBindings = (
  kept: ReadonlyArray<ChannelBotNoteLine>,
  after: ReadonlyArray<ChannelBotNoteLine>,
) => {
  const position = new Map(kept.map((line, at) => [line.index, at]));
  return (
    after.length === kept.length &&
    kept.every((line, at) => {
      const now = after[at];
      const by = line.replacedBy === undefined ? undefined : position.get(line.replacedBy);
      return now !== undefined && now.text === line.text && now.replacedBy === by;
    })
  );
};

/**
 * The file without `selected` and the notes it replaced, followed through the parser's bindings,
 * and without replaces markers that bind nothing and quote one of them. Every other byte is kept.
 */
const withoutNote = (
  fileText: string,
  lines: ReadonlyArray<ChannelBotNoteLine>,
  selected: ChannelBotNoteLine,
) => {
  // Each correction replaces at most one earlier line, so a note's replaced notes form one chain.
  const replacedOf = new Map<number, number>();
  for (const line of lines)
    if (line.replacedBy !== undefined) replacedOf.set(line.replacedBy, line.index);
  const removed = new Set<number>();
  for (let at: number | undefined = selected.index; at !== undefined; at = replacedOf.get(at))
    removed.add(at);
  const removedTexts = new Set(
    [...removed].map((index) => collapseNoteText(lines[index]?.text ?? "")),
  );
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
    if (line === undefined || line.raw !== content) return "unmapped" as const;
    if (removed.has(line.index)) physical[at] = "";
    else if (
      line.replaces !== undefined &&
      !replacedOf.has(line.index) &&
      removedTexts.has(collapseNoteText(line.replaces))
    )
      physical[at] = (physical[at] ?? "").replace(line.raw, withoutReplacesMarker(line.raw));
  }
  if (index !== lines.length) return "unmapped" as const;
  const text = physical.join("");
  const kept = lines.filter((line) => !removed.has(line.index));
  if (!sameBindings(kept, parseChannelBotNoteLines(text))) return "rebinds" as const;
  return { text, removedRaws: new Set([...removed].map((index) => lines[index]?.raw ?? "")) };
};

// Counted, since a kept line may read exactly like a removed one.
const linesAmong = (fileText: string, raws: ReadonlySet<string>) =>
  parseChannelBotNoteLines(fileText).filter((line) => raws.has(line.raw)).length;

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
    // Forgets refused while a grant was open, by note text. In memory: a restart forgets them.
    const refused = new Map<string, RefusedForget>();
    /**
     * A restart re-runs an input whose note was saved before a refusal could apply. Its first
     * answer, read from the file and never written again: a task holding a grant may be editing it.
     */
    const savedBefore = (inputId: string, replaces: string | undefined) =>
      readChannelBotNotesTail(files.notes, NOTES_EDIT_MAX_BYTES).pipe(
        Effect.map((read): NoteSaveAnswer | undefined => {
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
        Effect.map(({ correction, alike, wrote }) => {
          const answer: NoteSaveAnswer =
            correction === "alike"
              ? {
                  notice: notesAlikeNotSaved(collapseNoteText(replaces ?? ""), alike ?? 0),
                  held: true,
                }
              : {
                  notice:
                    correction === "unmatched" ? CHANNEL_COPY.noteCorrectionUnmatched : undefined,
                };
          return { answer, wrote };
        }),
        Effect.catch((cause) => {
          const answer: NoteSaveAnswer = { notice: CHANNEL_COPY.noteNotSaved };
          return Effect.logWarning("GOAT Bot note was not saved", { cause }).pipe(
            Effect.as({ answer, wrote: false }),
          );
        }),
      );
    const reportWrote = (inputId: string) => {
      const report = hooks.onWrote;
      if (report === undefined) return Effect.void;
      return report(inputId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("GOAT Bot memory update line was not queued", { cause }),
        ),
      );
    };

    /**
     * Saves notes one at a time, so a correction sees the note the one before it saved. Each save
     * answers what the reply must add: a correction that matched nothing, a failed save, or that a
     * task holding a notes grant may be editing the file by hand or that the correction's words
     * name several notes, so nothing was saved.
     */
    const save = (note: string, readAt: string, inputId: string, replaces?: string) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          const busy = yield* grantOpen.pipe(Effect.orElseSucceed(() => true));
          if (busy) {
            const prior = yield* savedBefore(inputId, replaces);
            const held: NoteSaveAnswer = { notice: CHANNEL_COPY.noteEditBusy, held: true };
            return prior ?? held;
          }
          const saved = yield* append(note, readAt, inputId, replaces);
          if (saved.wrote) yield* reportWrote(inputId);
          return saved.answer;
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
          const saved = yield* append(note, readAt, inputId, replaces);
          if (saved.wrote) yield* reportWrote(inputId);
          return saved.answer;
        }),
      );

    /** Runs `effect` under the writers' lock, so a notes grant is checked and recorded as one step. */
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermits(1)(effect);

    const readNotes = readChannelBotNotesTail(files.notes, NOTES_EDIT_MAX_BYTES);

    /**
     * Records a Memory tab forget refused while tasks hold a notes grant, with the line as it stands,
     * so keepRefused can put it back if those tasks remove it anyway. Call under the writers' lock.
     */
    const recordRefused = Effect.fn("channelBotNoteTabEdits.recordRefused")(function* (
      note: string,
      open: ReadonlyArray<ChannelLedger.ChannelStoredTask>,
    ) {
      const holders = open
        .filter((stored) => stored.task.notesChangeRequested !== undefined)
        .map((stored) => stored.task.taskId as string);
      const read = yield* readNotes;
      if (holders.length === 0 || read === null || read.truncated) return;
      // A forget the words could not have carried out is not one to put back later.
      const { line } = addressedNote(parseChannelBotNoteLines(decode(read.bytes)), note);
      if (line === undefined) return;
      const key = collapseNoteText(line.text);
      const prior = refused.get(key);
      refused.set(key, {
        note: line.text,
        raw: prior?.raw ?? line.raw,
        holders: new Set([...(prior?.holders ?? []), ...holders]),
      });
    });
    const recordRefusedQuietly = (
      note: string,
      open: ReadonlyArray<ChannelLedger.ChannelStoredTask>,
    ) =>
      recordRefused(note, open).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("GOAT Bot refused forget not recorded", { cause }),
        ),
      );

    /** recordRefused for a message refused elsewhere; only a whole tab forget sentence counts. */
    const refusedMessage = Effect.fn("channelBotNoteTabEdits.refusedMessage")(
      function* (message: string) {
        const request = tabRequest(message);
        if (request?.kind !== "forget") return;
        const open = yield* ledger.listTasksByStatus(OPEN_STATUSES);
        yield* recordRefusedQuietly(request.note, open);
      },
      Effect.catch((cause) => Effect.logWarning("GOAT Bot refused forget not recorded", { cause })),
    );

    /**
     * Puts back refused forgets once every task that held the grant has ended and its run stopped
     * (`runsOpen` names tasks whose run still works). A note still in force then is left alone, so a
     * later change is never undone; a missing one is appended as it stood once no grant is open.
     */
    const keepRefused = (runsOpen: ReadonlySet<string>) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (refused.size === 0) return [];
          const open = new Set(
            (yield* ledger.listTasksByStatus(OPEN_STATUSES)).map(
              (stored) => stored.task.taskId as string,
            ),
          );
          const quiet = [...refused].filter(([, record]) =>
            [...record.holders].every((task) => !open.has(task) && !runsOpen.has(task)),
          );
          if (quiet.length === 0) return [];
          const read = yield* readNotes;
          if (read?.truncated === true) return [];
          const text = read === null ? "" : decode(read.bytes);
          const inForce = new Set(
            parseChannelBotNoteLines(text)
              .filter((line) => line.replacedBy === undefined)
              .map((line) => collapseNoteText(line.text)),
          );
          const granted = yield* grantOpen;
          const kept: Array<KeptNote & { readonly raw: string }> = [];
          for (const [key, record] of quiet) {
            // Still there: nothing to put back, and a later change to it must stand.
            if (inForce.has(key)) refused.delete(key);
            else if (!granted)
              kept.push({ note: record.note, holders: [...record.holders], raw: record.raw });
          }
          if (kept.length === 0) return [];
          yield* fs.writeFileString(
            files.notes,
            appendPrefix(read !== null, text) + kept.map((note) => note.raw).join("\n") + "\n",
            { flag: "a" },
          );
          for (const note of kept) refused.delete(collapseNoteText(note.note));
          return kept.map(({ note, holders }): KeptNote => ({ note, holders }));
        }),
      );

    const change = Effect.fn("channelBotNoteTabEdits.change")(function* (
      note: string,
      next: string,
      read: NotesTail | null,
      inputId: string,
      readAt: string,
    ) {
      const text = read === null ? "" : decode(read.bytes);
      // A pass re-run after a restart finds its own line and answers as the first pass did.
      if (text.includes(noteSource(inputId))) return CHANNEL_COPY.noteChanged;
      const addressed = addressedNote(parseChannelBotNoteLines(text), note);
      if (addressed.line === undefined) return addressed.answer;
      const line = channelBotNoteLine(next, yield* noteDay(readAt), inputId, addressed.line.text);
      if (line === undefined) return CHANNEL_COPY.noteNotFound;
      // A line written since the read could take the correction's binding; start over instead.
      yield* hooks.beforeCompare ?? Effect.void;
      if (!sameRead(yield* readNotes, read)) return undefined;
      yield* fs.writeFileString(files.notes, appendPrefix(read !== null, text) + line + "\n", {
        flag: "a",
      });
      yield* reportWrote(inputId);
      return CHANNEL_COPY.noteChanged;
    });

    // Residuals, accepted: a write that lands between the compare and the rename is lost, and a
    // writer holding a copy read before the rename can write the removed words back afterwards.
    const forget = Effect.fn("channelBotNoteTabEdits.forget")(function* (
      note: string,
      original: Uint8Array,
      inputId: string,
    ) {
      const decoded = yield* Effect.try({
        try: () => strictDecoder.decode(original),
        catch: () => "not UTF-8",
      }).pipe(Effect.option);
      if (decoded._tag === "None") return CHANNEL_COPY.noteEditFailed;
      const bom = decoded.value.startsWith(BOM) ? BOM : "";
      const text = decoded.value.slice(bom.length);
      const lines = parseChannelBotNoteLines(text);
      const addressed = addressedNote(lines, note);
      if (addressed.line === undefined) return addressed.answer;
      const next = withoutNote(text, lines, addressed.line);
      if (next === "unmapped") return CHANNEL_COPY.noteEditFailed;
      if (next === "rebinds") return CHANNEL_COPY.noteForgetWouldRebind;
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
      if (check._tag === "None" || check.value === null || check.value.truncated) {
        yield* reportWrote(inputId);
        return CHANNEL_COPY.noteUnverified;
      }
      const cameBack =
        linesAmong(decode(check.value.bytes), next.removedRaws) >
        linesAmong(next.text, next.removedRaws);
      const answer = cameBack ? CHANNEL_COPY.noteCameBack : CHANNEL_COPY.noteForgotten;
      if (!sameBytes(check.value.bytes, original)) yield* reportWrote(inputId);
      return answer;
    });

    const apply = Effect.fn("channelBotNoteTabEdits.apply")(function* (
      request: TabRequest,
      inputId: string,
      readAt: string,
    ) {
      const open = yield* ledger.listTasksByStatus(OPEN_STATUSES);
      if (open.some((stored) => stored.task.notesChangeRequested !== undefined)) {
        if (request.kind === "forget") yield* recordRefusedQuietly(request.note, open);
        return CHANNEL_COPY.noteEditBusy;
      }
      // A request for this note that goes through now is the person's latest word on it.
      refused.delete(collapseNoteText(request.note));
      for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
        const read = yield* readNotes;
        if (read?.truncated === true) return CHANNEL_COPY.noteFileTooLarge;
        const answer =
          request.kind === "change"
            ? yield* change(request.note, request.next, read, inputId, readAt)
            : yield* forget(request.note, read?.bytes ?? new Uint8Array(), inputId);
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

    return {
      save,
      saveIf,
      exclusive,
      tabEdit,
      grantOpen,
      recordRefusedForget: refusedMessage,
      keepRefused,
    };
  });

/**
 * The sentence a reply gains when reception dropped a note the model asked to keep, or a notes
 * change it would not grant: neither is dropped without saying so.
 */
export const droppedNoteNotice = (refusal: string | undefined) =>
  refusal === "missing_quote" || refusal === "quote_not_in_input"
    ? CHANNEL_COPY.noteNotSaved
    : refusal === "not_linked" || refusal === "not_a_person"
      ? CHANNEL_COPY.noteEditNotAllowed
      : undefined;
