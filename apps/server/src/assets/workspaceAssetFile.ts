import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { openMediaFile } from "./MediaFile.ts";
import { isPreviewDependencyPath } from "./previewAssetExtensions.ts";

interface WorkspaceFilePath {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly previewBaseRelativePath?: string;
  readonly previewEntry?: boolean;
}

export const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

const inspectCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: WorkspaceFilePath) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.asSome,
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeedNone,
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (input.previewBaseRelativePath !== undefined) {
      const canonicalBase = yield* optionOnNotFound(
        fileSystem.realPath(path.join(canonicalRoot.value, input.previewBaseRelativePath)),
      );
      const belowBase = Option.isSome(canonicalBase)
        ? path.relative(canonicalBase.value, canonicalFile.value)
        : "..";
      const outsideBase = belowBase.startsWith("..") || path.isAbsolute(belowBase);
      if (outsideBase && !input.previewEntry) return null;
      const dependency = outsideBase ? relative : belowBase;
      if (!isPreviewDependencyPath(dependency, path)) return null;
    }

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const isServerInternalPath = yield* makeIsServerInternalPath;
    return (yield* isServerInternalPath(canonicalFile.value))
      ? null
      : { path: canonicalFile.value, root: canonicalRoot.value, info: info.value };
  },
);

export const resolveCanonicalWorkspaceFile = (input: WorkspaceFilePath) =>
  inspectCanonicalWorkspaceFile(input).pipe(Effect.map((file) => file?.path ?? null));

export const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

export const openScopedWorkspaceAsset = Effect.fn("AssetAccess.openScopedWorkspaceAsset")(
  function* (input: WorkspaceFilePath) {
    const candidate = yield* inspectCanonicalWorkspaceFile(input);
    if (candidate === null || candidate.root !== input.workspaceRoot) return null;
    const inode = Option.getOrNull(candidate.info.ino);
    if (inode === null || inode === 0n) return null;
    const file = yield* openMediaFile(
      candidate.path,
      {
        device: candidate.info.dev.toString(),
        inode: inode.toString(),
      },
      candidate.root,
    );
    return file ? { asset: { kind: "file" as const, path: candidate.path }, file } : null;
  },
  (effect, input) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Could not open scoped workspace asset.", { ...input, cause }),
      ),
      Effect.orElseSucceed(() => null),
    ),
);
