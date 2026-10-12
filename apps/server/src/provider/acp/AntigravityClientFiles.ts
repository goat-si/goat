import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

/**
 * Workspace file access requested through the ACP client `fs` capability.
 * The agent gates each write behind `session/request_permission`, so only
 * path containment is checked here.
 */
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  // Compare the first segment, so a folder named `..cache` stays inside.
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Resolves an agent-supplied path and rejects anything outside the session
 * roots. Symlinks resolve before the check, including the final component, so
 * a link inside the workspace cannot read or write through to a file outside
 * it. A new path resolves through its nearest existing ancestor, so missing
 * directories under a link still land where the link points, and a workspace
 * reached through a symlink (macOS `/var` -> `/private/var`) compares equal to
 * its resolved roots. An entry that exists but cannot be resolved, like a
 * dangling link, is rejected rather than written through.
 */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    let existing = path.resolve(input.requestPath);
    const missing: Array<string> = [];
    let real: string;
    while (true) {
      const resolvedExisting = yield* input.fileSystem.realPath(existing).pipe(Effect.option);
      if (Option.isSome(resolvedExisting)) {
        real = path.join(resolvedExisting.value, ...missing);
        break;
      }
      // Only missing entries (a new write) fall back to their parent; a
      // dangling or unreadable link must not be followed on write.
      const entryExists = yield* input.fileSystem.readLink(existing).pipe(
        Effect.as(true),
        Effect.catch(() => input.fileSystem.exists(existing)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(existing);
      if (entryExists || parent === existing) return yield* outside;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    if (!roots.some((root) => isInsideRoot(path, root, real))) {
      return yield* outside;
    }
    return { filePath: real, existingAncestor: path.join(real, ...missing.map(() => "..")) };
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const { filePath } = yield* resolveClientFilePath({
      ...input,
      requestPath: input.request.path,
    });
    const info = yield* input.fileSystem
      .stat(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.resourceNotFound(
            `File '${input.request.path}' not found.`,
          ),
        ),
      );
    if (info.type !== "File" || Number(info.size) > CLIENT_FILE_MAX_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
      );
    }
    const text = yield* input.fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.internalError(`Could not read '${input.request.path}'.`),
        ),
      );
    const line = input.request.line ?? undefined;
    const limit = input.request.limit ?? undefined;
    if (line === undefined && limit === undefined) {
      return { content: text };
    }
    // ACP lines are 1-indexed. `limit` is a line count.
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    return { content: lines.slice(start, end).join("\n") };
  },
);

export const writeAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.writeTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.WriteTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
    const { fileSystem, path } = input;
    const { filePath, existingAncestor } = yield* resolveClientFilePath({
      ...input,
      requestPath: input.request.path,
    });
    const directory = path.dirname(filePath);
    const failed = EffectAcpErrors.AcpRequestError.internalError(
      `Could not write '${input.request.path}'.`,
    );
    // Another process can swap a checked directory for a symlink before the
    // write. Each step re-resolves the directory and refuses to continue if it
    // no longer resolves to the checked location.
    const ensureUnmoved = (dir: string) =>
      fileSystem.realPath(dir).pipe(
        Effect.mapError(() => failed),
        Effect.flatMap((resolved) =>
          resolved === dir
            ? Effect.void
            : EffectAcpErrors.AcpRequestError.invalidParams(
                `Path '${input.request.path}' is outside the session workspace.`,
              ),
        ),
      );
    if (existingAncestor !== filePath) {
      let current = existingAncestor;
      for (const segment of path.relative(existingAncestor, directory).split(path.sep)) {
        if (segment === "") continue;
        current = path.join(current, segment);
        yield* fileSystem.makeDirectory(current).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(failed),
          }),
        );
        yield* ensureUnmoved(current);
      }
    }
    yield* ensureUnmoved(directory);
    // Write a temp file that cannot already exist, then rename it over the
    // target. A rename replaces a symlink at the target instead of following it.
    const mode = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => info.mode & 0o7777),
      Effect.orElseSucceed(() => undefined),
    );
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${yield* randomUuidV4}.tmp`);
    yield* fileSystem.writeFileString(tempPath, input.request.content, { flag: "wx", mode }).pipe(
      Effect.andThen(ensureUnmoved(directory)),
      Effect.andThen(fileSystem.rename(tempPath, filePath).pipe(Effect.mapError(() => failed))),
      Effect.mapError((error) => (error._tag === "PlatformError" ? failed : error)),
      Effect.tapError(() => fileSystem.remove(tempPath).pipe(Effect.ignore)),
    );
    return {};
  },
);
