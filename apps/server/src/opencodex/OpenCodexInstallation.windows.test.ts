import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as ProcessRunner from "../processRunner.ts";
import * as Installation from "./OpenCodexInstallation.ts";
import { makeWorld, urlOf, WINDOWS_TARGET } from "./OpenCodexInstallation.testkit.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const reasonOf = <A>(effect: Effect.Effect<A, Installation.OpenCodexInstallationError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const windowsAsset = {
  version: "2.93.0",
  target: WINDOWS_TARGET,
  url: urlOf("2.93.0"),
  sha256: "0".repeat(64),
  archiveBytes: 1,
  publishedAt: "2026-10-24T00:00:00Z",
  layout: { executable: "ocx.exe", gui: "gui/dist/index.html", keyring: "keyring" },
  remoteLinkWindows: true,
};
const listed = (names: ReadonlyArray<string>) =>
  Installation.safeListing(
    windowsAsset,
    names,
    names.map((name) => (name.endsWith("\\") ? "drwxrwxrwx " : "-rw-rw-rw- ") + name),
    true,
  );
const layout = ["ocx.exe", "gui\\", "gui\\dist\\index.html", "keyring\\", "keyring\\keyring.node"];

it.each([
  ["a drive-qualified name", "C:\\ocx.exe"],
  ["a UNC name", "\\\\server\\share\\ocx.exe"],
  ["an absolute name", "\\keyring\\other.node"],
  ["a traversal name", "gui\\..\\..\\escape.txt"],
  ["an alternate data stream", "gui\\dist\\index.html:payload"],
  ["a name that differs only in case", "OCX.EXE"],
  ["a root outside the layout", "tools\\ocx.exe"],
])("a Windows zip listing with %s is refused", (_, name) => {
  expect(listed(layout)).toBe(true);
  expect(listed([...layout, name])).toBe(false);
});

it("Windows zip member names with backslashes are normalized only on Windows", () => {
  expect(listed(layout)).toBe(true);
  expect(
    Installation.safeListing(
      windowsAsset,
      layout,
      layout.map((name) => `-rw-r--r-- ${name}`),
      false,
    ),
  ).toBe(false);
});

/** Two pinned Windows releases whose Remote Link accepts a Windows Child; test fixtures only. */
const windowsWorld = Effect.fn("OpenCodexInstallationWindowsTest.world")(function* (
  remoteLinkWindows = true,
) {
  const world = yield* makeWorld();
  const first = yield* world.archive("2.92.0", { executable: "ocx.exe" });
  const next = yield* world.archive("2.93.0", { executable: "ocx.exe" });
  const catalog = {
    ...world.pin("2.92.0", first, {}, { remoteLinkWindows }),
    ...world.pin("2.93.0", next, {}, { remoteLinkWindows }),
  };
  const served = { [urlOf("2.92.0")]: first.bytes, [urlOf("2.93.0")]: next.bytes };
  const current = world.path.join(world.prefix, "current");
  const release = (version: string) =>
    world.path.join(world.prefix, `${version}-${WINDOWS_TARGET}`);
  const entries = world.fs
    .readDirectory(world.prefix)
    .pipe(Effect.map((names) => names.filter((name) => name !== ".install-lock.sqlite").sort()));
  return { ...world, catalog, served, current, release, entries };
});

