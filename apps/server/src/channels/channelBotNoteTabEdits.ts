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
  noteDay,
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
// A note named by its line's id, right after its quoted words (goatBotForgetNoteMessage).
const NAMED = /^ \(note ([0-9a-f]{12})\)/u;

type TabRequest =
  | { readonly kind: "forget"; readonly note: string; readonly id?: string }
  | { readonly kind: "change"; readonly note: string; readonly next: string; readonly id?: string };

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

/** The quoted note starting at `from`, with the line id that may follow it. */
const namedNoteAt = (text: string, from: number) => {
  const note = jsonStringAt(text, from);
  if (note === undefined) return undefined;
  const named = NAMED.exec(text.slice(note.end, note.end + 20));
  const id = named?.[1];
  return id === undefined
    ? note
    : { value: note.value, end: note.end + (named?.[0].length ?? 0), id };
};

/** The Memory tab's sentences, recognised only when they are the whole message. */
const tabRequest = (text: string): TabRequest | undefined => {
  const message = text.trim();
  if (message.startsWith(FORGET_PREFIX)) {
    const note = namedNoteAt(message, FORGET_PREFIX.length);
    return note?.end === message.length && note.value !== ""
      ? { kind: "forget", note: note.value, ...("id" in note ? { id: note.id } : {}) }
      : undefined;
  }
  if (!message.startsWith(CHANGE_PREFIX)) return undefined;
  const note = namedNoteAt(message, CHANGE_PREFIX.length);
  if (note === undefined || !message.startsWith(CHANGE_TO, note.end)) return undefined;
  const next = jsonStringAt(message, note.end + CHANGE_TO.length);
  return next?.end === message.length && next.value.trim() !== ""
    ? {
        kind: "change",
        note: note.value,
        next: next.value,
        ...("id" in note ? { id: note.id } : {}),
      }
    : undefined;
};

/**
 * The note a request names: by its line's id when it carries one, which must still read the
 * quoted words; otherwise the oldest note in force with those words.
 */
const targetOf = (lines: ReadonlyArray<ChannelBotNoteLine>, note: string, id?: string) =>
  id === undefined
    ? lines.find((line) => line.replacedBy === undefined && line.text === note)
    : lines.findLast(
        (line) => line.replacedBy === undefined && line.id === id && line.text === note,
      );

// Refused forgets are kept by the line they named, or by their words for a request without one.
const refusedKey = (note: string, id: string | undefined) =>
  id === undefined ? "text:" + collapseNoteText(note) : "line:" + id;

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
  readonly key: string;
  readonly note: string;
  readonly raw: string;
  readonly holders: ReadonlySet<string>;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// A forget rewrites the file, so it keeps a byte order mark and refuses bytes that are not UTF-8.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = "\uFEFF";

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** The parsed notes mapped back onto the file's physical lines; undefined when they disagree. */
const rewriteLines = (
  fileText: string,
  lines: ReadonlyArray<ChannelBotNoteLine>,
  replace: (line: ChannelBotNoteLine, physical: string) => string,
) => {
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
    physical[at] = replace(line, physical[at] ?? "");
  }
  return index === lines.length ? physical.join("") : undefined;
};

/** The lines a note replaced, and the ones those replaced, by the index of each line. */
const earlierVersions = (lines: ReadonlyArray<ChannelBotNoteLine>) => {
  const replacedLines = new Map<number, Array<number>>();
  for (const line of lines) {
    if (line.replacedBy === undefined) continue;
    const list = replacedLines.get(line.replacedBy);
    if (list === undefined) replacedLines.set(line.replacedBy, [line.index]);
    else list.push(line.index);
  }
  return replacedLines;
};

/**
 * The file without the note `text`: its lines, every earlier line they replaced, every other line
 * with a removed text, and replaces markers that quote a removed text. Every other byte is kept.
 */
