// @effect-diagnostics nodeBuiltinImport:off -- Fakes the detached Windows cleanup process.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";
import { afterEach, vi } from "vite-plus/test";

import * as BootService from "../cloud/bootService.ts";
import { findOwnedLauncher, spawnWindowsRemoval, uninstallCommand } from "./uninstall.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(() => new actual.ChildProcess()) };
});

afterEach(() => vi.restoreAllMocks());

const absentService = BootService.BootService.of({
  status: Effect.succeed({
    supported: true,
    installed: false,
    current: false,
    unitPath: "",
    logPath: "",
  }),
  withStopped: (operation) => operation,
  restart: Effect.succeed("skipped" as const),
  install: () => Effect.die("uninstall test must not install"),
  uninstall: Effect.succeed(false),
});

it.layer(NodeServices.layer)("goat uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-uninstall-" });
      const versionsDir = path.join(root, "runtime/goat/versions");
      const exe = path.join(versionsDir, "1.0.0/goat");
      const otherExe = path.join(root, "other/runtime/goat/versions/1.0.0/goat");
      const copy = path.join(root, "copy/goat");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/goat");
      const theirs = path.join(root, "other/bin/goat");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(yield* findOwnedLauncher({ launchedAs: ours, versionsDir }), ours);
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer))(
  "goat uninstall",
  (it) => {
    const run = (baseDir: string) =>
      Command.runWith(uninstallCommand, { version: "0.0.0" })([
        "--yes",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

    it.effect("points a source checkout at npm uninstall -g goat", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-uninstall-" });
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, absentService),
        );

        yield* run(baseDir);

        const output = (yield* TestConsole.logLines).join("\n");
        expect(output).toContain("`npm uninstall -g goat`");
        expect(output).not.toContain("npm uninstall -g t3");
      }),
    );

    it.effect("removes service state left beside the downloaded runtime", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-uninstall-" });
        const versionDir = path.join(baseDir, "runtime/goat/versions/1.0.0");
        yield* fs.makeDirectory(versionDir, { recursive: true });
        yield* fs.writeFileString(path.join(versionDir, "goat"), "");
        yield* fs.writeFileString(path.join(baseDir, "runtime/service-state.json"), "{}\n");
        yield* fs.writeFileString(path.join(baseDir, "runtime/.service-stopping"), "");
        yield* fs.writeFileString(path.join(baseDir, "runtime/.restart-pending"), "1.0.0\n");
        yield* fs.makeDirectory(path.join(baseDir, "runtime/archives"), { recursive: true });
        yield* fs.writeFileString(path.join(baseDir, "runtime/archives/keep.txt"), "keep");
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, absentService),
        );

        yield* run(baseDir);

        expect(yield* fs.exists(path.join(baseDir, "runtime/goat"))).toBe(false);
        expect(yield* fs.exists(path.join(baseDir, "runtime/service-state.json"))).toBe(false);
        expect(yield* fs.exists(path.join(baseDir, "runtime/.service-stopping"))).toBe(false);
        expect(yield* fs.exists(path.join(baseDir, "runtime/.restart-pending"))).toBe(false);
        expect(yield* fs.readFileString(path.join(baseDir, "runtime/archives/keep.txt"))).toBe(
          "keep",
        );
      }),
    );
  },
);

it("passes the Windows removal directory literally with delayed expansion disabled", () => {
  const spawn = vi.mocked(NodeChildProcess.spawn);
  spawn.mockClear();
  const runtimeDir = "C:\\GOAT home %COMSPEC% !COMSPEC! & data\\runtime\\goat";
  spawnWindowsRemoval("fake-cmd.exe", runtimeDir);
  expect(spawn).toHaveBeenCalledWith(
    "fake-cmd.exe",
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"ping -n 3 127.0.0.1 >nul & rmdir /s /q "%GOAT_UNINSTALL_RUNTIME%""',
    ],
    expect.objectContaining({
      env: expect.objectContaining({ GOAT_UNINSTALL_RUNTIME: runtimeDir }),
      windowsVerbatimArguments: true,
    }),
  );
});
