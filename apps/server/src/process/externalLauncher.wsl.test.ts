import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess } from "effect/process";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

it.effect.skipIf(windowsHost)(
  "WSL file manager open and reveal use mount-aware Windows paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-wsl-" });
      for (const name of ["explorer.exe", "powershell.exe"]) {
        yield* fs.writeFileString(path.join(bin, name), "#!/bin/sh\n");
        yield* fs.chmod(path.join(bin, name), 0o755);
      }
      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: "file-manager", cwd: "/mnt/c/work/a.txt" });
        yield* launcher.launchEditor({
          editor: "file-manager",
          cwd: "/mnt/c/work/a.txt",
          reveal: true,
        });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: bin, WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/interop" },
            existingPaths: ["/mnt/c/work/a.txt"],
            onSpawn: (command) => spawned.push(command),
            spawnResult: (command) =>
              command.command === "wslpath"
                ? { stdout: command.args[1] === "/mnt/c/work" ? "C:\\work\n" : "C:\\work\\a.txt\n" }
                : undefined,
          }),
        ),
      );
      assert.deepEqual(
        spawned.filter((command) => command.command === "wslpath").map((command) => command.args),
        [
          ["-w", "/mnt/c/work/a.txt"],
          ["-w", "/mnt/c/work/a.txt"],
          ["-w", "/mnt/c/work"],
        ],
      );
      const explorer = spawned.find((command) => command.command === "explorer.exe");
      assert.deepEqual(explorer?.args, ["C:\\work\\a.txt"]);
      const powershell = spawned.find((command) => command.command === "powershell.exe");
      assert.ok(powershell);
      const encoded = powershell.args.at(-1);
      assert.isString(encoded);
      if (typeof encoded !== "string") throw new Error("Expected encoded PowerShell command");
      const source = Buffer.from(encoded, "base64").toString("utf16le");
      assert.include(source, "C:\\work\\a.txt");
      assert.include(source, "C:\\work");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "WSL file manager falls back to UNC when wslpath fails or is missing",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "goat-wsl-" });
      yield* fs.writeFileString(path.join(bin, "explorer.exe"), "#!/bin/sh\n");
      yield* fs.chmod(path.join(bin, "explorer.exe"), 0o755);
      for (const missing of [false, true]) {
        const spawned: ChildProcess.StandardCommand[] = [];
        yield* Effect.gen(function* () {
          yield* (yield* ExternalLauncher.ExternalLauncher).launchEditor({
            editor: "file-manager",
            cwd: "/mnt/c/work/a.txt",
          });
        }).pipe(
          Effect.provide(
            layerTest({
              platform: "linux",
              env: { PATH: bin, WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/interop" },
              onSpawn: (command) => spawned.push(command),
              spawnResult: (command) =>
                command.command === "wslpath"
                  ? missing
                    ? {
                        spawnError: PlatformError.systemError({
                          _tag: "NotFound",
                          module: "ChildProcess",
                          method: "spawn",
                        }),
                      }
                    : { exitCode: 1 }
                  : undefined,
            }),
          ),
        );
        assert.deepEqual(spawned.find((command) => command.command === "explorer.exe")?.args, [
          "\\\\wsl.localhost\\Ubuntu\\mnt\\c\\work\\a.txt",
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
