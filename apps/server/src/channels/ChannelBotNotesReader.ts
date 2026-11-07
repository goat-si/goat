/**
 * Reads GOAT Bot's notes file for the Memory tab. The file is the one reception appends to and
 * workers edit by hand (channelBotNotes.ts); this module only reads it.
 *
 * @module ChannelBotNotesReader
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the revision matches channelNotesRevision's sha-256.
import * as NodeCrypto from "node:crypto";

import {
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelGatewayError,
  type ChannelBotNote,
  type ChannelListBotNotesResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

export interface ReaderOptions {
  /** Runs between the first stat and the read, so a test can change the file there. */
  readonly afterStat?: Effect.Effect<void>;
}

export class ChannelBotNotesReader extends Context.Service<
  ChannelBotNotesReader,
  { readonly list: Effect.Effect<ChannelListBotNotesResult, ChannelGatewayError> }
>()("goat/channels/ChannelBotNotesReader") {}

export const make = Effect.fn("ChannelBotNotesReader.make")(function* (
  options: ReaderOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const files = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir);
  const afterStat = options.afterStat ?? Effect.void;

  // Reads the newest part of the file through one handle and retries when the file changed
  // meanwhile, so the bytes and their revision come from one version of the file.
  const readTail = Effect.fn("ChannelBotNotesReader.readTail")(function* (file: FileSystem.File) {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const before = yield* file.stat;
      if (before.type !== "File") return yield* failed();
      yield* afterStat;
      const size = Number(before.size);
      const start = Math.max(0, size - TAIL_BYTES - 1);
      const buffer = new Uint8Array(size - start);
      let filled = 0;
      while (filled < buffer.length) {
        const read = yield* file.read(buffer.subarray(filled), {
          position: BigInt(start + filled),
        });
        if (read === 0) break;
        filled += read;
      }
      const after = yield* file.stat;
      const unchanged =
        filled === buffer.length &&
        after.size === before.size &&
        Option.getOrUndefined(after.mtime)?.getTime() ===
          Option.getOrUndefined(before.mtime)?.getTime();
      if (unchanged) return { bytes: wholeLines(buffer, start > 0), truncated: start > 0 };
    }
    return yield* failed();
  });

  const list = Effect.fn("ChannelBotNotesReader.list")(function* () {
    yield* home.requireHome;
    const read = yield* Effect.scoped(
      fs.open(files.notes, { flag: "r" }).pipe(Effect.flatMap(readTail)),
    ).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(failed()),
      }),
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