it.live(
  "Windows installs only a pinned x64 release whose Remote Link accepts a Windows Child",
  () =>
    Effect.gen(function* () {
      const unpinned = yield* windowsWorld(false);
      const refusing = yield* unpinned.installer(unpinned.catalog, unpinned.served, {
        platform: "win32",
      });
      expect(yield* reasonOf(refusing.install())).toBe("unsupported");
      const pinned = yield* windowsWorld();
      const arm = yield* pinned.installer(pinned.catalog, pinned.served, {
        platform: "win32",
        arch: "arm64",
      });
      expect(yield* reasonOf(arm.install())).toBe("unsupported");
      expect([...unpinned.downloads, ...pinned.downloads]).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "a standard Windows user activates and rolls back immutable versions through the current junction",
  () =>
    Effect.gen(function* () {
      const world = yield* windowsWorld();
      const service = yield* world.installer(world.catalog, world.served, { platform: "win32" });
      const installed = yield* service.install();
      expect(installed).toMatchObject({ version: "2.92.0", ownership: "managed" });
      expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.92.0"));
      expect((yield* service.install({ managedVersion: "2.93.0" })).version).toBe("2.93.0");
      expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.93.0"));
      // A managed downgrade reuses the retained release instead of downloading it again.
      expect((yield* service.install({ managedVersion: "2.92.0" })).version).toBe("2.92.0");
      expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.92.0"));
      expect(world.downloads).toEqual([urlOf("2.92.0"), urlOf("2.93.0")]);
      // Both immutable versions stay; no journal or swap entry is left behind.
      expect(yield* world.entries).toEqual([
        `2.92.0-${WINDOWS_TARGET}`,
        `2.93.0-${WINDOWS_TARGET}`,
        "current",
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "a failed Windows activation restores the previous owned junction without removing its runtime",
  () =>
    Effect.gen(function* () {
      const world = yield* windowsWorld();
      const first = yield* world.installer(world.catalog, world.served, { platform: "win32" });
      yield* first.install();
      for (const failing of ["moving current aside", "publishing the next junction"] as const) {
        const service = yield* world.installer(world.catalog, world.served, {
          platform: "win32",
          fs: {
            // A sharing violation at one of the two activation renames; recovery's own rename
            // back to current still succeeds.
            beforeRename: (from, to) =>
              (
                failing === "moving current aside"
                  ? from === world.current
                  : to === world.current && from.endsWith(".next")
              )
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Busy",
                      module: "FileSystem",
                      method: "rename",
                    }),
                  )
                : Effect.void,
          },
        });
        expect([failing, yield* reasonOf(service.install({ managedVersion: "2.93.0" }))]).toEqual([
          failing,
          "activation",
        ]);
        expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.92.0"));
        expect(yield* world.entries).toEqual([
          `2.92.0-${WINDOWS_TARGET}`,
          `2.93.0-${WINDOWS_TARGET}`,
          "current",
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live(
  "an interrupted Windows activation recovers its owned journal before selecting an executable",
  () =>
    Effect.gen(function* () {
      const world = yield* windowsWorld();
      const first = yield* world.installer(world.catalog, world.served, { platform: "win32" });
      yield* first.install();
      // The process dies between moving current aside and publishing the next junction.
      const crashing = yield* world.installer(world.catalog, world.served, {
        platform: "win32",
        fs: {
          beforeRename: (from, to) =>
            to === world.current && from.endsWith(".next") ? Effect.die("crash") : Effect.void,
        },
      });
      expect(
        Exit.isFailure(yield* Effect.exit(crashing.install({ managedVersion: "2.93.0" }))),
      ).toBe(true);
      expect(yield* world.fs.exists(world.current)).toBe(false);
      expect(yield* world.fs.exists(world.path.join(world.prefix, ".activation.json"))).toBe(true);
      const downloads = world.downloads.length;
      const restarted = yield* world.installer(world.catalog, world.served, { platform: "win32" });
      expect(yield* restarted.install()).toMatchObject({ version: "2.92.0", ownership: "managed" });
      expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.92.0"));
      expect(world.downloads).toHaveLength(downloads);
      expect(yield* world.entries).toEqual([
        `2.92.0-${WINDOWS_TARGET}`,
        `2.93.0-${WINDOWS_TARGET}`,
        "current",
      ]);
      // A journal GOAT cannot vouch for is refused and nothing is changed.
      yield* world.fs.writeFileString(world.path.join(world.prefix, ".activation.json"), "{}");
      expect(yield* reasonOf(restarted.install({ managedVersion: "2.93.0" }))).toBe("activation");
      expect(yield* world.fs.realPath(world.current)).toBe(world.release("2.92.0"));
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("Windows keeps a supported Desktop ocx and refuses an older one that shadows GOAT's", () =>
  Effect.gen(function* () {
    const world = yield* windowsWorld();
    const desktop = world.path.join(world.home, ".opencodex-desktop", "bin", "ocx.exe");
    yield* world.userOcx(desktop, "2.70.0");
    const service = yield* world.installer(world.catalog, world.served, { platform: "win32" });
    expect(yield* service.install()).toMatchObject({ path: desktop, ownership: "adopted" });
    yield* world.userOcx(desktop, "2.65.0");
    expect(yield* reasonOf(service.install())).toBe("shadowed");
    expect(world.downloads).toEqual([]);
    expect(yield* world.fs.exists(world.current)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(services)),
);
