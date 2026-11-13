// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat and readlink walk the path as the kernel resolves it.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- POSIX path arithmetic on the resolved walk.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

/**
 * OpenCodex's identity file rule (link.route/2): a plain path to a private regular file, and every folder
 * on the resolved way owned by this user or root and not writable by others (a sticky one above the
 * key's own excepted). GOAT tightens only folders it made; any other it names and never changes.
 */
export type KeyPathAnswer =
  | { readonly kind: "ok" }
  | { readonly kind: "form" }
  | { readonly kind: "key"; readonly problem: "missing" | "not_regular" | "permissions" }
  | { readonly kind: "directory"; readonly directory: string };

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
  /** Real paths of the directories GOAT may tighten. */
  readonly own: ReadonlySet<string>;
}

/** A directory's verdict: safe, tightened by GOAT, or unsafe. */
const judge = Effect.fn("keyPath.judge")(function* (
  walk: Walk,
  path: string,
  stat: { readonly uid: number; readonly mode: number },
  strict: boolean,
) {
  const owned = stat.uid === walk.uid || stat.uid === 0;
  const writable = (stat.mode & 0o022) !== 0;
  const excepted = !strict && (stat.mode & 0o1000) !== 0;
  if (owned && (!writable || excepted)) return true;
  if (stat.uid !== walk.uid || !walk.own.has(path)) return false;
  // GOAT's own folder, this user's, failing only the write rule: tighten it.
  yield* Effect.tryPromise(() => NodeFSP.chmod(path, stat.mode & 0o7755));
  return true;
});

/** Resolves the key's directory entry by entry and judges every directory on the way. */
const resolveDirectory = Effect.fn("keyPath.resolveDirectory")(function* (
  walk: Walk,
  target: string,
) {
  let current = "/";
  const root = yield* Effect.tryPromise(() => NodeFSP.lstat(current));
  const pending = target.split("/").filter((name) => name !== "" && name !== ".");
  if (!(yield* judge(walk, current, root, pending.length === 0))) return current;
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() ?? "";
    if (name === "..") {
      current = NodePath.dirname(current);
      continue;
    }
    const next = current === "/" ? "/" + name : current + "/" + name;
    const entry = yield* Effect.tryPromise(() => NodeFSP.lstat(next));
    if (entry.isSymbolicLink()) {
      links += 1;
      if (links > MAX_SYMLINKS) return next;
      const link = yield* Effect.tryPromise(() => NodeFSP.readlink(next));
      if (link.startsWith("/")) current = "/";
      pending.unshift(...link.split("/").filter((part) => part !== "" && part !== "."));
      continue;
    }
    if (!entry.isDirectory()) return next;
    if (!(yield* judge(walk, next, entry, pending.length === 0))) return next;
    current = next;
  }
  return undefined;
});

/**
 * Checks, and where GOAT owns the folder tightens, the path of the hub's machine key for OpenCodex.
 * `own` lists GOAT's own folders; a failed read answers the folder or key it could not read.
 */
export const keyPathFor = Effect.fn("keyPath.check")(function* (
  keyFile: string,
  own: ReadonlyArray<string>,
) {
  if (!isForm(keyFile)) return { kind: "form" } as const satisfies KeyPathAnswer;
  const uid = process.getuid?.() ?? -1;
  const real = yield* Effect.forEach(own, (path) =>
    Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(Effect.option),
  );
  const walk: Walk = {
    uid,
    own: new Set(real.flatMap((path) => (path._tag === "Some" ? [path.value] : []))),
  };
  const key = yield* Effect.tryPromise(() => NodeFSP.lstat(keyFile)).pipe(Effect.option);
  if (key._tag === "None")
    return { kind: "key", problem: "missing" } as const satisfies KeyPathAnswer;
  if (key.value.isSymbolicLink() || !key.value.isFile())
    return { kind: "key", problem: "not_regular" } as const satisfies KeyPathAnswer;
  if (key.value.uid !== uid || (key.value.mode & 0o077) !== 0)
    return { kind: "key", problem: "permissions" } as const satisfies KeyPathAnswer;
  const unsafe = yield* resolveDirectory(walk, NodePath.dirname(keyFile)).pipe(
    Effect.orElseSucceed(() => NodePath.dirname(keyFile)),
  );
  return unsafe === undefined
    ? ({ kind: "ok" } as const satisfies KeyPathAnswer)
    : ({ kind: "directory", directory: unsafe } as const satisfies KeyPathAnswer);
});
