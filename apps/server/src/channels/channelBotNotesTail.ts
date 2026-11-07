/**
 * The newest part of GOAT Bot's notes file, read without trusting the path: a FIFO or other
 * non-regular file is refused at once, and a read that a concurrent write tore is read again.
 * The Memory tab and every reader that shows notes to the bot share it.
 *
 * @module channelBotNotesTail
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem cannot open with O_NONBLOCK.
import * as NodeFS from "node:fs";

import { ChannelGatewayError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const READ_ATTEMPTS = 3;
const NEWLINE = 0x0a;

const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
// Opening a FIFO for reading would wait for a writer and hold a pool thread; O_NONBLOCK returns at
// once, and the handle's own stat then refuses anything but a regular file. Windows has no FIFOs.
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export interface NotesTailHooks {
  /** Runs between the first stat and the read, so a test can change the file there. */
  readonly afterStat?: Effect.Effect<void>;
  /** Runs between the two reads of one attempt. */
  readonly afterRead?: Effect.Effect<void>;
}

export interface NotesTail {
  readonly bytes: Uint8Array;
  /** Whether older lines before the part read were left out. */
  readonly truncated: boolean;
}

/**
 * Bytes from the start of the first whole line. `withLead` means the read began one byte before
 * the tail, so a tail that starts on a line boundary keeps its first line.
 */
const wholeLines = (bytes: Uint8Array, withLead: boolean) => {
  if (!withLead) return bytes;
  const end = bytes.indexOf(NEWLINE);
  return end === -1 ? new Uint8Array() : bytes.subarray(end + 1);
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
};

const stat = (file: NodeFS.promises.FileHandle) =>
  Effect.tryPromise({ try: () => file.stat({ bigint: true }), catch: failed });

const readRange = Effect.fn("channelBotNotesTail.readRange")(function* (
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
const readTail = Effect.fn("channelBotNotesTail.readTail")(function* (
  file: NodeFS.promises.FileHandle,
  tailBytes: number,
  hooks: NotesTailHooks,
) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const before = yield* stat(file);
    if (!before.isFile()) return yield* failed();
    yield* hooks.afterStat ?? Effect.void;
    const size = Number(before.size);
    const truncated = size > tailBytes;
    const start = truncated ? size - tailBytes - 1 : 0;
    const first = yield* readRange(file, start, size - start);
    yield* hooks.afterRead ?? Effect.void;
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

/** The newest `tailBytes` of the notes file from a whole line, or null when there is no file. */
export const readChannelBotNotesTail = (
  notesPath: string,
  tailBytes: number,
  hooks: NotesTailHooks = {},
): Effect.Effect<NotesTail | null, ChannelGatewayError> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          NodeFS.promises.open(notesPath, OPEN_FLAGS).then(Option.some, (cause: unknown) => {
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
          onSome: (handle) => readTail(handle, tailBytes, hooks),
        }),
      ),
    ),
  );
