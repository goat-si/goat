// @effect-diagnostics nodeBuiltinImport:off -- The write helper runs as a separate Node process.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@goat/shared/HostProcess";
import { resolveNodeExecutable } from "@goat/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import { randomUuidV4 } from "@goat/provider-core/server/randomUuid";

/** The agent requests permission for every write; check only path containment here. */
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
 * Symlinks resolve before the check, including the final component, so a link
 * inside the workspace cannot read or write through to a file outside it. A
 * new path resolves through its nearest existing ancestor, so missing
 * directories under a link still land where the link points, and a workspace
 * reached through a symlink (macOS `/var` -> `/private/var`) compares equal to
 * its resolved roots.
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
    // The deepest root wins so nested roots give the shortest walk.
    const root = roots
      .filter((candidate) => isInsideRoot(path, candidate, real))
      .toSorted((left, right) => right.length - left.length)[0];
    if (root === undefined) return yield* outside;
    return { filePath: real, root };
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

/**
 * Runs inside the write helper, whose working directory starts at the
 * resolved session root. Node has no `openat`, so the helper's working
 * directory stands in for a directory descriptor: it descends one real
 * directory at a time, checks after each `chdir` that it landed on the
 * entry it inspected, and then creates and renames only names relative to
 * that pinned directory. Swapping a checked directory for a symlink can no
 * longer redirect the write, because nothing after the walk resolves a path.
 *
 * Signals are ignored so the temp file is always renamed or removed: the
 * whole write runs synchronously once stdin is complete, and a stdin cut
 * short by an interrupted caller writes nothing.
 */
const HELPER_EXIT_OUTSIDE = 3;
const WRITE_HELPER_SCRIPT = String.raw`"use strict";
const fs = require("node:fs");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
const [root, name, temp, bytes, ...directories] = process.argv.slice(1);
const OUTSIDE = ${HELPER_EXIT_OUTSIDE};
const sameEntry = (left, right) => left.dev === right.dev && left.ino === right.ino;
function write(content) {
  if (content.length !== Number(bytes)) return 1;
  // The pinned start must still be the resolved root, so a root swapped for a
  // symlink before the helper started cannot become the anchor. The resolved
  // root contains no links, and native realpath gives both sides one casing.
  if (fs.lstatSync(root).isSymbolicLink()) return OUTSIDE;
  if (fs.realpathSync.native(".") !== fs.realpathSync.native(root)) return OUTSIDE;
  for (const segment of directories) {
    try {
      fs.mkdirSync(segment);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const entry = fs.lstatSync(segment, { bigint: true });
    if (!entry.isDirectory()) return OUTSIDE;
    process.chdir(segment);
    if (!sameEntry(fs.statSync(".", { bigint: true }), entry)) return OUTSIDE;
  }
  let mode;
  try {
    const existing = fs.lstatSync(name);
    if (existing.isFile()) mode = existing.mode & 0o7777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = fs.openSync(temp, "wx", mode ?? 0o666);
  try {
    try {
      fs.writeFileSync(fd, content);
      // The open mode is masked by umask; an existing file keeps its own bits.
      if (mode !== undefined) fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    // A rename replaces a symlink at the target instead of following it.
    fs.renameSync(temp, name);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {}
    throw error;
  }
  return 0;
}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    process.exitCode = write(Buffer.concat(chunks));
  } catch {
    process.exitCode = 1;
  }
});
`;

type WriteHelperRequest = {
  readonly root: string;
  readonly directories: ReadonlyArray<string>;
  readonly name: string;
  readonly temp: string;
  readonly bytes: number;
};

/**
 * Feeds the content on stdin and resolves with the helper's exit code. An
 * interrupted caller closes stdin and waits for the helper to finish, so the
 * helper either completes the write or leaves nothing behind.
 */
const runWriteHelper = (input: {
  readonly node: string;
  readonly systemRoot: string | undefined;
  readonly request: WriteHelperRequest;
  readonly content: Buffer;
}) =>
  Effect.callback<number, Error>((resume) => {
    const child = NodeChildProcess.spawn(
      input.node,
      [
        "-e",
        WRITE_HELPER_SCRIPT,
        // Ends Node's own options, so a segment like `--version` stays a name.
        "--",
        input.request.root,
        input.request.name,
        input.request.temp,
        String(input.request.bytes),
        ...input.request.directories,
      ],
      {
        cwd: input.request.root,
        // Node or Electron alike run the script; inherited NODE_OPTIONS do not.
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ...(input.systemRoot === undefined ? {} : { SystemRoot: input.systemRoot }),
        },
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.once("error", (cause) => resume(Effect.fail(cause)));
    child.once("close", (code) => resume(Effect.succeed(code ?? 1)));
    // A helper that exits early closes the pipe; its exit code reports why.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.content);
    return Effect.promise(() => {
      child.stdin.destroy();
      return exited;
    });
  });

export const writeAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.writeTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.WriteTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError> {
    const { path } = input;
    const { filePath, root } = yield* resolveClientFilePath({
      ...input,
      requestPath: input.request.path,
    });
    const failed = EffectAcpErrors.AcpRequestError.internalError(
      `Could not write '${input.request.path}'.`,
    );
    const segments = path.relative(root, filePath).split(path.sep);
    const name = segments.pop();
    if (name === undefined || name === "") return yield* failed;
    const node = yield* resolveNodeExecutable("Antigravity").pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => failed),
    );
    const content = Buffer.from(input.request.content);
    const code = yield* runWriteHelper({
      node,
      systemRoot: (yield* HostProcess.Environment).SystemRoot,
      request: {
        root,
        directories: segments.filter((segment) => segment !== ""),
        name,
        temp: `.${name}.${yield* randomUuidV4}.tmp`,
        bytes: content.length,
      },
      content,
    }).pipe(Effect.mapError(() => failed));
    if (code === HELPER_EXIT_OUTSIDE) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Path '${input.request.path}' is outside the session workspace.`,
      );
    }
    if (code !== 0) return yield* failed;
    return {};
  },
);
