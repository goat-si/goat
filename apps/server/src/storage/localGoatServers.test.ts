import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

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
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite",
      "n/Users/me/.goat/desktop/userdata/statev2.sqlite-wal",
      "p202",
      "n/dev/null",
      "p303",
      "n/Users/me/.goat/userdata/statev2.sqlite",
    ].join("\n");
    expect([...databasesByPid(output)]).toEqual([
      [101, ["/Users/me/.goat/desktop/userdata/statev2.sqlite"]],
      [303, ["/Users/me/.goat/userdata/statev2.sqlite"]],
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
});
