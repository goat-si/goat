import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeHarness, previousVersion } from "./AntigravityInstallation.testkit.ts";
import { launcherTargetPath } from "./AntigravityInstallationLauncher.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Antigravity launchers", (it) => {
  it.effect("pairs a Windows launcher script with the helper beside the executable it runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs
        .makeTempDirectoryScoped({ prefix: "goat-agy-launcher-$$-test-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const runtimeDirectory = path.join(baseDir, "runtime (x64)");
      const launcherDirectory = path.join(baseDir, "launchers");
      const runtimeExecutable = path.join(runtimeDirectory, "agy_acp_server.exe");
      const runtimeHarness = path.join(runtimeDirectory, "localharness_external.exe");
      yield* fs.makeDirectory(runtimeDirectory);
      yield* fs.makeDirectory(launcherDirectory);
      yield* fs.writeFileString(runtimeExecutable, "external server");
      yield* fs.writeFileString(runtimeHarness, "external harness");
      const { installation } = yield* makeHarness({ baseDir, platform: "win32", previous: true });
      const writeLauncher = Effect.fn("test.writeAntigravityLauncher")(function* (
        name: string,
        launch: string,
      ) {
        const launcher = path.join(launcherDirectory, name);
        yield* fs.writeFileString(
          launcher,
          `@echo off\r\nrem Runtime launcher\r\n:: Keep environment setup\r\nset AGY_EXTRA=1\r\n${launch} %*\r\nexit /b\r\n`,
        );
        return launcher;
      });

      const absolute = yield* writeLauncher("agy.cmd", `"${runtimeExecutable}"`);
      expect(yield* installation.resolve(absolute)).toMatchObject({
        executablePath: absolute,
        harnessPath: runtimeHarness,
        source: "override",
        managedVersionDirectory: null,
      });
      const quoted = yield* writeLauncher(
        "quoted.cmd",
        `set "PATH=C:\\Program Files (x86)\\SDK;%PATH%"\r\n"${runtimeExecutable}"`,
      );
      expect(yield* installation.resolve(quoted)).toMatchObject({
        executablePath: quoted,
        harnessPath: runtimeHarness,
      });
      const relative = yield* writeLauncher(
        "relative.BAT",
        `"%~dp0../runtime (x64)/agy_acp_server.exe"`,
      );
      expect(yield* installation.resolve(relative)).toMatchObject({
        executablePath: relative,
        harnessPath: runtimeHarness,
      });

      const managed = yield* installation.resolve();
      const intoManaged = yield* writeLauncher("managed.cmd", `"${managed.executablePath}"`);
      expect(yield* installation.resolve(intoManaged)).toMatchObject({
        executablePath: intoManaged,
        harnessPath: managed.harnessPath,
        version: previousVersion,
        managedVersionDirectory: managed.managedVersionDirectory,
      });
      expect(yield* installation.remove([intoManaged]).pipe(Effect.flip)).toMatchObject({
        operation: "remove",
      });

      const ambiguous = yield* writeLauncher(
        "ambiguous.cmd",
        `"${managed.executablePath}" --version\r\n"${runtimeExecutable}"`,
      );
      expect(yield* installation.resolve(ambiguous).pipe(Effect.flip)).toMatchObject({
        operation: "resolve",
      });

      for (const [name, launch] of [
        ["comment.cmd", `rem Previous runtime: "${runtimeExecutable}"\r\n"%AGY_TARGET%"`],
        ["label-comment.cmd", `:: "${runtimeExecutable}"\r\n"%AGY_TARGET%"`],
        ["echo.cmd", `echo "${runtimeExecutable}"`],
        [
          "conditional.cmd",
          `if defined AGY_TARGET "%AGY_TARGET%" %* & exit /b\r\n"${runtimeExecutable}"`,
        ],
        ["early-exit.cmd", `exit /b\r\n"${runtimeExecutable}"`],
        ["continued-set.cmd", `set IGNORED=1^\r\n"${runtimeExecutable}"`],
        [
          "chained-comment.cmd",
          `rem setup & "${managed.executablePath}"\r\n"${runtimeExecutable}"`,
        ],
        ["chained.cmd", `"${runtimeExecutable}" --version && "%AGY_TARGET%"`],
        ["unquoted-parens.cmd", `set PATH=C:\\Program Files (x86)\\SDK\r\n"${runtimeExecutable}"`],
        [
          "quoted-chained.cmd",
          `set "PATH=C:\\Program Files (x86)" & "${managed.executablePath}"\r\n"${runtimeExecutable}"`,
        ],
        ["quoted-redirect.cmd", `set "AGY_MODE=1" > nul\r\n"${runtimeExecutable}"`],
        ["quoted-block.cmd", `(set "AGY_MODE=1")\r\n"${runtimeExecutable}"`],
        ["quoted-expansion.cmd", `set Q="\r\nset "X=%Q%&exit /b&rem ()"\r\n"${runtimeExecutable}"`],
      ] as const) {
        const uncertain = yield* writeLauncher(name, launch);
        expect(yield* installation.resolve(uncertain).pipe(Effect.flip)).toMatchObject({
          operation: "resolve",
        });
      }

      const win32 = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));
      const serverOnC: Path.Path = {
        ...win32,
        resolve: (...segments) => win32.resolve("C:\\t3", ...segments),
      };
      const launcherOnD = "D:\\launchers\\agy.cmd";
      for (const [written, expected] of [
        ["\\runtime\\agy_acp_server.exe", null],
        ["C:runtime\\agy_acp_server.exe", null],
        ["%~dp0runtime\\agy_acp_server.exe", "D:\\launchers\\runtime\\agy_acp_server.exe"],
        ["\\\\server\\share\\agy_acp_server.exe", "\\\\server\\share\\agy_acp_server.exe"],
        ["D:/runtime/agy_acp_server.exe", "D:\\runtime\\agy_acp_server.exe"],
        ["//server/share/agy_acp_server.exe", "\\\\server\\share\\agy_acp_server.exe"],
      ] as const) {
        expect(launcherTargetPath(serverOnC, launcherOnD, written)).toBe(expected);
      }
    }),
  );
});
