import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

// Windows drive letters cannot resolve the POSIX xdg stubs.
it.effect.skipIf(windowsHost)(
  "a Linux server without a display offers and opens the file manager on the desktop session's display",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["xdg-open", "xdg-mime"]) {
        const filePath = path.join(binDir, name);
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\n");
        yield* fileSystem.chmod(filePath, 0o755);
      }

      const fileManager = (sessionEnv: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const spawned: ChildProcess.StandardCommand[] = [];
          const result = yield* Effect.gen(function* () {
            const launcher = yield* ExternalLauncher.ExternalLauncher;
            const editors = yield* launcher.resolveAvailableEditors();
            const kind = yield* launcher.resolveFileManagerRevealKind();
            const opened = yield* launcher
              .launchEditor({ editor: "file-manager", cwd: "/workspace" })
              .pipe(Effect.exit);
            return { offered: editors.includes("file-manager"), kind, opened };
          }).pipe(
            Effect.provide(
              layerTest({
                platform: "linux",
                env: { PATH: binDir },
                onSpawn: (command) => spawned.push(command),
                spawnResult: (command) =>
                  command.command === "busctl"
                    ? { stdout: JSON.stringify({ type: "as", data: sessionEnv }) }
                    : command.command === "xdg-mime"
                      ? { stdout: "org.kde.dolphin.desktop\n" }
                      : undefined,
              }),
            ),
            Effect.provideService(HostProcess.Environment, { PATH: binDir }),
          );
          const open = spawned.find((command) => command.command === "xdg-open");
          return { ...result, open: open && { args: open.args, env: open.options.env } };
        });

      const session = yield* fileManager(["DISPLAY=:0", "HOME=/home/user"]);
      assert.equal(session.offered, true);
      assert.equal(session.kind, "files");
      assert.equal(Exit.isSuccess(session.opened), true);
      assert.deepEqual(session.open, {
        args: ["/workspace"],
        env: { PATH: binDir, DISPLAY: ":0" },
      });

      // No one is logged in to a desktop, so there is no screen to open it on.
      const headless = yield* fileManager(["HOME=/home/user"]);
      assert.equal(headless.offered, false);
      assert.equal(headless.kind, undefined);
      assert.equal(Exit.isFailure(headless.opened), true);
      assert.equal(headless.open, undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
