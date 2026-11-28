import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { EDITORS } from "@goat/contracts";
import { resolveEditorCommand } from "@goat/shared/editor";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";
import { layerTest, windowsHost } from "./externalLauncher.testkit.ts";

const withSystemBin = (path: Path.Path, systemBin: string): Path.Path => ({
  ...path,
  join: (...parts) =>
    path.join(
      ...parts.map((part) =>
        ["/Applications", "/usr/local/bin", "/usr/bin", "/snap/bin"].includes(part)
          ? systemBin
          : part,
      ),
    ),
});

it.effect.skipIf(windowsHost)("reports a Finder reveal that open -R rejects", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-editors-" });
    const open = path.join(binDir, "open");
    yield* fileSystem.writeFileString(open, "#!/bin/sh\n");
    yield* fileSystem.chmod(open, 0o755);
    const target = path.join(binDir, "linked-file.txt");
    yield* fileSystem.writeFileString(target, "");

    const exit = yield* Effect.gen(function* () {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      return yield* launcher
        .launchEditor({ editor: "file-manager", cwd: target, reveal: true })
        .pipe(Effect.exit);
    }).pipe(
      Effect.provide(
        layerTest({
          platform: "darwin",
          env: { PATH: binDir },
          spawnResult: (command) => {
            assert.deepEqual(command.args, ["-R", target]);
            return { exitCode: 1 };
          },
        }),
      ),
    );

    assert.ok(Exit.isFailure(exit));
    const error = Cause.squash(exit.cause);
    assert.instanceOf(error, ExternalLauncher.ExternalLauncherEditorSpawnError);
    assert.include(String(error), target);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Stand-ins for a `--version` check. The Cursor Agent CLI installs a cursor script that fails
// when no IDE is behind it, and a slow first start stays silent for longer than the check waits.
const scripts = { works: "", fails: "exit 1", stalls: "exec sleep 30" };
// Each row: title, editor, script first on PATH, extra install, result on darwin, result on linux.
for (const [title, id, first, extra, onDarwin, onLinux = onDarwin] of [
  ["keeps a working cursor on PATH ahead of the bundle", "cursor", "works", "bundle", "cursor"],
  ["keeps a cursor that never answers --version", "cursor", "stalls", "none", "cursor"],
  ["skips a failing cursor for a later cursor on PATH", "cursor", "fails", "later", "later"],
  ["skips a failing cursor for the Cursor bundle", "cursor", "fails", "bundle", "bundle", "none"],
  ["rejects a zed that never answers --version", "zed", "stalls", "none", "none"],
] as const) {
  for (const platform of ["darwin", "linux"] as const) {
    it.effect.skipIf(windowsHost)(`${title} on ${platform}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-editor-check-" });
        const commands = {
          cursor: "cursor",
          none: undefined,
          first: path.join(home, "bin", id),
          later: path.join(home, "later-bin", id),
          bundle: path.join(home, "Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
        };
        for (const key of ["first", extra] as const) {
          if (key === "none") continue;
          yield* fs.makeDirectory(path.dirname(commands[key]), { recursive: true });
          const script = key === "first" ? scripts[first] : scripts.works;
          yield* fs.writeFileString(commands[key], `#!/bin/sh\n${script}\n`);
          yield* fs.chmod(commands[key], 0o755);
        }
        const editor = EDITORS.find((entry) => entry.id === id);
        if (!editor) return yield* Effect.die(new Error(`Missing editor definition: ${id}`));
        const env = { HOME: home, PATH: `${home}/bin:${home}/later-bin` };
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const started = yield* Deferred.make<void>();
        // Signal that the `--version` check has a running process.
        const signal = Deferred.succeed(started, undefined);
        const [resolved] = yield* Effect.all(
          [
            resolveEditorCommand(editor, env).pipe(
              Effect.provideService(HostProcess.Platform, platform),
              Effect.provideService(Path.Path, withSystemBin(path, path.join(home, "system-bin"))),
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((cmd) => spawner.spawn(cmd).pipe(Effect.tap(signal))),
              ),
            ),
            // The check runs on the test clock, so its timeout passes only when the clock moves.
            first === "stalls"
              ? Deferred.await(started).pipe(Effect.andThen(TestClock.adjust("2 seconds")))
              : Effect.void,
          ],
          { concurrency: "unbounded" },
        );
        const expected = commands[platform === "darwin" ? onDarwin : onLinux];
        assert.equal(Option.getOrUndefined(resolved)?.command, expected);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
}
