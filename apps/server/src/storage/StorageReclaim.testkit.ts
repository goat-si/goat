import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type HostCapacitySnapshot, type StorageItem } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { SqlError } from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadHistoryArchive from "../orchestration-v2/ThreadHistoryArchive.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { LocalGoatServers, type OtherServerBindings } from "./localGoatServers.ts";
import * as StorageReclaim from "./StorageReclaim.ts";

/** Seconds since the epoch: older than any age the scan waits for. */
export const LONG_AGO = 0;

/** What other GOAT servers and running processes look like to the cleanup, per test. */
export const machine = {
  others: {
    databases: [],
    worktreePaths: [],
    projectRoots: [],
    unverified: [],
  } as OtherServerBindings,
  cwds: [] as ReadonlyArray<string> | null,
  facts: [] as ReadonlyArray<WorktreeInventory.AbandonedWorktreeFacts>,
  /** What archived history of surviving threads mentions; null when it cannot be read. */
  archived: new Set<string>() as ReadonlySet<string> | null,
  /** Archive snapshot keys handed out in turn; the last one repeats. */
  archiveKeys: ["archives"] as Array<string | null>,
  /** Runs on the listing of running processes after this many listings, once. */
  onProcessListing: null as { after: number; run: Effect.Effect<unknown, SqlError> } | null,
};

export const layer = (tempRoot: string) =>
  StorageReclaim.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(LocalGoatServers, {
          otherServers: () => Effect.sync(() => machine.others),
          workingDirectories: Effect.suspend(() => {
            const hook = machine.onProcessListing;
            if (hook === null) return Effect.succeed(machine.cwds);
            if (hook.after > 0) {
              hook.after -= 1;
              return Effect.succeed(machine.cwds);
            }
            machine.onProcessListing = null;
            return hook.run.pipe(Effect.orDie, Effect.as(machine.cwds));
          }),
        }),
        Layer.mock(WorktreeInventory.WorktreeInventoryService)({
          facts: Effect.sync(() => machine.facts),
          // As the real one: the caller's final check runs under the leases, then git removes it.
          removeAbandoned: (input) =>
            input.verify.pipe(
              Effect.map((reason) =>
                reason === null
                  ? ({ removed: true } as const)
                  : ({ removed: false, reason } as const),
              ),
            ),
        }),
        Layer.mock(ThreadHistoryArchive.ThreadHistoryArchive)({
          mentions: (needles) =>
            Effect.sync(() =>
              machine.archived === null
                ? null
                : new Set(needles.filter((needle) => machine.archived?.has(needle))),
            ),
          snapshotKey: Effect.sync(() =>
            machine.archiveKeys.length > 1
              ? (machine.archiveKeys.shift() ?? null)
              : (machine.archiveKeys[0] ?? null),
          ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(false),
        }),
        Layer.succeed(HostResources.HostResources, {
          read: Effect.succeed({ disk: null } as unknown as HostCapacitySnapshot),
          diskAt: () => Effect.succeed(null),
        }),
        ProcessRunner.layer,
      ),
    ),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-reclaim-" })),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, { ...process.env, TMPDIR: tempRoot }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A GOAT home whose worktrees folder holds one leftover folder of a removed checkout. */
export const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  machine.others = { databases: [], worktreePaths: [], projectRoots: [], unverified: [] };
  machine.cwds = [];
  machine.facts = [];
  machine.archived = new Set();
  machine.archiveKeys = ["archives"];
  machine.onProcessListing = null;
  const worktrees = yield* fs
    .realPath(config.worktreesDir)
    .pipe(
      Effect.catch(() =>
        fs
          .makeDirectory(config.worktreesDir, { recursive: true })
          .pipe(Effect.andThen(fs.realPath(config.worktreesDir))),
      ),
    );
  const leftover = path.join(worktrees, "goat", "old-branch");
  yield* fs.makeDirectory(path.join(leftover, "node_modules", "pkg"), { recursive: true });
  yield* fs.writeFileString(
    path.join(leftover, "node_modules", "pkg", "index.js"),
    "x".repeat(4096),
  );
  yield* backdate(leftover);
  const outside = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "storage-outside-" }),
  );
  yield* fs.writeFileString(path.join(outside, "keep.txt"), "not GOAT's\n");
  const reclaim = yield* StorageReclaim.StorageReclaim;
  const find = (items: ReadonlyArray<StorageItem>, target: string) =>
    items.find((item) => item.path === target);
  return { fs, path, config, worktrees, leftover, outside, reclaim, find };
});

/** Sets every write time in a folder to long ago; change times stay as they are. */
export const backdate = Effect.fn("StorageReclaim.test.backdate")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of yield* fs.readDirectory(folder, { recursive: true }))
    yield* fs.utimes(path.join(folder, name), LONG_AGO, LONG_AGO);
  yield* fs.utimes(folder, LONG_AGO, LONG_AGO);
});

/** A worktree whose git ignores node_modules/, holding one, and its facts for an idle thread. */
export const buildOutputWorktree = Effect.fn("StorageReclaim.test.buildOutputWorktree")(function* (
  worktrees: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const checkout = path.join(worktrees, "goat", "idle-branch");
  const output = path.join(checkout, "node_modules");
  yield* fs.makeDirectory(path.join(output, "pkg"), { recursive: true });
  yield* fs.writeFileString(path.join(output, "pkg", "index.js"), "installed\n");
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "StorageReclaim.test", cwd: checkout, args });
  yield* git(["init", "-q"]);
  yield* fs.writeFileString(path.join(checkout, ".gitignore"), "node_modules/\n");
  const uses = (archived: boolean): ReadonlyArray<WorktreeInventory.AbandonedWorktreeFacts> => [
    {
      entry: {
        path: checkout,
        repository: path.join(worktrees, "repo"),
        branch: "idle-branch",
        main: false,
        missing: false,
        managed: true,
        threads: [
          {
            threadId: ThreadId.make("thread-idle"),
            title: "Idle",
            status: "idle",
            archived,
            busy: false,
          },
        ],
        dirtyCount: 3,
        aheadCount: 0,
      },
      head: "abc",
      holdsProject: false,
      leaseKeys: [checkout, path.join(checkout, "packages", "app")],
    },
  ];
  return { checkout, output, uses, git };
});
