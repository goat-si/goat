// @effect-diagnostics nodeBuiltinImport:off -- bounded directory traversal and identity checks use native asynchronous IO.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { stalePendingAttachmentAge } from "../attachmentStore.ts";
import type { SweepFileOutcome } from "./AttachmentFileLeases.ts";

type Directory = {
  readonly read: () => Promise<{ readonly name: string } | null>;
  readonly close: () => Promise<void>;
};
export type SweepFileSystem = {
  readonly open: (directory: string) => Promise<Directory>;
  readonly lstat: (file: string) => Promise<{
    readonly dev: number;
    readonly ino: number;
    readonly mtimeMs: number;
    readonly size: number;
    readonly isFile: () => boolean;
    readonly isSymbolicLink: () => boolean;
  }>;
  readonly unlink: (file: string) => Promise<void>;
};

export const nodeSweepFileSystem: SweepFileSystem = {
  open: (directory) => NodeFSP.opendir(directory, { bufferSize: 32 }),
  lstat: (file) => NodeFSP.lstat(file),
  unlink: (file) => NodeFSP.unlink(file),
};

export function makeSweepCursor(input: {
  readonly attachmentsDir: string;
  readonly withInactiveFile: (
    file: string,
    remove: Effect.Effect<SweepFileOutcome>,
  ) => Effect.Effect<SweepFileOutcome>;
  readonly fileSystem?: SweepFileSystem;
}) {
  const fs = input.fileSystem ?? nodeSweepFileSystem;
  let directory: Directory | undefined;
  let poisoned = false;
  const close = Effect.fn("PendingAttachmentSweepCursor.close")(function* () {
    const current = directory;
    if (current === undefined) return;
    poisoned = true;
    yield* Effect.tryPromise(() => current.close());
    directory = undefined;
    poisoned = false;
  }, Effect.uninterruptible)();
  const step = Effect.fn("PendingAttachmentSweepCursor.step")(function* (nowMs: number) {
    let visited = 0;
    let deleted = 0;
    let keptUnknown = 0;
    let complete = false;
    let closing = false;
    const scan = Effect.gen(function* () {
      if (poisoned) {
        closing = true;
        yield* close;
        closing = false;
      }
      if (directory === undefined) {
        yield* Effect.tryPromise(() => fs.open(input.attachmentsDir)).pipe(
          Effect.tap((opened) =>
            Effect.sync(() => {
              directory = opened;
            }),
          ),
          Effect.uninterruptible,
        );
      }
      const current = directory;
      if (current === undefined) return;
      while (visited < 512) {
        const entry = yield* Effect.tryPromise(() => current.read()).pipe(Effect.uninterruptible);
        if (entry === null) {
          closing = true;
          yield* close;
          closing = false;
          complete = true;
          break;
        }
        visited++;
        const age = stalePendingAttachmentAge(entry.name);
        if (age === undefined) continue;
        const file = resolveAttachmentRelativePath({
          attachmentsDir: input.attachmentsDir,
          relativePath: entry.name,
        });
        if (file === null) {
          keptUnknown++;
          continue;
        }
        const remove = Effect.promise(async (): Promise<SweepFileOutcome> => {
          const before = await fs.lstat(file);
          if (!before.isFile() || before.isSymbolicLink()) return "kept";
          if (!(nowMs - before.mtimeMs > age)) return "kept";
          const after = await fs.lstat(file);
          if (
            !after.isFile() ||
            after.isSymbolicLink() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== after.size
          )
            return "unknown";
          await fs.unlink(file);
          return "deleted";
        });
        const outcome = yield* input.withInactiveFile(file, remove).pipe(
          Effect.uninterruptible,
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.succeed("unknown" as const),
          ),
        );
        if (outcome === "deleted") deleted++;
        else if (outcome === "unknown") keptUnknown++;
      }
    });
    yield* scan.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        keptUnknown++;
        if (closing) return Effect.void;
        return close.pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              keptUnknown++;
            }),
          ),
        );
      }),
    );
    return { visited, deleted, keptUnknown, complete };
  });
  return { step, close };
}
