// @effect-diagnostics nodeBuiltinImport:off -- bigint lstat identifies what a person reviewed and sees every change below it.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface Lstat {
  readonly identity: FileIdentity;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isLink: boolean;
  readonly mtimeMs: number;
  readonly size: number;
  readonly uid: number;
}

export const lstatOf = (target: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(target, { bigint: true })).pipe(
    Effect.map((stat): Lstat => ({
      identity: { dev: stat.dev, ino: stat.ino },
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      isLink: stat.isSymbolicLink(),
      mtimeMs: Number(stat.mtimeMs),
      size: Number(stat.size),
      uid: Number(stat.uid),
    })),
    Effect.orElseSucceed(() => null),
  );

export const sameIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;

/** A .git entry in any spelling: case-insensitive volumes (macOS, Windows) let git find .GIT. */
export const isGitEntry = (name: string) => name.toLowerCase() === ".git";

/** The most entries a folder may hold for the cleanup to vouch that nothing in it changed. */
const CONTENT_STAMP_LIMIT = 300_000;

export interface ContentStamp {
  readonly entries: number;
  /** Newest ctime or mtime below the folder: what an approval is bound to. */
  readonly newestChangeNs: bigint;
  /** Newest mtime below the folder: how recently anything was written. */
  readonly newestModifiedMs: number;
  /** Some folder below holds a .git entry: a checkout with its own history and work. */
  readonly holdsGit: boolean;
}

const walk = async (root: string, limit: number): Promise<ContentStamp | null> => {
  const top = await NodeFSP.lstat(root, { bigint: true });
  let entries = 0;
  let newestChangeNs = top.ctimeNs > top.mtimeNs ? top.ctimeNs : top.mtimeNs;
  let newestModifiedNs = top.mtimeNs;
  let holdsGit = false;
  const pending = [root];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const name of await NodeFSP.readdir(folder)) {
      entries += 1;
      if (entries > limit) return null;
      if (isGitEntry(name)) holdsGit = true;
      const child = NodePath.join(folder, name);
      const stat = await NodeFSP.lstat(child, { bigint: true });
      if (stat.ctimeNs > newestChangeNs) newestChangeNs = stat.ctimeNs;
      if (stat.mtimeNs > newestChangeNs) newestChangeNs = stat.mtimeNs;
      if (stat.mtimeNs > newestModifiedNs) newestModifiedNs = stat.mtimeNs;
      if (stat.isDirectory()) pending.push(child);
    }
  }
  return {
    entries,
    newestChangeNs,
    newestModifiedMs: Number(newestModifiedNs / 1_000_000n),
    holdsGit,
  };
};

/**
 * How many entries a folder holds and when anything below it last changed. Writing, creating,
 * renaming, deleting or re-permissioning anything inside moves a ctime, which cannot be set back,
 * so an approval bound to this stamp stops matching once the contents change. Links are counted,
 * never followed. Null when the folder is too large or partly unreadable, so it is not vouched for.
 */
export const contentStamp = Effect.fn("storage.contentStamp")(function* (
  root: string,
  limit: number = CONTENT_STAMP_LIMIT,
) {
  return yield* Effect.tryPromise(() => walk(root, limit)).pipe(Effect.orElseSucceed(() => null));
});

/** Entries a folder may hold for the cleanup to look through it for checkouts. */
const GIT_SEARCH_LIMIT = 2_000_000;

const findGit = async (root: string, skipOwn: boolean): Promise<boolean | null> => {
  let entries = 0;
  const pending = [root];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const entry of await NodeFSP.readdir(folder, { withFileTypes: true })) {
      entries += 1;
      if (entries > GIT_SEARCH_LIMIT) return null;
      if (isGitEntry(entry.name)) {
        if (skipOwn && folder === root) continue;
        return true;
      }
      // Dirent types come from the directory itself, so links are never followed.
      if (entry.isDirectory()) pending.push(NodePath.join(folder, entry.name));
    }
  }
  return false;
};

/**
 * Whether a folder holds a git checkout anywhere below it (a .git folder or file). Its own
 * history and uncommitted work are invisible to the enclosing repository's checks. Null when the
 * folder is too large or partly unreadable, which callers treat as holding one. skipOwn leaves out
 * the folder's own .git, for a checkout looking for others inside it.
 */
export const holdsGitCheckout = Effect.fn("storage.holdsGitCheckout")(function* (
  root: string,
  options: { readonly skipOwn?: boolean } = {},
) {
  return yield* Effect.tryPromise(() => findGit(root, options.skipOwn === true)).pipe(
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Whether file sits in a git checkout below root: a folder from the file's own up to root holds a
 * .git entry. Its contents are that checkout's work, whatever their names say. Null when a folder
 * cannot be read, which callers treat as yes. skipRoot leaves out root's own .git, for a checkout
 * looking for others between it and the file.
 */
export const insideCheckout = Effect.fn("storage.insideCheckout")(function* (
  root: string,
  file: string,
  options: { readonly skipRoot?: boolean } = {},
) {
  return yield* Effect.tryPromise(async () => {
    const top = NodePath.resolve(root);
    for (
      let folder = NodePath.dirname(NodePath.resolve(file));
      ;
      folder = NodePath.dirname(folder)
    ) {
      const own = folder === top && options.skipRoot === true;
      if (!own && (await NodeFSP.readdir(folder)).some(isGitEntry)) return true;
      if (folder === top || NodePath.dirname(folder) === folder) return false;
    }
  }).pipe(Effect.orElseSucceed(() => null));
});

/**
 * Whether folder or any folder above it holds a .git entry, so its contents may be a repository's
 * work. Walks the real path, so a linked folder is judged by where it really is. Null when a
 * folder cannot be read, which callers treat as yes.
 */
export const withinCheckout = Effect.fn("storage.withinCheckout")(function* (folder: string) {
  const resolved = yield* Effect.tryPromise(() => NodeFSP.realpath(folder)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (resolved === null) return null;
  return yield* insideCheckout(NodePath.parse(resolved).root, NodePath.join(resolved, "-"));
});
