// @effect-diagnostics nodeBuiltinImport:off - a second process holds the install lock.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as Installation from "./OpenCodexInstallation.ts";
import {
  fakeOcx,
  installedWorld,
  makeWorld,
  TARGET,
  urlOf,
} from "./OpenCodexInstallation.testkit.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const reasonOf = <A>(effect: Effect.Effect<A, Installation.OpenCodexInstallationError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.live(
  "installs the complete pinned archive without npm and marks only its selected executable managed",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const built = yield* world.archive("2.92.0");
      const npmLog = world.path.join(world.root, "npm.log");
      yield* world.fs.writeFileString(
        world.path.join(world.userBin, "npm"),
        `#!/bin/sh\necho "$*" >> '${npmLog}'\nexit 1\n`,
        { mode: 0o755 },
      );
      const service = yield* world.installer(world.pin("2.92.0", built), {
        [urlOf("2.92.0")]: built.bytes,
      });
      const executable = yield* service.install();
      const release = world.path.join(world.prefix, `2.92.0-${TARGET}`);
      expect(executable).toEqual({
        path: world.path.join(world.home, ".local", "bin", "ocx"),
        realPath: world.path.join(release, "ocx"),
        version: "2.92.0",
        ownership: "managed",
      });
      // The whole standalone layout lands next to the executable, under the resolved home.
      expect(yield* world.fs.realPath(world.launcher)).toBe(world.path.join(release, "ocx"));
      expect(yield* world.fs.exists(world.path.join(release, "gui", "dist", "index.html"))).toBe(
        true,
      );
      expect(yield* world.fs.exists(world.path.join(release, "keyring", "keyring.node"))).toBe(
        true,
      );
      expect(
        JSON.parse(yield* world.fs.readFileString(world.path.join(release, ".goat-install.json"))),
      ).toEqual({
        schemaVersion: 1,
        root: release,
        target: TARGET,
        version: "2.92.0",
        sha256: built.sha256,
      });
      expect(yield* service.inspect(executable.path, "2.92.0")).toBe(true);
      expect(yield* world.fs.exists(npmLog)).toBe(false);
      expect(world.downloads).toEqual([urlOf("2.92.0")]);
      // Asked again, the supported install it now selects is kept.
      expect(yield* world.fs.readDirectory(world.path.dirname(world.launcher))).toEqual(["ocx"]);
      expect((yield* service.install()).realPath).toBe(executable.realPath);
      expect(world.downloads).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("keeps a supported adopted ocx without downloading or writing an ownership marker", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    yield* world.userOcx(world.desktop, "2.70.0");
    const service = yield* world.installer({}, {});
    expect(yield* service.install()).toMatchObject({
      path: world.desktop,
      version: "2.70.0",
      ownership: "adopted",
    });
    expect(world.downloads).toEqual([]);
    expect(yield* world.releaseDirectories).toEqual([]);
    expect(yield* world.fs.exists(world.launcher)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("refuses an older shadowing ocx instead of replacing software GOAT does not own", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    const built = yield* world.archive("2.92.0");
    yield* world.userOcx(world.desktop, "2.65.0");
    const service = yield* world.installer(world.pin("2.92.0", built), {
      [urlOf("2.92.0")]: built.bytes,
    });
    expect(yield* reasonOf(service.install())).toBe("shadowed");
    expect(yield* reasonOf(service.install({ managedVersion: "2.92.0" }))).toBe("not-managed");
    expect(world.downloads).toEqual([]);
    expect(yield* world.fs.readFileString(world.desktop)).toBe(fakeOcx("2.65.0"));
    expect(yield* world.fs.exists(world.launcher)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("refuses an unpinned target or version without downloading", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    const built = yield* world.archive("2.92.0");
    const row = world.pin("2.92.0", built)["2.92.0"]!["linux-x64"]!;
    const service = yield* world.installer(
      { "2.92.0": { "linux-arm64": row } },
      { [urlOf("2.92.0")]: built.bytes },
    );
    expect(yield* reasonOf(service.install())).toBe("unsupported");
    expect(yield* reasonOf(service.install({ managedVersion: "9.9.9" }))).toBe("unsupported");
    expect(world.downloads).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "rejects changed digest or byte count before extraction and preserves the active release",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      for (const change of [
        { sha256: "0".repeat(64) },
        { bytes: world.next.bytes.byteLength - 1 },
      ]) {
        const service = yield* world.installer(
          { ...world.catalog, ...world.pin("2.93.0", world.next, change) },
          world.served,
        );
        expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("download");
        expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
        expect(yield* world.releaseDirectories).toEqual([`2.92.0-${TARGET}`]);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("rejects traversal symlinks and incomplete standalone archives before activation", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld();
    const { fs, path } = world;
    const escaped = path.join(world.root, "escaped");
    const cases = [
      { name: "absolute", members: ["ocx", "gui", "keyring", escaped] },
      { name: "parent", members: ["ocx", "gui", "keyring", "../../escaped"] },
      {
        name: "symlink",
        edit: (stage: string) => fs.symlink("/etc/passwd", path.join(stage, "gui", "link")),
      },
      {
        name: "hardlink",
        edit: (stage: string) => fs.link(path.join(stage, "ocx"), path.join(stage, "gui", "hard")),
      },
      {
        name: "backslash",
        edit: (stage: string) => fs.writeFileString(path.join(stage, "gui", "a\\b"), ""),
      },
      {
        name: "drive",
        edit: (stage: string) => fs.writeFileString(path.join(stage, "gui", "C:x"), ""),
      },
      { name: "duplicate", members: ["ocx", "gui", "keyring", "keyring/keyring.node"] },
      { name: "no gui", members: ["ocx", "keyring"] },
      { name: "no keyring", members: ["ocx", "gui"] },
    ];
    yield* fs.writeFileString(escaped, "outside");
    for (const testCase of cases) {
      const built = yield* world.archive("2.92.0", testCase);
      const service = yield* world.installer(world.pin("2.92.0", built), {
        [urlOf("2.92.0")]: built.bytes,
      });
      expect([testCase.name, yield* reasonOf(service.install())]).toEqual([
        testCase.name,
        "archive",
      ]);
      expect(yield* fs.exists(world.launcher)).toBe(false);
      expect(yield* world.releaseDirectories).toEqual([]);
    }
    expect(yield* fs.readFileString(escaped)).toBe("outside");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("interrupted extraction leaves the previous managed release selected", () =>
  Effect.gen(function* () {
    const world = yield* installedWorld();
    const extracting = yield* Deferred.make<void>();
    const service = yield* world.installer(world.catalog, world.served, {
      extract: Deferred.succeed(extracting, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const update = yield* service.install({ managedVersion: "2.93.0" }).pipe(Effect.forkChild);
    yield* Deferred.await(extracting);
    yield* Fiber.interrupt(update);
    expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
    // No partial release, staging directory or lock is left behind.
    expect(yield* world.releaseDirectories).toEqual([`2.92.0-${TARGET}`]);
    expect((yield* world.service.install({ managedVersion: "2.93.0" })).version).toBe("2.93.0");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "serializes installs and never treats another process lock as permission to overwrite",
  () =>
    Effect.gen(function* () {
      const world = yield* makeWorld();
      const built = yield* world.archive("2.92.0");
      const service = yield* world.installer(world.pin("2.92.0", built), {
        [urlOf("2.92.0")]: built.bytes,
      });
      const both = yield* Effect.all([service.install(), service.install()], {
        concurrency: "unbounded",
      });
      expect(both.map((executable) => executable.ownership)).toEqual(["managed", "managed"]);
      expect(world.downloads).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

/** Holds the install lock the way another installer process would: an open exclusive handle. */
const holdLock = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const db = new NodeSqlite.DatabaseSync(`${prefix}/.install-lock.sqlite`);
      db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
      return db;
    }),
    (db) => Effect.sync(() => db.close()),
  );

it.live(
  "a second installer is busy while another handle or a live process holds the install lock",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(world.prefix);
          expect(yield* reasonOf(world.service.install({ managedVersion: "2.93.0" }))).toBe("busy");
        }),
      );
      expect((yield* world.service.install({ managedVersion: "2.93.0" })).version).toBe("2.93.0");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const holder = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "-e",
          'const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]); db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); process.stdout.write("held\\n"); setInterval(() => {}, 1 << 30);',
          `${world.prefix}/.install-lock.sqlite`,
        ]),
      );
      yield* holder.stdout.pipe(
        Stream.decodeText(),
        Stream.takeUntil((text) => text.includes("held")),
        Stream.runDrain,
      );
      expect(yield* reasonOf(world.service.install({ managedVersion: "2.92.0" }))).toBe("busy");
      // The OS releases a killed holder's lock: nothing stale is left to reclaim.
      yield* holder.kill({ killSignal: "SIGKILL" });
      yield* holder.exitCode.pipe(Effect.ignore);
      expect((yield* world.service.install({ managedVersion: "2.92.0" })).version).toBe("2.92.0");
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "an adopted launcher inserted at the activation boundary survives and install fails not-managed",
  () =>
    Effect.gen(function* () {
      for (const boundary of ["moving the old launcher", "publishing the new one"] as const) {
        const world = yield* installedWorld();
        const next = world.path.join(world.prefix, `2.93.0-${TARGET}`, "ocx");
        let inserted = false;
        const insert = Effect.suspend(() => {
          if (inserted) return Effect.void;
          inserted = true;
          return world.fs
            .remove(world.launcher)
            .pipe(
              Effect.ignore,
              Effect.andThen(world.userOcx(world.launcher, "2.80.0")),
              Effect.orDie,
            );
        });
        const service = yield* world.installer(world.catalog, world.served, {
          fs:
            boundary === "moving the old launcher"
              ? { beforeRename: (from) => (from === world.launcher ? insert : Effect.void) }
              : { beforeSymlink: (target) => (target === next ? insert : Effect.void) },
        });
        expect([boundary, yield* reasonOf(service.install({ managedVersion: "2.93.0" }))]).toEqual([
          boundary,
          "not-managed",
        ]);
        expect(inserted).toBe(true);
        expect(yield* world.fs.readFileString(world.launcher)).toBe(fakeOcx("2.80.0"));
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "a retained release that reports another version is refused and the previous launcher stays",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      expect((yield* world.service.install({ managedVersion: "2.93.0" })).version).toBe("2.93.0");
      expect((yield* world.service.install({ managedVersion: "2.92.0" })).version).toBe("2.92.0");
      const retained = world.path.join(world.prefix, `2.93.0-${TARGET}`, "ocx");
      yield* world.fs.writeFileString(retained, fakeOcx("9.99.0"), { mode: 0o755 });
      expect(yield* reasonOf(world.service.install({ managedVersion: "2.93.0" }))).toBe("verify");
      expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "a launcher whose new release disappears after publishing is restored to the previous one",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      const next = world.path.join(world.prefix, `2.93.0-${TARGET}`, "ocx");
      const service = yield* world.installer(world.catalog, world.served, {
        fs: {
          afterSymlink: (target) =>
            target === next ? world.fs.remove(next).pipe(Effect.orDie) : Effect.void,
        },
      });
      expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("activation");
      // Restored, not left dangling at the missing release.
      expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
      expect(yield* world.fs.readDirectory(world.path.dirname(world.launcher))).toEqual(["ocx"]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "changing the launcher during download prevents replacement of the new user selection",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      const service = yield* world.installer(world.catalog, world.served, {
        beforeDownload: world.fs
          .remove(world.launcher)
          .pipe(Effect.andThen(world.userOcx(world.launcher, "2.80.0")), Effect.orDie),
      });
      expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("not-managed");
      expect(yield* world.fs.readFileString(world.launcher)).toBe(fakeOcx("2.80.0"));
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "a newly shadowing executable restores the previous owned launcher and reports activation failure",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      const service = yield* world.installer(world.catalog, world.served, {
        beforeDownload: world.userOcx(world.desktop, "2.95.0").pipe(Effect.orDie),
      });
      expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("activation");
      expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
      expect(yield* world.fs.readFileString(world.desktop)).toBe(fakeOcx("2.95.0"));
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("a missing invalid or copied marker never grants managed ownership", () =>
  Effect.gen(function* () {
    const world = yield* installedWorld();
    const { fs, path, service } = world;
    const release = path.dirname(world.installed.realPath);
    const marker = path.join(release, ".goat-install.json");
    const original = JSON.parse(yield* fs.readFileString(marker));
    // A copy of the whole release elsewhere, marker included, is not the install GOAT made.
    const copy = path.join(world.root, "copied");
    yield* fs.copy(release, copy);
    expect(yield* service.inspect(path.join(copy, "ocx"), "2.92.0")).toBe(false);
    expect(yield* service.inspect(world.launcher, "2.93.0")).toBe(false);
    for (const text of [
      "not json",
      JSON.stringify({ ...original, root: copy }),
      JSON.stringify({ ...original, target: "bun-darwin-arm64" }),
      JSON.stringify({ ...original, version: "2.93.0" }),
      JSON.stringify({ ...original, sha256: "f".repeat(64) }),
      JSON.stringify({ ...original, schemaVersion: 2 }),
      JSON.stringify({ ...original, extra: true }),
    ]) {
      yield* fs.writeFileString(marker, text);
      expect([text, yield* service.inspect(world.launcher, "2.92.0")]).toEqual([text, false]);
    }
    yield* fs.remove(marker);
    expect(yield* service.inspect(world.launcher, "2.92.0")).toBe(false);
    // Without its marker the selected install is adopted, and a managed update refuses it.
    expect((yield* service.install()).ownership).toBe("adopted");
    expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("not-managed");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "an adopted launcher inserted right before the rollback survives at the launcher path",
  () =>
    Effect.gen(function* () {
      const world = yield* installedWorld();
      let inserted = false;
      const service = yield* world.installer(world.catalog, world.served, {
        // A Desktop install appears during the download, so activation is rolled back.
        beforeDownload: world.userOcx(world.desktop, "2.95.0").pipe(Effect.orDie),
        fs: {
          beforeRename: (from, to) =>
            from !== world.launcher || !to.endsWith("/rejected") || inserted
              ? Effect.void
              : Effect.sync(() => void (inserted = true)).pipe(
                  Effect.andThen(world.fs.remove(world.launcher)),
                  Effect.andThen(world.userOcx(world.launcher, "2.80.0")),
                  Effect.orDie,
                ),
        },
      });
      expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("activation");
      expect(inserted).toBe(true);
      expect(yield* world.fs.readFileString(world.launcher)).toBe(fakeOcx("2.80.0"));
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("a failed publish after moving the launcher aside restores the previous launcher", () =>
  Effect.gen(function* () {
    const world = yield* installedWorld();
    const next = world.path.join(world.prefix, `2.93.0-${TARGET}`, "ocx");
    let failed = false;
    const service = yield* world.installer(world.catalog, world.served, {
      fs: {
        beforeSymlink: (target) =>
          target !== next || failed
            ? Effect.void
            : Effect.sync(() => void (failed = true)).pipe(
                Effect.andThen(
                  Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "symlink",
                    }),
                  ),
                ),
              ),
      },
    });
    expect(yield* reasonOf(service.install({ managedVersion: "2.93.0" }))).toBe("io");
    expect(failed).toBe(true);
    expect(yield* world.fs.realPath(world.launcher)).toBe(world.installed.realPath);
    expect(yield* world.fs.readDirectory(world.path.dirname(world.launcher))).toEqual(["ocx"]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
