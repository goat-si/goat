// @effect-diagnostics nodeBuiltinImport:off - seeds other homes' databases the way their servers write them.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { CHANNEL_STATE_COPY_MARKER_FILE_NAME } from "@goat/contracts";

import { ownWorktreeRoots, readOtherHomeBindings } from "./otherGoatHomes.ts";

const withHome = <A, E>(
  run: (home: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-homes-" }));
    return yield* run(home).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const seedDatabase = (file: string, worktreePaths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)",
    );
    for (const [index, worktreePath] of worktreePaths.entries()) {
      db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run(
        `thread-${index}`,
        JSON.stringify({ worktreePath }),
      );
    }
    db.close();
  });

describe("otherGoatHomes", () => {
  it.effect("shows stable's cleanup the worktrees a nightly copy still binds, and back", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const shared = path.join(home, ".goat", "desktop", "worktrees", "repo", "feature");
        yield* fs.makeDirectory(shared, { recursive: true });
        const stableDb = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
        const nightlyDb = path.join(home, ".goat", "desktop-nightly", "userdata", "statev2.sqlite");
        yield* seedDatabase(stableDb, [shared]);
        yield* seedDatabase(nightlyDb, [shared]);

        const fromStable = yield* readOtherHomeBindings({ ownDatabase: stableDb });
        assert.isTrue(fromStable.worktreePaths.has(shared));
        assert.deepEqual(fromStable.unreadable, []);
        const fromNightly = yield* readOtherHomeBindings({ ownDatabase: nightlyDb });
        assert.isTrue(fromNightly.worktreePaths.has(shared));
      }),
    ),
  );

  it.effect("reports another home's database it cannot read, so nothing is removed", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const stableDb = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
        yield* seedDatabase(stableDb, []);
        const broken = path.join(home, ".goat", "desktop-nightly", "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(broken), { recursive: true });
        yield* fs.writeFileString(broken, "not a database");

        const bindings = yield* readOtherHomeBindings({ ownDatabase: stableDb });
        assert.deepEqual(bindings.unreadable, [broken]);
      }),
    ),
  );

  it.effect(
    "treats another home it cannot check as unreadable, so cleanup keeps every worktree",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const stableDb = path.join(home, ".goat", "desktop", "userdata", "statev2.sqlite");
          yield* seedDatabase(stableDb, []);
          const nightlyDb = path.join(
            home,
            ".goat",
            "desktop-nightly",
            "userdata",
            "statev2.sqlite",
          );
          const bindings = yield* readOtherHomeBindings({ ownDatabase: stableDb }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: (target) =>
                target === nightlyDb
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "exists",
                        pathOrDescriptor: target,
                      }),
                    )
                  : fs.exists(target),
            }),
          );
          assert.deepEqual(bindings.unreadable, [nightlyDb]);
        }),
      ),
  );

  it.effect("keeps each app's automatic cleanup inside its own worktree folder", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stable = path.join(home, ".goat", "desktop");
        const nightly = path.join(home, ".goat", "desktop-nightly");
        const roots = [path.join(stable, "worktrees"), path.join(nightly, "worktrees")];

        // A nightly copy keeps stable's settings, including a worktree folder set there.
        assert.deepEqual(yield* ownWorktreeRoots({ roots, baseDir: nightly }), [roots[1]]);
        // Stable's own folder sits inside ~/.goat, which is another home, yet it stays its own.
        assert.deepEqual(yield* ownWorktreeRoots({ roots, baseDir: stable }), [roots[0]]);
        // A folder outside every GOAT home stays a root for whichever app configured it.
        const custom = path.join(home, "worktrees");
        assert.deepEqual(yield* ownWorktreeRoots({ roots: [custom], baseDir: nightly }), [custom]);
      }),
    ),
  );
  it.effect(
    "keeps a nightly copy's automatic cleanup inside its own home, whatever its settings name",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const nightly = path.join(home, ".goat", "desktop-nightly");
          yield* fs.makeDirectory(nightly, { recursive: true });
          yield* fs.writeFileString(path.join(nightly, CHANNEL_STATE_COPY_MARKER_FILE_NAME), "{}");
          // A custom folder copied from stable's settings holds stable's worktrees too.
          const roots = [path.join(home, "worktrees"), path.join(nightly, "worktrees")];
          assert.deepEqual(yield* ownWorktreeRoots({ roots, baseDir: nightly }), [roots[1]]);
        }),
      ),
  );
});
