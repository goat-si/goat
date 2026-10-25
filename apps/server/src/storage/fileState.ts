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

/** The most entries a folder may hold for the cleanup to vouch that nothing in it changed. */
const CONTENT_STAMP_LIMIT = 300_000;

export interface ContentStamp {
  readonly entries: number;
  /** Newest ctime or mtime below the folder: what an approval is bound to. */
  readonly newestChangeNs: bigint;
  /** Newest mtime below the folder: how recently anything was written. */
  readonly newestModifiedMs: number;
}

const walk = async (root: string, limit: number): Promise<ContentStamp | null> => {
  const top = await NodeFSP.lstat(root, { bigint: true });
  let entries = 0;
  let newestChangeNs = top.ctimeNs > top.mtimeNs ? top.ctimeNs : top.mtimeNs;
  let newestModifiedNs = top.mtimeNs;
  const pending = [root];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
    for (const name of await NodeFSP.readdir(folder)) {
      entries += 1;
      if (entries > limit) return null;
      const child = NodePath.join(folder, name);
      const stat = await NodeFSP.lstat(child, { bigint: true });
      if (stat.ctimeNs > newestChangeNs) newestChangeNs = stat.ctimeNs;
      if (stat.mtimeNs > newestChangeNs) newestChangeNs = stat.mtimeNs;
      if (stat.mtimeNs > newestModifiedNs) newestModifiedNs = stat.mtimeNs;
      if (stat.isDirectory()) pending.push(child);
    }
  }
  return { entries, newestChangeNs, newestModifiedMs: Number(newestModifiedNs / 1_000_000n) };
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
