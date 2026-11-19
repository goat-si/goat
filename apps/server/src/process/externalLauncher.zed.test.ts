import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest } from "./externalLauncher.testkit.ts";

it.effect.each(["Zed Nightly", "Zed Preview"])(
  "launches stable Zed on Windows when %s comes first on PATH",
  (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-zed-channels-" });
      // A user folder naming Zed and a channel does not mark either install.
      const programs = path.join(root, "Users", "zedpreview", "Programs");
      const prereleaseBin = path.join(programs, channel, "bin");
      const stableBin = path.join(programs, "Zed", "bin");
      for (const dir of [prereleaseBin, stableBin]) {
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(path.join(dir, "zed.EXE"), "");
      }
      const env = { PATH: `${prereleaseBin};${stableBin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

      const launchZed = Effect.gen(function* () {
        let spawned: ChildProcess.StandardCommand | undefined;
        yield* Effect.gen(function* () {
          const launcher = yield* ExternalLauncher.ExternalLauncher;
          yield* launcher.launchEditor({ editor: "zed", cwd: "C:\\workspace" });
        }).pipe(
          Effect.provide(
            layerTest({
              platform: "win32",
              env,
              onSpawn: (command) => {
                spawned = command;
              },
            }),
          ),
        );
        assert.ok(spawned);
        return spawned;
      });

      const stable = yield* launchZed;
      assert.equal(stable.command, path.join(stableBin, "zed.EXE"));
      assert.deepEqual(stable.args, ["C:\\workspace"]);

      env.PATH = `${stableBin};${prereleaseBin}`;
      assert.equal((yield* launchZed).command, "zed");

      env.PATH = `${prereleaseBin};${stableBin}`;
      // With only the prerelease install left, it still opens by name.
      yield* fs.remove(path.join(stableBin, "zed.EXE"));
      assert.equal((yield* launchZed).command, "zed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["linux", "darwin"] as const)(
  "opens the later Zed editor when OpenZFS shadows it on PATH (%s)",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-zed-shadow-" });
      const first = path.join(home, "first");
      const second = path.join(home, "second");
      const system = path.join(home, "system");
      for (const dir of [first, second, system]) yield* fs.makeDirectory(dir);
      for (const dir of [first, second]) {
        const executable = path.join(dir, "zed");
        yield* fs.writeFileString(executable, "fixture");
        yield* fs.chmod(executable, 0o755);
      }
      const isolatedPath: Path.Path = {
        ...path,
        join: (...parts) =>
          path.join(
            ...parts.map((part) =>
              ["/usr/local/bin", "/usr/bin", "/snap/bin", "/Applications"].includes(part)
                ? system
                : part,
            ),
          ),
      };
      let launched = "";
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: "zed", cwd: home });
      }).pipe(
        Effect.provide(
          layerTest({
            platform,
            env: { HOME: home, PATH: `${first}:${second}` },
            path: isolatedPath,
            onSpawn: (command) => {
              if (command.args[0] !== "--version") launched = command.command;
            },
            spawnResult: (command) =>
              command.args[0] === "--version"
                ? command.command === path.join(second, "zed")
                  ? { stdout: "Zed 0.200.0\n" }
                  : { exitCode: 1 }
                : undefined,
          }),
        ),
      );
      assert.equal(launched, path.join(second, "zed"));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
