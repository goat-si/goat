import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real lstat whose owner the test rewrites.
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { goatFolders, keyPathFor } from "./keyPath.ts";

// it.live: these walk real folders the test makes, whose owner and mode only a real lstat reports.
// Windows is skipped: GOAT stops there at the path form, and its modes say nothing of the ACL.
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";

// GOAT running as root is never told to chmod, so the same folder answers chmod false for root.
const ROOT = process.getuid?.() === 0;
/** A folder of the user running the test that its group or others can write. */
const writable = (directory: string, own: boolean) => ({
  kind: "directory",
  directory,
  problem: "writable",
  owner: process.getuid?.() ?? -1,
  chmod: own && !ROOT,
});

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
    const own = goatFolders({ baseDir: at.base, stateDir: at.state });
    expect(yield* keyPathFor(at.key, own)).toEqual({ kind: "ok" });
    expect(yield* at.mode(at.base)).toBe(0o755);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)(
  "a base folder a person chose with GOAT_HOME or --base-dir is named and never changed",
  () =>
    Effect.gen(function* () {
      // Pointed at on purpose, it may be a folder its group shares; its state folder is GOAT's.
      const at = yield* layout({ shared: 0o755, base: 0o775 });
      yield* Effect.promise(() => NodeFSP.chmod(at.state, 0o770));
      const own = goatFolders({ baseDir: at.base, stateDir: at.state, baseDirIsExplicit: true });
      expect(yield* keyPathFor(at.key, own)).toEqual(writable(at.base, true));
      expect(yield* at.mode(at.base)).toBe(0o775);
      yield* Effect.promise(() => NodeFSP.chmod(at.base, 0o755));
      expect(yield* keyPathFor(at.key, own)).toEqual({ kind: "ok" });
      expect(yield* at.mode(at.state)).toBe(0o750);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("a group-writable folder above GOAT's own is named and never changed", () =>
  Effect.gen(function* () {
    const at = yield* layout({ shared: 0o775, base: 0o755 });
    expect(yield* keyPathFor(at.key, at.own)).toEqual(writable(at.shared, true));
    expect(yield* at.mode(at.shared)).toBe(0o775);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** The real lstat, with the owner of the named entries rewritten as a test cannot chown. */
const ownedBy = (owners: ReadonlyMap<string, number>) => (target: string) =>
  Effect.map(
    Effect.promise(() => NodeFSP.lstat(target)),
    (stat) => {
      const owner = owners.get(target);
      return owner === undefined ? stat : Object.assign(stat, { uid: owner });
    },
  );

it.live.skipIf(WINDOWS)(
  "a shared folder owned by root or a folder of another user is named with why, and chmod is never offered",
  () =>
    Effect.gen(function* () {
      const at = yield* layout({ shared: 0o775, base: 0o755 });
      // A team share such as /srv/team (2775 root:team): writable, but not this user's to change.
      expect(
        yield* keyPathFor(at.key, at.own, { lstat: ownedBy(new Map([[at.shared, 0]])) }),
      ).toEqual({
        kind: "directory",
        directory: at.shared,
        problem: "writable",
        owner: 0,
        chmod: false,
      });
      yield* Effect.promise(() => NodeFSP.chmod(at.shared, 0o755));
      expect(
        yield* keyPathFor(at.key, at.own, { lstat: ownedBy(new Map([[at.shared, 4242]])) }),
      ).toEqual({
        kind: "directory",
        directory: at.shared,
        problem: "owner",
        owner: 4242,
        chmod: false,
      });
      expect(yield* at.mode(at.shared)).toBe(0o755);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("GOAT running as root is never told to chmod a folder", () =>
  Effect.gen(function* () {
    const at = yield* layout({ shared: 0o775, base: 0o755 });
    // Every entry reads as root's, as on a hub where GOAT runs as root.
    const asRoot = (target: string) =>
      Effect.map(
        Effect.promise(() => NodeFSP.lstat(target)),
        (stat) => Object.assign(stat, { uid: 0 }),
      );
    expect(yield* keyPathFor(at.key, at.own, { lstat: asRoot, uid: 0 })).toEqual({
      kind: "directory",
      directory: at.shared,
      problem: "writable",
      owner: 0,
      chmod: false,
    });
    expect(yield* at.mode(at.shared)).toBe(0o775);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("a folder on the way that cannot be read answers unreadable", () =>
  Effect.gen(function* () {
    const at = yield* layout({ shared: 0o755, base: 0o755 });
    const failing = (target: string) =>
      target === at.base
        ? Effect.fail(new Cause.UnknownError(new Error("EACCES")))
        : Effect.promise(() => NodeFSP.lstat(target));
    expect(yield* keyPathFor(at.key, at.own, { lstat: failing })).toEqual({ kind: "unreadable" });
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
      expect(yield* keyPathFor(linked, at.own)).toEqual(writable(links, true));
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
      expect(yield* keyPathFor(linked, at.own, { lstat: foreign })).toEqual({
        kind: "symlink",
        path: link,
      });
      expect(yield* keyPathFor(linked, at.own)).toEqual({ kind: "ok" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)(
  "a GOAT base folder that is a symlink to another folder never gets that folder chmodded",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const at = yield* layout({ shared: 0o755, base: 0o755 });
      // The person's own folder, group-writable; GOAT's base folder is only a link to it.
      const home = path.join(at.root, "home");
      yield* fs.makeDirectory(home);
      yield* fs.chmod(home, 0o775);
      yield* fs.rename(at.base, path.join(home, "goat-real"));
      yield* fs.symlink(home, at.base);
      const key = path.join(at.base, "goat-real", "userdata", "disposable", "machine_ed25519");
      const own = [at.base, path.join(at.base, "goat-real", "userdata")];
      expect(yield* keyPathFor(key, own)).toEqual(writable(home, true));
      expect(yield* at.mode(home)).toBe(0o775);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("the key's own folder is judged strictly however the path reaches it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const at = yield* layout({ shared: 0o755, base: 0o755 });
    // A sticky folder anyone can write passes above the key, never as the key's own folder.
    const sticky = path.join(at.root, "sticky");
    yield* fs.makeDirectory(path.join(sticky, "sub"), { recursive: true });
    yield* fs.chmod(sticky, 0o1777);
    // Under a umask of 002 sub would be 0775 and refused before the walk reached "..".
    yield* fs.chmod(path.join(sticky, "sub"), 0o755);
    yield* fs.writeFileString(path.join(sticky, "machine_ed25519"), "key", { mode: 0o600 });
    yield* fs.symlink(path.join(sticky, "sub") + "/..", path.join(at.disposable, "via"));
    const key = path.join(at.disposable, "via", "machine_ed25519");
    expect(yield* keyPathFor(key, at.own)).toEqual(writable(sticky, true));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
