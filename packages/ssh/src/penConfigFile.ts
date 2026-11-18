// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem cannot open with O_NONBLOCK.
import * as NodeFS from "node:fs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

// Pen writes one Host block per member: a name and login user of at most 32 bytes each, about
// 130 fixed bytes and three local paths. A mesh holds at most 4096 records, so at most 4096
// members; 1 KiB a block leaves the paths about 800 bytes, so 4 MiB covers any mesh.
export const PEN_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
const PEN_CONFIG_CHUNK = 64 * 1024;
// Opening a FIFO for reading would wait for a writer and hold a pool thread; O_NONBLOCK returns at
// once, and the handle's own stat then refuses anything but a regular file. Windows has no FIFOs.
const PEN_OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);
// A file read on the Pen path that has not finished by then counts as failed, never as pending.
export const PEN_READ_TIMEOUT = "5 seconds";

class PenConfigReadError extends Data.TaggedError("PenConfigReadError")<{
  readonly failure: "tooLarge" | "notRegular" | "unread";
}> {}

const unread = new PenConfigReadError({ failure: "unread" });
const notRegular = new PenConfigReadError({ failure: "notRegular" });
const tooLarge = new PenConfigReadError({ failure: "tooLarge" });

/** Pen's ssh config at `file`, or "" when there is none, read through a non-blocking handle within a cap. */
export const readPenConfig = Effect.fn("readPenConfig")(
  function* (fs: FileSystem.FileSystem, file: string) {
    const found = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isNone(found)) return (yield* fs.exists(file)) ? yield* unread : "";
    if (found.value.type !== "File") return yield* notRegular;
    if (found.value.size > BigInt(PEN_CONFIG_MAX_BYTES)) return yield* tooLarge;
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFS.promises.open(file, PEN_OPEN_FLAGS),
        catch: () => unread,
      }),
      (handle) =>
        Effect.gen(function* () {
          const info = yield* Effect.tryPromise({
            try: () => handle.stat({ bigint: true }),
            catch: () => unread,
          });
          if (!info.isFile()) return yield* notRegular;
          const chunks: Buffer[] = [];
          let size = 0;
          while (size <= PEN_CONFIG_MAX_BYTES) {
            const chunk = Buffer.alloc(PEN_CONFIG_CHUNK);
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(chunk, 0, PEN_CONFIG_CHUNK, null),
              catch: () => unread,
            });
            if (bytesRead === 0) break;
            chunks.push(chunk.subarray(0, bytesRead));
            size += bytesRead;
          }
          if (size > PEN_CONFIG_MAX_BYTES) return yield* tooLarge;
          return Buffer.concat(chunks).toString("utf8");
        }),
      (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
    );
  },
  Effect.timeout(PEN_READ_TIMEOUT),
  Effect.mapError((error) => (error instanceof PenConfigReadError ? error : unread)),
);
