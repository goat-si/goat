// @effect-diagnostics nodeBuiltinImport:off - Descriptor sync and exclusive sibling creation need Node APIs.
/*
 * Adapted from Emanuele-web04/synara @ 566efb1b1, workspace file writes and
 * realPathContainment.ts (MIT).
 *
 * Copyright (c) 2026 T3 Tools Inc.
 * Copyright (c) 2026 Emanuele Di Pietro
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProjectFileOperation } from "@goat/contracts";
import * as Schema from "effect/Schema";

class AtomicWriteOperationError extends Schema.TaggedError<AtomicWriteOperationError>()(
  "AtomicWriteOperationError",
  {
    operation: ProjectFileOperation,
    operationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class AtomicWritePathEscapeError extends Schema.TaggedError<AtomicWritePathEscapeError>()(
  "AtomicWritePathEscapeError",
  { resolvedWorkspaceRoot: Schema.String, resolvedPath: Schema.String },
) {}

export class WorkspaceFileChangedOnDiskError extends Schema.TaggedError<WorkspaceFileChangedOnDiskError>()(
  "WorkspaceFileChangedOnDiskError",
  {},
) {}
export class WorkspaceFileDeletedOnDiskError extends Schema.TaggedError<WorkspaceFileDeletedOnDiskError>()(
  "WorkspaceFileDeletedOnDiskError",
  {},
) {}

export const isWorkspaceFileChangedOnDiskError = Schema.is(WorkspaceFileChangedOnDiskError);
export const isWorkspaceFileDeletedOnDiskError = Schema.is(WorkspaceFileDeletedOnDiskError);

export function workspaceFileVersion(bytes: Uint8Array) {
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
}

async function assertVersion(target: string, expectedVersion: string) {
  const handle = await operation("open", target, async () => {
    try {
      return await NodeFS.promises.open(
        target,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
      );
    } catch (cause) {
      if (hasCode(cause, "ENOENT")) throw new WorkspaceFileDeletedOnDiskError({});
      throw cause;
    }
  }).catch((cause: unknown) => {
    if (isAtomicWriteOperationError(cause) && isWorkspaceFileDeletedOnDiskError(cause.cause))
      throw cause.cause;
    throw cause;
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 1024n * 1024n)
      throw new WorkspaceFileChangedOnDiskError({});
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    const current = await NodeFS.promises.stat(target, { bigint: true }).catch((cause: unknown) => {
      if (hasCode(cause, "ENOENT")) throw new WorkspaceFileDeletedOnDiskError({});
      throw cause;
    });
    if (
      before.size !== BigInt(bytesRead) ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.ino !== current.ino ||
      after.dev !== current.dev ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      workspaceFileVersion(bytes.subarray(0, bytesRead)) !== expectedVersion
    ) {
      throw new WorkspaceFileChangedOnDiskError({});
    }
  } finally {
    await handle.close();
  }
}

export const isAtomicWriteOperationError = Schema.is(AtomicWriteOperationError);
export const isAtomicWritePathEscapeError = Schema.is(AtomicWritePathEscapeError);

function isContained(root: string, target: string) {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

function hasCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

async function operation<A>(
  name: ProjectFileOperation,
  operationPath: string,
  run: () => Promise<A>,
) {
  try {
    return await run();
  } catch (cause) {
    throw new AtomicWriteOperationError({ operation: name, operationPath, cause });
  }
}

/** Stage bytes beside the canonical destination, then publish with one rename.
 * The caller must first validate the target lexically against workspaceRoot.
 */
