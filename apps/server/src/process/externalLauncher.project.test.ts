import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

it.effect.each([
  { editor: "webstorm", installPath: "Applications/WebStorm 2026.2.app/Contents/MacOS/webstorm" },
  { editor: "idea", installPath: "Applications/IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea" },
] as const)(
  "discovers and launches $editor from a versioned macOS bundle",
  ({ editor, installPath }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-editor-versioned-" });
      const executable = path.join(home, installPath);
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      yield* fs.chmod(executable, 0o755);

      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        assert.include(yield* launcher.resolveAvailableEditors(), editor);
        yield* launcher.launchEditor({ editor, cwd: "/workspace with spaces/file.ts:12:4" });
        yield* launcher.launchEditor({
          editor,
          cwd: "/workspace with spaces/file.ts:12:4",
          projectRoot: "/workspace with spaces",
        });
        // A relative root, or one that reads as a flag, never reaches the command line.
        for (const projectRoot of ["--wait", "workspace with spaces"])
          yield* launcher.launchEditor({
            editor,
            cwd: "/workspace with spaces/file.ts:12:4",
            projectRoot,
          });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "darwin",
            env: { HOME: home, PATH: path.join(home, "empty") },
            onSpawn: (command) => {
              spawned.push(command);
            },
          }),
        ),
      );

      assert.ok(spawned[0]);
      assert.equal(spawned[0].command, executable);
      assert.deepEqual(spawned[0].args, [
        "--line",
        "12",
        "--column",
        "3",
        "/workspace with spaces/file.ts",
      ]);
      assert.deepEqual(spawned[1]?.args, [
        "/workspace with spaces",
        "--line",
        "12",
        "--column",
        "3",
        "/workspace with spaces/file.ts",
      ]);
      assert.deepEqual(
        spawned.slice(2).map((command) => command.args),
        [spawned[0].args, spawned[0].args],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// A project opened from GOAT must not replace the editor's last active window.
if (!windowsHost)
  it.effect("opens a project folder in a new VS Code window and a file in the existing one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-editors-" });
      const project = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-project-" });
      const codePath = path.join(binDir, "code");
      yield* fileSystem.writeFileString(codePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(codePath, 0o755);
      const file = `${path.join(project, "file.ts")}:3:7`;

      const spawned: ChildProcess.StandardCommand[] = [];
      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: "vscode", cwd: project });
        yield* launcher.launchEditor({ editor: "vscode", cwd: file });
      }).pipe(
        Effect.provide(
          layerTest({
            platform: "linux",
            env: { PATH: binDir, DISPLAY: ":0" },
            onSpawn: (command) => spawned.push(command),
          }),
        ),
        Effect.provideService(HostProcess.Environment, { PATH: binDir, DISPLAY: ":0" }),
      );

      assert.deepEqual(
        spawned.map((command) => command.args),
        [
          ["--new-window", project],
          ["--goto", file],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
