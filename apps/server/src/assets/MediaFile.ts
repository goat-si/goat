// @effect-diagnostics nodeBuiltinImport:off - FileSystem does not expose no-follow
// or non-blocking open flags, and the response must keep the validated descriptor.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class MediaFileOpenError extends Schema.TaggedError<MediaFileOpenError>()("MediaFileOpenError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to open media file '${this.path}'.`;
  }
}

class MediaFileReadError extends Schema.TaggedError<MediaFileReadError>()("MediaFileReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read media file '${this.path}'.`;
  }
}

class MediaFileStatError extends Schema.TaggedError<MediaFileStatError>()("MediaFileStatError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read metadata for media file '${this.path}'.`;
  }
}

export interface OpenMediaFile {
  readonly handle: NodeFSP.FileHandle;
  readonly info: NodeFS.BigIntStats;
}

const realpathLikeFileSystem = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    NodeFS.realpath(filePath, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });

export const realPathWithoutNativeResolver = (filePath: string) =>
  Effect.promise(() => realpathLikeFileSystem(filePath).catch(() => null));

const workspaceAncestors = async (filePath: string, root: string) => {
  const relative = NodePath.relative(root, filePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return null;
  const parents: string[] = [];
  for (let directory = NodePath.dirname(filePath); ; directory = NodePath.dirname(directory)) {
    parents.push(directory);
    if (directory === NodePath.dirname(directory)) break;
  }
  const chain: Array<{ path: string; info: NodeFS.BigIntStats; inWorkspace: boolean }> = [];
  let inWorkspace = false;
  for (const path of parents.reverse()) {
    const info = await NodeFSP.lstat(path, { bigint: true });
    if (!info.isDirectory() || info.ino === 0n) return null;
    if (NodePath.relative(root, path) === "") inWorkspace = true;
    chain.push({ path, info, inWorkspace });
  }
  return chain;
};

const sameAncestors = async (
  chain: NonNullable<Awaited<ReturnType<typeof workspaceAncestors>>>,
) => {
  for (const { path, info, inWorkspace } of chain) {
    const after = await NodeFSP.lstat(path, { bigint: true });
    if (
      !after.isDirectory() ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      (inWorkspace && after.ctimeNs !== info.ctimeNs)
    )
      return false;
  }
  return true;
};

export const openMediaFile = Effect.fn("openMediaFile")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
  workspaceRoot?: string,
) {
  const platform = yield* HostProcess.Platform;
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const ancestors =
          workspaceRoot === undefined
            ? undefined
            : await workspaceAncestors(filePath, workspaceRoot);
        if (ancestors === null) return null;
        const before = await NodeFSP.lstat(filePath, { bigint: true });
        if (!before.isFile() || before.ino === 0n) return null;
        if (
          identity &&
          (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode)
        ) {
          return null;
        }

        // Windows lacks these flags; the descriptor/path identity checks still apply.
        const handle = await NodeFSP.open(
          filePath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NOFOLLOW ?? 0) |
            (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        let accepted = false;
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
          if (
            identity &&
            (info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode)
          ) {
            return null;
          }
          // Match FileSystem.realPath's JS behavior; native realpath expands Windows 8.3 names too.
          if ((await realpathLikeFileSystem(filePath)) !== filePath) return null;
          const after = await NodeFSP.lstat(filePath, { bigint: true });
          if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) return null;
          if (ancestors) {
            // On Linux the kernel can name the descriptor itself. Elsewhere bracket the open
            // with non-symlink directory identities and compare the authorized inode.
            if (
              platform === "linux" &&
              (await NodeFSP.readlink(`/proc/self/fd/${handle.fd}`)) !== filePath
            )
              return null;
            if (!(await sameAncestors(ancestors))) return null;
          }
          accepted = true;
          return { handle, info } satisfies OpenMediaFile;
        } finally {
          if (!accepted) await handle.close();
        }
      },
      catch: (cause) => new MediaFileOpenError({ path: filePath, cause }),
    }),
    (file) => (file ? Effect.promise(() => file.handle.close()) : Effect.void),
  );
});

export const readMediaFileHeader = (filePath: string, file: OpenMediaFile, byteCount: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = new Uint8Array(byteCount);
      const { bytesRead } = await file.handle.read(buffer, 0, byteCount, 0);
      return buffer.subarray(0, bytesRead);
    },
    catch: (cause) => new MediaFileReadError({ path: filePath, cause }),
  });

export const statMediaFile = Effect.fn("statMediaFile")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  return yield* Effect.tryPromise({
    try: () => file.handle.stat({ bigint: true }),
    catch: (cause) => new MediaFileStatError({ path: filePath, cause }),
  });
});

export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {
  const start = Number(offset);
  const end = Number(offset + bytesToRead - 1n);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  return NodeStream.fromReadable<Uint8Array>({
    evaluate: () =>
      file.handle.createReadStream({
        autoClose: false,
        start,
        end,
      }),
  });
};
