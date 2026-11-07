/**
 * Reads GOAT Bot's notes file for the Memory tab. The file is the one reception appends to and
 * workers edit by hand (channelBotNotes.ts); this module only reads it.
 *
 * @module ChannelBotNotesReader
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the revision matches channelNotesRevision's sha-256.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem cannot open with O_NONBLOCK.
import * as NodeFS from "node:fs";

import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelGatewayError,
  type ChannelBotNote,
  type ChannelListBotNotesResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import { channelBotFilesFor, NOTES_HEADER } from "./channelBotNotes.ts";

const TAIL_BYTES = 64 * 1024;
const READ_ATTEMPTS = 3;
const NEWLINE = 0x0a;
// The writer removes only whitespace from the input id, so the id runs to the closing parenthesis
// at the end of the line.
const DATED_LINE = /^- (\d{4}-\d{2}-\d{2}): (.+?)(?: \(asked in \S+\))?$/u;

/** The lines of a notes file, oldest first, without the header, blank lines or headings. */
const parseChannelBotNotes = (text: string): ReadonlyArray<ChannelBotNote> => {
  const normal = text.replaceAll("\r\n", "\n");
  const body = normal.startsWith(NOTES_HEADER) ? normal.slice(NOTES_HEADER.length) : normal;
  const notes: Array<ChannelBotNote> = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const dated = DATED_LINE.exec(line);
    const date = dated?.[1];
    const noteText = dated?.[2];
    notes.push(
      date !== undefined && noteText !== undefined
        ? { index: notes.length, date, text: noteText }
        : { index: notes.length, date: null, text: line.replace(/^[-*]\s+/u, "") },
    );
  }
  return notes;
};

/**
 * Bytes from the start of the first whole line. `withLead` means the read began one byte before
 * the tail, so a tail that starts on a line boundary keeps its first line.
 */
const wholeLines = (bytes: Uint8Array, withLead: boolean) => {
  if (!withLead) return bytes;
  const end = bytes.indexOf(NEWLINE);
  return end === -1 ? new Uint8Array() : bytes.subarray(end + 1);
};

const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
// Opening a FIFO for reading would wait for a writer and hold a pool thread; O_NONBLOCK returns at
// once, and the handle's own stat then refuses anything but a regular file. Windows has no FIFOs.
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export interface ReaderOptions {
  /** Runs between the first stat and the read, so a test can change the file there. */
  readonly afterStat?: Effect.Effect<void>;
  /** Runs between the two reads of one attempt. */
  readonly afterRead?: Effect.Effect<void>;
}

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

export class ChannelBotNotesReader extends Context.Service<
  ChannelBotNotesReader,
  { readonly list: Effect.Effect<ChannelListBotNotesResult, ChannelGatewayError> }
>()("goat/channels/ChannelBotNotesReader") {}

export const make = Effect.fn("ChannelBotNotesReader.make")(function* (
  options: ReaderOptions = {},
) {
  const path = yield* Path.Path;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  const afterStat = options.afterStat ?? Effect.void;
  const afterRead = options.afterRead ?? Effect.void;

  const stat = (file: NodeFS.promises.FileHandle) =>
    Effect.tryPromise({ try: () => file.stat({ bigint: true }), catch: failed });

  const readRange = Effect.fn("ChannelBotNotesReader.readRange")(function* (
    file: NodeFS.promises.FileHandle,
    start: number,
    length: number,
  ) {
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = yield* Effect.tryPromise({
        try: () => file.read(buffer, filled, length - filled, start + filled),
        catch: failed,
      });
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  });

  // Reads the newest part twice through one handle and retries unless both reads and both stats
  // agree: a write during the first read leaves it torn, and the second read then differs even
  // when the write kept the size and the mtime.
  const readTail = Effect.fn("ChannelBotNotesReader.readTail")(function* (
    file: NodeFS.promises.FileHandle,
  ) {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const before = yield* stat(file);
      if (!before.isFile()) return yield* failed();
      yield* afterStat;
      const size = Number(before.size);
      const truncated = size > TAIL_BYTES;
      const start = truncated ? size - TAIL_BYTES - 1 : 0;
      const first = yield* readRange(file, start, size - start);
      yield* afterRead;
      const second = yield* readRange(file, start, size - start);
      const after = yield* stat(file);
      const unchanged =
        first.length === size - start &&
        sameBytes(first, second) &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs;
      if (unchanged) return { bytes: wholeLines(first, truncated), truncated };
    }
    return yield* failed();
  });

  const list = Effect.fn("ChannelBotNotesReader.list")(function* () {
    yield* home.requireHome;
    const read = yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            NodeFS.promises.open(files.notes, OPEN_FLAGS).then(Option.some, (cause: unknown) => {
              if (isMissing(cause)) return Option.none<NodeFS.promises.FileHandle>();
              throw cause;
            }),
          catch: failed,
        }),
        (file) =>
          Option.match(file, {
            onNone: () => Effect.void,
            onSome: (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
          }),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(null),
            onSome: readTail,
          }),
        ),
      ),
    );
    if (read === null) return { revision: null, notes: [], truncated: false };
    const notes = parseChannelBotNotes(new TextDecoder().decode(read.bytes));
    return {
      revision: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      notes: notes.toReversed(),
      truncated: read.truncated,
    };
  });

  return ChannelBotNotesReader.of({ list: list() });
});

export const layer = Layer.effect(ChannelBotNotesReader, make());

export const rpcHandlers = (service: ChannelBotNotesReader["Service"]) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotNotes]: () => service.list,
});