export async function prepareAtomicWorkspaceWrite(input: {
  readonly workspaceRoot: string;
  readonly absolutePath: string;
  readonly contents: Uint8Array;
  readonly platform: string;
  readonly expectedVersion?: string;
  readonly createOnly?: boolean;
}) {
  const realRoot = await operation("realpath-workspace-root", input.workspaceRoot, () =>
    NodeFS.promises.realpath(input.workspaceRoot),
  );
  const assertContained = (target: string) => {
    if (!isContained(realRoot, target)) {
      throw new AtomicWritePathEscapeError({
        resolvedWorkspaceRoot: realRoot,
        resolvedPath: target,
      });
    }
  };
  const canonicalize = async (target: string) => {
    const resolved = await operation("realpath-target", target, () =>
      NodeFS.promises.realpath(target),
    );
    assertContained(resolved);
    return resolved;
  };

  // Walk and create one component at a time. Recursive mkdir on an unchecked
  // suffix could create directories outside the root through a symlink.
  // Detect deletion before creating any missing parent directories.
  if (input.expectedVersion !== undefined) {
    const guardedTarget = await NodeFS.promises
      .realpath(input.absolutePath)
      .catch((cause: unknown) => {
        if (hasCode(cause, "ENOENT")) throw new WorkspaceFileDeletedOnDiskError({});
        throw cause;
      });
    assertContained(guardedTarget);
    await assertVersion(guardedTarget, input.expectedVersion);
  }
  let parent = realRoot;
  const components = NodePath.relative(
    NodePath.resolve(input.workspaceRoot),
    input.absolutePath,
  ).split(NodePath.sep);
  const basename = components.pop()!;
  for (const component of components) {
    const candidate = NodePath.join(parent, component);
    await operation("make-directory", candidate, async () => {
      try {
        await NodeFS.promises.mkdir(candidate);
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause;
      }
    });
    parent = await canonicalize(candidate);
  }

  let target = NodePath.join(parent, basename);
  const targetStat = await operation("stat", target, async () => {
    try {
      return await NodeFS.promises.lstat(target);
    } catch (cause) {
      if (hasCode(cause, "ENOENT")) return null;
      throw cause;
    }
  });
  // Keep valid file aliases, but never treat a dangling link as a missing file.
  if (targetStat !== null) target = await canonicalize(target);
  parent = NodePath.dirname(target);
  const existing =
    targetStat === null
      ? null
      : await operation("stat", target, () => NodeFS.promises.stat(target));
  if (existing !== null && !existing.isFile()) {
    throw new AtomicWriteOperationError({
      operation: "stat",
      operationPath: target,
      cause: new Error("Workspace write target is not a regular file."),
    });
  }
  if (input.createOnly && existing !== null) throw new WorkspaceFileChangedOnDiskError({});
  if (existing !== null) {
    // Replacing a directory entry must not bypass the old write's file-mode check.
    await operation("open", target, () => NodeFS.promises.access(target, NodeFS.constants.W_OK));
  }

  // Keep staging names bounded even when the destination is near NAME_MAX.
  const temporary = NodePath.join(parent, `.goat.${NodeCrypto.randomUUID()}.tmp`);
  const mode = existing === null ? 0o666 : existing.mode & 0o7777;
  const handle = await operation("open", temporary, () =>
    NodeFS.promises.open(
      temporary,
      NodeFS.constants.O_WRONLY |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        (input.platform === "win32" ? 0 : NodeFS.constants.O_NOFOLLOW),
      mode,
    ),
  );
  let identity: { dev: number; ino: number } | undefined;
  let closed = false;
  let prepared = false;
  const cleanup = async () => {
    if (!closed) await handle.close().catch(() => undefined);
    if (identity !== undefined) {
      try {
        if ((await NodeFS.promises.realpath(parent)) === parent) {
          const current = await NodeFS.promises.lstat(temporary);
          if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino)
            await NodeFS.promises.unlink(temporary);
        }
      } catch {
        // Preserve the publication's result if our temporary path has already gone.
      }
    }
  };
  try {
    identity = await operation("stat", temporary, () => handle.stat());
    const validateTemporary = async () => {
      const realParent = await canonicalize(parent);
      const realTemporary = await canonicalize(temporary);
      const current = await operation("stat", temporary, () => NodeFS.promises.lstat(temporary));
      if (
        realParent !== parent ||
        realTemporary !== temporary ||
        !current.isFile() ||
        current.dev !== identity?.dev ||
        current.ino !== identity?.ino
      ) {
        throw new AtomicWriteOperationError({
          operation: "write-file",
          operationPath: temporary,
          cause: new Error("Workspace write staging path changed."),
        });
      }
    };
    await validateTemporary();
    await operation("write-file", temporary, async () => {
      await handle.writeFile(input.contents);
      // Writing can clear set-id bits on POSIX. Restore the complete existing
      // mode after writing, independently of the process umask.
      if (existing !== null) await handle.chmod(mode);
      await handle.sync();
    });
    await operation("close", temporary, () => handle.close());
    closed = true;
    await validateTemporary();
    // Node has no portable descriptor-relative rename. Revalidation narrows,
    // but cannot eliminate, the final directory-swap race. Never unlink the
    // destination as a Windows fallback: a failed rename must keep old bytes.
    if (input.expectedVersion !== undefined) {
      await assertVersion(target, input.expectedVersion);
    }
    prepared = true;
    return {
      cleanup,
      publish: () =>
        operation("write-file", target, async () => {
          if (!input.createOnly) return NodeFS.promises.rename(temporary, target);
          try {
            await NodeFS.promises.link(temporary, target);
          } catch (cause) {
            if (hasCode(cause, "EEXIST")) throw new WorkspaceFileChangedOnDiskError({});
            throw cause;
          }
        }),
    };
  } finally {
    if (!prepared) await cleanup();
  }
}