const withoutNote = (fileText: string, lines: ReadonlyArray<ChannelBotNoteLine>, text: string) => {
  // Indexed both ways, so a long correction chain is walked once instead of once per link.
  const byText = new Map<string, Array<number>>();
  const replacedLines = earlierVersions(lines);
  for (const line of lines) {
    const key = collapseNoteText(line.text);
    const list = byText.get(key);
    if (list === undefined) byText.set(key, [line.index]);
    else list.push(line.index);
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
  const next = rewriteLines(fileText, lines, (line, physical) =>
    removed.has(line.index)
      ? ""
      : line.replaces !== undefined && removedTexts.has(collapseNoteText(line.replaces))
        ? physical.replace(line.raw, withoutReplacesMarker(line.raw))
        : physical,
  );
  return next === undefined
    ? undefined
    : { text: next, cameBack: (after: string) => stillThere(after, removedTexts) };
};

/**
 * The file without one named note and the earlier versions it replaced. Other notes with the same
 * words stay, and every remaining correction replaces what it did: the named note is in force, and
 * each earlier version was replaced by a line removed with it.
 */
const withoutLine = (
  fileText: string,
  lines: ReadonlyArray<ChannelBotNoteLine>,
  target: ChannelBotNoteLine,
) => {
  const replacedLines = earlierVersions(lines);
  const removed = new Set<number>();
  const queue = [target.index];
  for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
    if (removed.has(index)) continue;
    removed.add(index);
    queue.push(...(replacedLines.get(index) ?? []));
  }
  const next = rewriteLines(fileText, lines, (line, physical) =>
    removed.has(line.index) ? "" : physical,
  );
  const copies = (text: string) =>
    parseChannelBotNoteLines(text).filter((line) => line.raw === target.raw).length;
  const before = copies(fileText);
  return next === undefined
    ? undefined
    : { text: next, cameBack: (after: string) => copies(after) >= before };
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
    // Forgets refused while a grant was open, by note text. In memory: a restart forgets them.
    const refused = new Map<string, RefusedForget>();
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
        Effect.map(({ correction, wrote }) => ({
          notice: correction === "unmatched" ? CHANNEL_COPY.noteCorrectionUnmatched : undefined,
          wrote,
        })),
        Effect.catch((cause) =>
          Effect.logWarning("GOAT Bot note was not saved", { cause }).pipe(
            Effect.as({ notice: CHANNEL_COPY.noteNotSaved, wrote: false }),
          ),
        ),
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
          const saved = yield* append(note, readAt, inputId, replaces);
          if (saved.wrote) yield* reportWrote(inputId);
          return saved.notice;
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
          return { notice: saved.notice };
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
      id: string | undefined,
    ) {
      const holders = open
        .filter((stored) => stored.task.notesChangeRequested !== undefined)
        .map((stored) => stored.task.taskId as string);
      const read = yield* readNotes;
      if (holders.length === 0 || read === null || read.truncated) return;
      const lines = parseChannelBotNoteLines(decode(read.bytes));
      const line =
        id === undefined
          ? lines.findLast(
              (candidate) => candidate.replacedBy === undefined && candidate.text === note,
            )
          : targetOf(lines, note, id);
      if (line === undefined) return;
      const key = refusedKey(line.text, id);
      const prior = refused.get(key);
      refused.set(key, {
        key,
        note: line.text,
        raw: prior?.raw ?? line.raw,
        holders: new Set([...(prior?.holders ?? []), ...holders]),
      });
    });
    const recordRefusedQuietly = (
      note: string,
      open: ReadonlyArray<ChannelLedger.ChannelStoredTask>,
      id: string | undefined,
    ) =>
      recordRefused(note, open, id).pipe(
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
        yield* recordRefusedQuietly(request.note, open, request.id);
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
              .flatMap((line) => [
                refusedKey(line.text, undefined),
                refusedKey(line.text, line.id),
              ]),
          );
          const granted = yield* grantOpen;
          const kept: Array<KeptNote & { readonly raw: string; readonly key: string }> = [];
          for (const [key, record] of quiet) {
            // Still there: nothing to put back, and a later change to it must stand.
            if (inForce.has(key)) refused.delete(key);
            else if (!granted)
              kept.push({ note: record.note, holders: [...record.holders], raw: record.raw, key });
          }
          if (kept.length === 0) return [];
          yield* fs.writeFileString(
            files.notes,
            appendPrefix(read !== null, text) + kept.map((note) => note.raw).join("\n") + "\n",
            { flag: "a" },
          );
          for (const note of kept) refused.delete(note.key);
          return kept.map(({ note, holders }): KeptNote => ({ note, holders }));
        }),
      );

    /**
     * Replaces memory.md with `next` only if it still holds `original`; false when it changed.
     * Staged under a fresh name created exclusively, so no existing file or link is ever written.
     */
    const replaceFile = Effect.fn("channelBotNoteTabEdits.replaceFile")(function* (
      original: Uint8Array,
      next: string,
    ) {
      const mode = (yield* fs.stat(files.notes)).mode;
      const staged = files.notes + ".edit-" + NodeCrypto.randomUUID();
      let created = false;
      return yield* Effect.gen(function* () {
        yield* fs.writeFileString(staged, next, { flag: "wx" });
        created = true;
        yield* fs.chmod(staged, mode & 0o777);
        yield* hooks.beforeCompare ?? Effect.void;
        const current = yield* readNotes;
        if (current === null || !sameBytes(current.bytes, original)) return false;
        yield* fs.rename(staged, files.notes);
        return true;
      }).pipe(Effect.onExit(() => (created ? fs.remove(staged).pipe(Effect.ignore) : Effect.void)));
    });

    /** The file's text and byte order mark, or undefined for bytes that are not UTF-8. */
    const strictText = (original: Uint8Array) =>
      Effect.try({ try: () => strictDecoder.decode(original), catch: () => "not UTF-8" }).pipe(
        Effect.option,
        Effect.map((decoded) => {
          if (decoded._tag === "None") return undefined;
          const bom = decoded.value.startsWith(BOM) ? BOM : "";
          return { bom, text: decoded.value.slice(bom.length) };
        }),
      );

    /**
     * A change appends the new note with a marker that replaces the newest note in force with the
     * quoted words. When the request names an older one, that line first moves to the end, so the
     * marker replaces it and every other note keeps its place and meaning. Undefined when the file
     * changed during that rewrite.
     */
    const change = Effect.fn("channelBotNoteTabEdits.change")(function* (
      request: Extract<TabRequest, { kind: "change" }>,
      original: Uint8Array,
      exists: boolean,
      inputId: string,
      readAt: string,
    ) {
      const { note, next, id } = request;
      const text = decode(original);
      // A pass re-run after a restart finds its own line and answers as the first pass did.
      if (text.includes(noteSource(inputId))) return CHANNEL_COPY.noteChanged;
      const lines = parseChannelBotNoteLines(text);
      const target = targetOf(lines, note, id);
      const line =
        target === undefined
          ? undefined
          : channelBotNoteLine(next, yield* noteDay(readAt), inputId, note);
      if (target === undefined || line === undefined) return CHANNEL_COPY.noteNotFound;
      const words = collapseNoteText(target.text);
      const newest = lines.findLast(
        (other) => other.replacedBy === undefined && collapseNoteText(other.text) === words,
      );
      if (newest === target || id === undefined) {
        yield* fs.writeFileString(files.notes, appendPrefix(exists, text) + line + "\n", {
          flag: "a",
        });
      } else {
        const decoded = yield* strictText(original);
        if (decoded === undefined) return CHANNEL_COPY.noteEditFailed;
        const rest = rewriteLines(
          decoded.text,
          parseChannelBotNoteLines(decoded.text),
          (other, physical) => (other.index === target.index ? "" : physical),
        );
        if (rest === undefined) return CHANNEL_COPY.noteEditFailed;
        const moved = rest + appendPrefix(true, rest) + target.raw + "\n" + line + "\n";
        if (!(yield* replaceFile(original, decoded.bom + moved))) return undefined;
      }
      yield* reportWrote(inputId);
      return CHANNEL_COPY.noteChanged;
    });

    // Residuals, accepted: a write that lands between the compare and the rename is lost, and a
    // writer holding a copy read before the rename can write the removed words back afterwards.
    const forget = Effect.fn("channelBotNoteTabEdits.forget")(function* (
      request: Extract<TabRequest, { kind: "forget" }>,
      original: Uint8Array,
      inputId: string,
    ) {
      const decoded = yield* strictText(original);
      if (decoded === undefined) return CHANNEL_COPY.noteEditFailed;
      const { bom, text } = decoded;
      const lines = parseChannelBotNoteLines(text);
      const target = targetOf(lines, request.note, request.id);
      if (target === undefined) return CHANNEL_COPY.noteNotFound;
      const next =
        request.id === undefined
          ? withoutNote(text, lines, target.text)
          : withoutLine(text, lines, target);
      if (next === undefined) return CHANNEL_COPY.noteEditFailed;
      if (!(yield* replaceFile(original, bom + next.text))) return undefined;
      yield* hooks.afterRename ?? Effect.void;
      const check = yield* readNotes.pipe(Effect.option);
      if (check._tag === "None" || check.value === null || check.value.truncated) {
        yield* reportWrote(inputId);
        return CHANNEL_COPY.noteUnverified;
      }
      const answer = next.cameBack(decode(check.value.bytes))
        ? CHANNEL_COPY.noteCameBack
        : CHANNEL_COPY.noteForgotten;
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
        if (request.kind === "forget") yield* recordRefusedQuietly(request.note, open, request.id);
        return CHANNEL_COPY.noteEditBusy;
      }
      // A request for this note that goes through now is the person's latest word on it.
      refused.delete(refusedKey(request.note, request.id));
      for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
        const read = yield* readNotes;
        if (read?.truncated === true) return CHANNEL_COPY.noteFileTooLarge;
        const original = read?.bytes ?? new Uint8Array();
        const answer =
          request.kind === "change"
            ? yield* change(request, original, read !== null, inputId, readAt)
            : yield* forget(request, original, inputId);
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
