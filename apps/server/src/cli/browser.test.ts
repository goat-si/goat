import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { setupBaseDir } from "./browser.ts";

// A passwd entry cannot carry a drive-letter home, and sudo with getent is a POSIX setup path.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "sudo browser setup resolves the invoking user's home and respects explicit overrides",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-browser-home-" });
      const userHome = path.join(root, "alice");
      const old = path.join(userHome, ".goat", "tools", "sentinel");
      yield* fs.makeDirectory(path.dirname(old), { recursive: true });
      yield* fs.writeFileString(old, "upstream browser data");
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let getentCalls = 0;
      const spawner = lazyChildProcessSpawner((command) => {
        assert.equal(command._tag, "StandardCommand");
        if (command._tag !== "StandardCommand") return Effect.die("unexpected pipe");
        assert.equal(command.command, "getent");
        assert.deepEqual(command.args, ["passwd", "alice"]);
        getentCalls++;
        return realSpawner.spawn(
          ChildProcess.make(process.execPath, [
            "-e",
            "process.stdout.write(process.argv[1])",
            `alice:x:1000:1000::${userHome}:/bin/sh\n`,
          ]),
        );
      });
      const resolve = (explicit: Option.Option<string>, env: NodeJS.ProcessEnv) =>
        setupBaseDir(explicit).pipe(
          Effect.provideService(HostProcess.Environment, env),
          Effect.provideService(HostProcess.HomeDirectory, path.join(root, "root")),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      // alice still keeps her state in the legacy home, so it stays selected.
      yield* fs.makeDirectory(path.join(userHome, ".t3", "userdata"), { recursive: true }); // goat-rename: legacy
      const selected = yield* resolve(Option.none(), { SUDO_USER: "alice" });
      assert.equal(selected, path.join(userHome, ".t3")); // goat-rename: legacy
      yield* fs.makeDirectory(path.join(selected, "tools"), { recursive: true });
      yield* fs.writeFileString(path.join(selected, "tools", "sentinel"), "GOAT browser data");
      assert.equal(
        yield* resolve(Option.some(path.join(root, "explicit")), {
          SUDO_USER: "alice",
          GOAT_HOME: path.join(root, "env"),
        }),
        path.join(root, "explicit"),
      );
      assert.equal(
        yield* resolve(Option.none(), { SUDO_USER: "alice", GOAT_HOME: path.join(root, "env") }),
        path.join(root, "env"),
      );
      assert.equal(getentCalls, 1);
      assert.equal(yield* fs.readFileString(old), "upstream browser data");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/**
 * Records every command. `fc-match` is missing until fonts are installed, unless
 * the host starts with a font; the browser fails to load libnss3 when asked to.
 */

/** A Linux host with apt and GOAT's browser installed under `/t3`. */
