// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat and readlink walk the path as the kernel resolves it.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- POSIX path arithmetic on the resolved walk.
import * as NodePath from "node:path";

import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * OpenCodex's identity file rule (link.route/2): a plain path to a private regular file, and every folder
 * on the resolved way owned by this user or root and not writable by others (a sticky one above the
 * key's own excepted). GOAT tightens only folders it made; any other it names and never changes.
 */
export type KeyPathAnswer =
  | { readonly kind: "ok" }
  | { readonly kind: "form" }
  | {
      readonly kind: "key";
      readonly problem: "missing" | "not_regular" | "permissions" | "unreadable";
    }
  | { readonly kind: "directory"; readonly directory: string }
  /** A symlink on the path that another user owns, who could point it elsewhere. */
  | { readonly kind: "symlink"; readonly path: string };

/** lstat as the walk reads it; a test gives an entry another owner. */
export type Lstat = (path: string) => Effect.Effect<
  {
    readonly uid: number;
    readonly mode: number;
    readonly dev: number;
    readonly ino: number;
    readonly isSymbolicLink: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  },
  Cause.UnknownError
>;
const nodeLstat: Lstat = (path) => Effect.tryPromise(() => NodeFSP.lstat(path));

const FORM = /^\/[A-Za-z0-9._+/-]+$/u;
const MAX_SYMLINKS = 40;

const isForm = (path: string) =>
  path.length >= 2 &&
  path.length <= 1024 &&
  FORM.test(path) &&
  path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

interface Walk {
  readonly uid: number;
  readonly lstat: Lstat;
  /** Real paths of the directories GOAT may tighten. */
  readonly own: ReadonlySet<string>;
}

/**
 * Removes group and other write from the very folder the walk judged: opened without following a
 * link, and changed only while it is still that folder (device and inode) and this user's.
 */
const tighten = (walk: Walk, path: string, seen: { readonly dev: number; readonly ino: number }) =>
  Effect.tryPromise(async () => {
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = NodeFSP.constants;
    const handle = await NodeFSP.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const now = await handle.stat();
      if (!now.isDirectory() || now.dev !== seen.dev || now.ino !== seen.ino) return false;
      if (now.uid !== walk.uid) return false;
      await handle.chmod(now.mode & 0o7755);
      return true;
    } finally {
      await handle.close();
    }
  }).pipe(Effect.orElseSucceed(() => false));

/** A directory's verdict: safe, tightened by GOAT, or unsafe. */
const judge = Effect.fn("keyPath.judge")(function* (
  walk: Walk,
  path: string,
  stat: { readonly uid: number; readonly mode: number; readonly dev: number; readonly ino: number },
  strict: boolean,
) {
  const owned = stat.uid === walk.uid || stat.uid === 0;
  const writable = (stat.mode & 0o022) !== 0;
  const excepted = !strict && (stat.mode & 0o1000) !== 0;
  if (owned && (!writable || excepted)) return true;
  // Only GOAT's own folder, this user's, failing only the write rule is tightened.
  if (stat.uid !== walk.uid || !walk.own.has(path)) return false;
  return yield* tighten(walk, path, stat);
});

/** Resolves the key's directory entry by entry and judges every directory on the way. */
const resolveDirectory = Effect.fn("keyPath.resolveDirectory")(function* (
  walk: Walk,
  target: string,
) {
  let current = "/";
  const root = yield* walk.lstat(current);
  const pending = target.split("/").filter((name) => name !== "" && name !== ".");
  const unsafe = (directory: string): KeyPathAnswer => ({ kind: "directory", directory });
  if (!(yield* judge(walk, current, root, pending.length === 0))) return unsafe(current);
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() ?? "";
    if (name === "..") {
      current = NodePath.dirname(current);
      continue;
    }
    const next = current === "/" ? "/" + name : current + "/" + name;
    const entry = yield* walk.lstat(next);
    if (entry.isSymbolicLink()) {
      if (entry.uid !== walk.uid && entry.uid !== 0)
        return { kind: "symlink", path: next } satisfies KeyPathAnswer;
      links += 1;
      if (links > MAX_SYMLINKS) return unsafe(next);
      const link = yield* Effect.tryPromise(() => NodeFSP.readlink(next));
      if (link.startsWith("/")) current = "/";
      pending.unshift(...link.split("/").filter((part) => part !== "" && part !== "."));
      continue;
    }
    if (!entry.isDirectory()) return unsafe(next);
    if (!(yield* judge(walk, next, entry, pending.length === 0))) return unsafe(next);
    current = next;
  }
  // The key's own folder is strict however the walk reached it (a link ending in .. or /).
  if (!(yield* judge(walk, current, yield* walk.lstat(current), true))) return unsafe(current);
  return undefined;
});

/**
 * Checks, and where GOAT owns the folder tightens, the path of the hub's machine key for OpenCodex.
 * `own` lists GOAT's own folders; a failed read answers the folder or key it could not read.
 */
export const keyPathFor = Effect.fn("keyPath.check")(function* (
  keyFile: string,
  own: ReadonlyArray<string>,
  lstat: Lstat = nodeLstat,
) {
  if (!isForm(keyFile)) return { kind: "form" } as const satisfies KeyPathAnswer;
  const uid = process.getuid?.() ?? -1;
  // A folder of GOAT's that is itself a link is not GOAT's to change: it names another folder.
  const real = yield* Effect.forEach(own, (path) =>
    lstat(path).pipe(
      Effect.flatMap((stat) =>
        stat.isDirectory() && !stat.isSymbolicLink()
          ? Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(Effect.option)
          : Effect.succeedNone,
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
  );
  const walk: Walk = {
    uid,
    lstat,
    own: new Set(real.flatMap((path) => (path._tag === "Some" ? [path.value] : []))),
  };
  const key = yield* lstat(keyFile).pipe(Effect.option);
  if (key._tag === "None")
    return { kind: "key", problem: "missing" } as const satisfies KeyPathAnswer;
  if (key.value.isSymbolicLink() || !key.value.isFile())
    return { kind: "key", problem: "not_regular" } as const satisfies KeyPathAnswer;
  if (key.value.uid !== uid || (key.value.mode & 0o077) !== 0)
    return { kind: "key", problem: "permissions" } as const satisfies KeyPathAnswer;
  const unsafe = yield* resolveDirectory(walk, NodePath.dirname(keyFile)).pipe(
    Effect.orElseSucceed((): KeyPathAnswer => ({
      kind: "directory",
      directory: NodePath.dirname(keyFile),
    })),
  );
  if (unsafe !== undefined) return unsafe;
  const readable = yield* Effect.tryPromise(() =>
    NodeFSP.access(keyFile, NodeFSP.constants.R_OK),
  ).pipe(Effect.option);
  return readable._tag === "None"
    ? ({ kind: "key", problem: "unreadable" } as const satisfies KeyPathAnswer)
    : ({ kind: "ok" } as const satisfies KeyPathAnswer);
});
