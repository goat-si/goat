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
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";
import { parseChannelBotNoteLines, type ChannelBotNoteLine } from "./channelBotNoteLines.ts";
import { channelBotNoteSources } from "./channelBotNoteSources.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

const TAIL_BYTES = 64 * 1024;
const READ_ATTEMPTS = 3;
const NEWLINE = 0x0a;

/** Every line read, replaced ones included and marked, so a client can show or hide them. */
const toNotes = (
  lines: ReadonlyArray<ChannelBotNoteLine>,
  sourceOf: (inputId: string) => NonNullable<ChannelBotNote["source"]>,
): ReadonlyArray<ChannelBotNote> =>
  lines.map(({ index, date, text, replaces, replacedBy, sourceInputId }) => ({
    index,
    date,
    text,
    ...(replaces === undefined ? {} : { replaces }),
    ...(replacedBy === undefined ? {} : { replacedBy }),
    ...(sourceInputId === undefined ? {} : { source: sourceOf(sourceInputId) }),
  }));

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
  {
    readonly list: (
      viewer: ChannelConnectionOwner,
    ) => Effect.Effect<ChannelListBotNotesResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotNotesReader") {}

export const make = Effect.fn("ChannelBotNotesReader.make")(function* (
  options: ReaderOptions = {},
) {
  const path = yield* Path.Path;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const sql = yield* SqlClient.SqlClient;
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

  const list = Effect.fn("ChannelBotNotesReader.list")(function* (viewer: ChannelConnectionOwner) {
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
    const lines = parseChannelBotNoteLines(new TextDecoder().decode(read.bytes));
    const sourceOf = yield* channelBotNoteSources(
      viewer,
      lines.flatMap((line) => (line.sourceInputId === undefined ? [] : [line.sourceInputId])),
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const notes = toNotes(lines, sourceOf);
    return {
      revision: NodeCrypto.createHash("sha256").update(read.bytes).digest("hex"),
      notes: notes.toReversed(),
      truncated: read.truncated,
    };
  });

  return ChannelBotNotesReader.of({ list });
});

export const layer = Layer.effect(ChannelBotNotesReader, make());

export const rpcHandlers = (
  service: ChannelBotNotesReader["Service"],
  viewer: ChannelConnectionOwner,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotNotes]: () => service.list(viewer),
});
