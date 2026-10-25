import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as LocalGoatServers from "./localGoatServers.ts";
import { databasesByPid, looksLikeGoatServer } from "./localGoatServers.ts";

describe("local GOAT server discovery", () => {
  it("recognises the server entry points the desktop app, dev runner and service start", () => {
    expect(
      looksLikeGoatServer(
        "/Users/me/.goat/runtime/goat/versions/0.1.2/goat serve --host 127.0.0.1 --port 3774 --base-dir /Users/me/.goat",
      ),
    ).toBe(true);
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/MacOS/GOAT /Applications/GOAT.app/Contents/Resources/app/apps/server/dist/bin.mjs --bootstrap-fd 3",
      ),
    ).toBe(true);
    expect(looksLikeGoatServer("node /work/goat/apps/server/src/bin.ts serve --port 1")).toBe(true);
    // Every way the CLI runs a server: no subcommand, only flags, or start.
    for (const command of [
      "/usr/local/bin/goat start --base-dir /srv/goat-home",
      "/usr/local/bin/goat --base-dir /srv/goat-home",
      "goat",
      "C:\\Tools\\goat.exe start",
      "node /usr/local/lib/node_modules/goat/dist/bin.mjs --port 3774",
    ])
      expect(looksLikeGoatServer(command), command).toBe(true);
    for (const command of [
      "/usr/local/bin/goat thread start --title x",
      "/usr/local/bin/goat storage --dry-run",
      "/Applications/GOAT.app/Contents/MacOS/GOAT",
    ])
      expect(looksLikeGoatServer(command), command).toBe(false);
    // Helpers, test runners and editors that only mention a GOAT path are not servers.
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/Frameworks/GOAT Helper (Renderer).app --type=renderer",
      ),
    ).toBe(false);
    expect(looksLikeGoatServer("node /work/goat/node_modules/.bin/vitest run")).toBe(false);
    expect(
      looksLikeGoatServer(
        "/Applications/GOAT.app/Contents/MacOS/GOAT /Applications/GOAT.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs cua-lease-proxy --control c",
      ),
    ).toBe(false);
  });

  it("reads which database each process holds open from lsof field output", () => {
    const output = [
      "p101",
      "f19",
      "i39914287",
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite",
      "f20",
      "i39914288",
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite-wal",
      "p202",
      "f3",
      "n/dev/null",
      "p303",
      "f9",
      "n/Users/me/.goat/userdata/statev2.sqlite",
    ].join("\n");
    expect([...databasesByPid(output)]).toEqual([
      [
        101,
        [
          {
            path: "/Users/me/.goat/desktop/userdata/statev2.sqlite",
            inode: "39914287",
            deleted: false,
          },
        ],
      ],
      [303, [{ path: "/Users/me/.goat/userdata/statev2.sqlite", inode: null, deleted: false }]],
    ]);
  });

  it.live(
    "respects the nightly desktop home's bindings while it exists, and skips it once gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-homes-" }),
        );
        const nightlyHome = path.join(home, ".goat", "desktop-nightly");
        const nightly = path.join(nightlyHome, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(nightly), { recursive: true });
        // The nightly copy's threads point at stable's worktrees by absolute path.
        const stableWorktree = path.join(home, ".goat", "desktop", "worktrees", "goat", "feature");
        const db = new NodeSqlite.DatabaseSync(nightly);
        db.exec(
          "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT);" +
            "CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT);",
        );
        db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run(
          "thread-nightly",
          JSON.stringify({ worktreePath: stableWorktree }),
        );
        db.close();
        const own = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
        const check = Effect.gen(function* () {
          const servers = yield* LocalGoatServers.LocalGoatServers;
          const found = yield* servers.otherServers(own);
          expect(found.databases).toEqual([nightly]);
          expect(found.worktreePaths).toEqual([stableWorktree]);

          yield* fs.remove(nightlyHome, { recursive: true });
          const gone = yield* servers.otherServers(own);
          expect(gone.databases).toEqual([]);
          expect(gone.worktreePaths).toEqual([]);
          expect(gone.unverified.some((reason) => reason.includes("desktop-nightly"))).toBe(false);
        });
        yield* check.pipe(
          Effect.provide(
            LocalGoatServers.layer.pipe(
              // This platform never lists processes, so only the known homes are read.
              Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
            ),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, {}),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("counts a database it cannot reach as unchecked, never as absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-homes-" }));
      const own = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
      // A known home whose folder lost its permissions while its server keeps the database open.
      const locked = path.join(home, ".goat", "userdata");
      const lockedDatabase = path.join(locked, "statev2.sqlite");
      yield* fs.makeDirectory(locked, { recursive: true });
      new NodeSqlite.DatabaseSync(lockedDatabase).close();
      // A database a running server holds open that this check cannot find on disk.
      const held = path.join(home, "custom", "userdata", "statev2.sqlite");
      const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.succeed(
            input.command === "ps"
              ? output("  4242     1   501 Sat Oct 25 10:00:00 2026 /usr/local/bin/goat serve\n")
              : output("p4242\nn" + held + "\n"),
          ),
      });
      yield* fs.chmod(locked, 0o000);
      const found = yield* Effect.gen(function* () {
        return yield* (yield* LocalGoatServers.LocalGoatServers).otherServers(own);
      }).pipe(
        Effect.provide(LocalGoatServers.layer.pipe(Layer.provide(runner))),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.UserId, 501),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.ensuring(fs.chmod(locked, 0o755).pipe(Effect.orDie)),
      );
      expect(found.databases).toEqual([]);
      for (const database of [lockedDatabase, held])
        expect(
          found.unverified.some((reason) => reason.includes(database)),
          database,
        ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("never reads a different file for a database a server holds open after deletion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-homes-" }));
      const own = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
      // A replacement at the path the server opened: it holds none of that server's bindings.
      const database = path.join(home, "custom", "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(database), { recursive: true });
      const replacement = new NodeSqlite.DatabaseSync(database);
      replacement.exec(
        "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT);" +
          "CREATE TABLE projection_projects (workspace_root TEXT, deleted_at TEXT);",
      );
      replacement.close();
      const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
        stdout,
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      });
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.succeed(
            input.command === "ps"
              ? output("  4242     1   501 Sat Oct 25 10:00:00 2026 node dist/bin.mjs\n")
              : output("p4242\nf7\ni1\nn" + database + "\n"),
          ),
      });
      const folder = yield* fs.stat(home);
      // Linux names a deleted file a process still holds as "<path> (deleted)".
      const linuxProc: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (target, options) =>
          target === "/proc"
            ? Effect.succeed(["4242"])
            : target === "/proc/4242/fd"
              ? Effect.succeed(["7"])
              : fs.readDirectory(target, options),
        stat: (target) =>
          target === "/proc/4242"
            ? Effect.succeed({ ...folder, uid: Option.some(501) })
            : fs.stat(target),
        readLink: (target) =>
          target === "/proc/4242/fd/7"
            ? Effect.succeed(database + " (deleted)")
            : fs.readLink(target),
      };
      for (const platform of ["darwin", "linux"] as const) {
        const found = yield* Effect.gen(function* () {
          return yield* (yield* LocalGoatServers.LocalGoatServers).otherServers(own);
        }).pipe(
          Effect.provide(LocalGoatServers.layer.pipe(Layer.provide(runner))),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.UserId, 501),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(FileSystem.FileSystem, platform === "linux" ? linuxProc : fs),
        );
        expect(found.databases, platform).toEqual([]);
        expect(
          found.unverified.some((reason) => reason.includes(database)),
          platform,
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
