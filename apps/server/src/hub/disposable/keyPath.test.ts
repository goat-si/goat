import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real lstat whose owner the test rewrites.
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { keyPathFor } from "./keyPath.ts";

const WINDOWS = HostProcess.Platform.defaultValue() === "win32";

/** shared/base/userdata/disposable/machine_ed25519 in a private temporary folder. */
const layout = (modes: { readonly shared: number; readonly base: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const shared = path.join(root, "shared");
    const base = path.join(shared, "base");
    const state = path.join(base, "userdata");
    const disposable = path.join(state, "disposable");
    yield* fs.makeDirectory(disposable, { recursive: true });
    yield* fs.chmod(shared, modes.shared);
    yield* fs.chmod(base, modes.base);
    yield* fs.chmod(state, 0o700);
    yield* fs.chmod(disposable, 0o700);
    const key = path.join(disposable, "machine_ed25519");
    yield* fs.writeFileString(key, "key", { mode: 0o600 });
    yield* fs.chmod(key, 0o600);
    const mode = (dir: string) => Effect.map(fs.stat(dir), (info) => Number(info.mode) & 0o7777);
    return { root, shared, base, state, disposable, key, own: [base, state, disposable], mode };
  });

it.live.skipIf(WINDOWS)("a 0755 or 0700 chain is usable and nothing is changed", () =>
  Effect.gen(function* () {
    for (const base of [0o755, 0o700]) {
      const at = yield* layout({ shared: 0o755, base });
      expect(yield* keyPathFor(at.key, at.own)).toEqual({ kind: "ok" });
      expect(yield* at.mode(at.base)).toBe(base);
      expect(yield* at.mode(at.shared)).toBe(0o755);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("GOAT's own base folder left 0775 by a umask of 002 is tightened", () =>
  Effect.gen(function* () {
    const at = yield* layout({ shared: 0o755, base: 0o775 });
    expect(yield* keyPathFor(at.key, at.own)).toEqual({ kind: "ok" });
    expect(yield* at.mode(at.base)).toBe(0o755);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("a group-writable folder above GOAT's own is named and never changed", () =>
  Effect.gen(function* () {
    const at = yield* layout({ shared: 0o775, base: 0o755 });
    expect(yield* keyPathFor(at.key, at.own)).toEqual({ kind: "directory", directory: at.shared });
    expect(yield* at.mode(at.shared)).toBe(0o775);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)(
  "a symlink on the way is followed, and the folder holding it is judged too",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const at = yield* layout({ shared: 0o755, base: 0o755 });
      // root/links/goat -> shared/base, as a GOAT home reached through a link.
      const links = path.join(at.root, "links");
      yield* fs.makeDirectory(links);
      yield* fs.symlink(at.base, path.join(links, "goat"));
      const linked = path.join(links, "goat", "userdata", "disposable", "machine_ed25519");
      yield* fs.chmod(links, 0o755);
      expect(yield* keyPathFor(linked, at.own)).toEqual({ kind: "ok" });
      yield* fs.chmod(links, 0o775);
      expect(yield* keyPathFor(linked, at.own)).toEqual({ kind: "directory", directory: links });
      expect(yield* at.mode(links)).toBe(0o775);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("the key itself must be a regular private file at a plain path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const at = yield* layout({ shared: 0o755, base: 0o755 });
    expect(yield* keyPathFor(at.key.replace("disposable", "dis posable"), at.own)).toEqual({
      kind: "form",
    });
    const alias = path.join(at.disposable, "alias");
    yield* fs.symlink(at.key, alias);
    expect(yield* keyPathFor(alias, at.own)).toEqual({ kind: "key", problem: "not_regular" });
    yield* fs.chmod(at.key, 0o640);
    expect(yield* keyPathFor(at.key, at.own)).toEqual({ kind: "key", problem: "permissions" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)(
  "a symlink another user owns on the key's path is named and never followed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const at = yield* layout({ shared: 0o755, base: 0o755 });
      const links = path.join(at.root, "links");
      yield* fs.makeDirectory(links);
      yield* fs.chmod(links, 0o755);
      const link = path.join(links, "goat");
      yield* fs.symlink(at.base, link);
      const linked = path.join(link, "userdata", "disposable", "machine_ed25519");
      // OpenCodex refuses a link another user owns: they could point it elsewhere, even in a sticky folder.
      const foreign = (target: string) =>
        Effect.map(
          Effect.promise(() => NodeFSP.lstat(target)),
          (stat) => (target === link ? Object.assign(stat, { uid: 4242 }) : stat),
        );
      expect(yield* keyPathFor(linked, at.own, foreign)).toEqual({ kind: "symlink", path: link });
      expect(yield* keyPathFor(linked, at.own)).toEqual({ kind: "ok" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
