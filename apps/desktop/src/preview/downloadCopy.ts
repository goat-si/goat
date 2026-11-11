// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.copyFile cannot request an exclusive copy.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

const MAX_NAME_ATTEMPTS = 100;

interface DownloadCopyOptions<E> {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly directory: string;
  readonly source: string;
  readonly fileName: string;
  readonly onError: (cause: unknown) => E;
  readonly reveal: (target: string) => void;
}

const errorCode = (error: unknown): unknown => {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error) return error.code;
  if ("cause" in error) {
    const cause = error.cause;
    if (typeof cause === "object" && cause !== null && "code" in cause) return cause.code;
  }
  return undefined;
};

const isAlreadyThere = (error: unknown): boolean => errorCode(error) === "EEXIST";

// Two downloads that pick the same name race between the existence check and the copy, so the
// copy itself must claim the name: exactly one wins and the other retries with a numbered name.
export const copyDownload = Effect.fn("PreviewDownloadCopy.copy")(function* <E>({
  fileSystem,
  path,
  directory,
  source,
  fileName,
  onError,
  reveal,
}: DownloadCopyOptions<E>) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension) || "download";
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const target = path.join(
      directory,
      attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`,
    );
    if (yield* fileSystem.exists(target)) continue;
    const copied = yield* Effect.tryPromise({
      try: () => NodeFSP.copyFile(source, target, NodeFSP.constants.COPYFILE_EXCL),
      catch: onError,
    }).pipe(
      Effect.as(true),
      Effect.catchIf(isAlreadyThere, () => Effect.succeed(false)),
    );
    if (!copied) continue;
    reveal(target);
    return;
  }
});
