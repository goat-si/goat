import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type HostCapacitySnapshot, type StorageItem } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadHistoryArchive from "../orchestration-v2/ThreadHistoryArchive.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { tryWithWorkspaceLease } from "../workspace/workspaceLease.ts";
import { LocalGoatServers, type OtherServerBindings } from "./localGoatServers.ts";
import * as StorageReclaim from "./StorageReclaim.ts";

/** Seconds since the epoch: older than any age the scan waits for. */
const LONG_AGO = 0;

/** What other GOAT servers and running processes look like to the cleanup, per test. */
const machine = {
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

const layer = (tempRoot: string) =>
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
const setup = Effect.gen(function* () {
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
const backdate = Effect.fn("StorageReclaim.test.backdate")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of yield* fs.readDirectory(folder, { recursive: true }))
    yield* fs.utimes(path.join(folder, name), LONG_AGO, LONG_AGO);
  yield* fs.utimes(folder, LONG_AGO, LONG_AGO);
});

/** A worktree whose git ignores node_modules/, holding one, and its facts for an idle thread. */
const buildOutputWorktree = Effect.fn("StorageReclaim.test.buildOutputWorktree")(function* (
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

describe("StorageReclaim", () => {
  it.live(
    "deletes a confirmed leftover folder, logs it, and refuses a token from another state",
    () =>
      Effect.gen(function* () {
        const { fs, config, leftover, reclaim, find } = yield* setup;
        const item = find((yield* reclaim.usage({ rescan: true })).items, leftover);
        expect(item).toMatchObject({ kind: "orphan_folder", state: "removable", selected: false });

        const stale = yield* reclaim.clean({
          items: [{ id: item!.id, token: "0".repeat(32) }],
          actor: "test",
        });
        expect(stale.results).toMatchObject([
          { outcome: "skipped", reason: "It changed since it was reviewed" },
        ]);
        expect(yield* fs.exists(leftover)).toBe(true);

        const done = yield* reclaim.clean({
          items: [{ id: item!.id, token: item!.token }],
          actor: "test",
        });
        expect(done.results).toMatchObject([{ outcome: "removed", path: leftover }]);
        expect(yield* fs.exists(leftover)).toBe(false);
        const log = yield* fs.readFileString(done.logPath);
        expect(log).toContain('"event":"intent"');
        expect(log).toContain('"event":"removed"');
        expect(done.logPath.startsWith(config.logsDir)).toBe(true);
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("never deletes through a link swapped in after review, and leaves its target alone", () =>
    Effect.gen(function* () {
      const { fs, path, leftover, outside, reclaim, find } = yield* setup;
      const item = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      yield* fs.remove(leftover, { recursive: true });
      yield* fs.symlink(outside, leftover);

      const result = yield* reclaim.clean({
        items: [{ id: item.id, token: item.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(outside, "keep.txt"))).toBe("not GOAT's\n");
      // A link is never offered in the first place.
      expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)).toBeUndefined();
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live(
    "keeps folders another GOAT server or a running process uses, and anything it cannot check",
    () =>
      Effect.gen(function* () {
        const { fs, path, leftover, reclaim, find } = yield* setup;
        machine.others = { ...machine.others, worktreePaths: [leftover] };
        expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)).toMatchObject({
          state: "protected",
          reason: "A thread of another GOAT server on this machine uses it",
        });
        machine.others = {
          ...machine.others,
          worktreePaths: [],
          unverified: ["the process list could not be read"],
        };
        expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)?.state).toBe(
          "needs_attention",
        );
        machine.others = { ...machine.others, unverified: [] };
        machine.cwds = [path.join(leftover, "node_modules")];
        const busy = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
        expect(busy).toMatchObject({ state: "protected", reason: "A process is running in it" });
        expect(
          (yield* reclaim.clean({ items: [{ id: busy.id, token: busy.token }], actor: "test" }))
            .results[0]?.outcome,
        ).toBe("skipped");
        machine.cwds = null;
        expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)?.state).toBe(
          "needs_attention",
        );
        // Removable at review, then a process starts inside: the check right before deletion keeps it.
        machine.cwds = [];
        const offered = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
        expect(offered.state).toBe("removable");
        machine.cwds = [leftover];
        const late = yield* reclaim.clean({
          items: [{ id: offered.id, token: offered.token }],
          actor: "test",
        });
        expect(late.results[0]?.outcome).toBe("skipped");
        expect(yield* fs.exists(leftover)).toBe(true);
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("never offers a git checkout no repository lists, only reports it", () =>
    Effect.gen(function* () {
      const { fs, path, leftover, reclaim, find } = yield* setup;
      yield* fs.writeFileString(
        path.join(leftover, ".git"),
        "gitdir: /gone/.git/worktrees/old-branch\n",
      );
      yield* fs.utimes(leftover, LONG_AGO, LONG_AGO);
      const item = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      expect(item.state).toBe("needs_attention");
      const result = yield* reclaim.clean({
        items: [{ id: item.id, token: item.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(leftover)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("offers only stale temp folders of one-shot GOAT work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "storage-tmp-" }),
      );
      const run = Effect.gen(function* () {
        const { reclaim } = yield* setup;
        const names = [
          "goat-claude-title-old",
          "goat-claude-title-new",
          "goat-token-old",
          "goat-runtime-update-old",
        ];
        for (const name of names) yield* fs.makeDirectory(path.join(tempRoot, name));
        for (const name of names.filter((name) => name.endsWith("-old")))
          yield* fs.utimes(path.join(tempRoot, name), LONG_AGO, LONG_AGO);
        const temp = (yield* reclaim.usage({ rescan: true })).items.filter(
          (item) => item.kind === "temp",
        );
        expect(temp.map((item) => path.basename(item.path))).toEqual(["goat-claude-title-old"]);
        expect(temp[0]).toMatchObject({ state: "removable", selected: false });

        // A thread launched into that folder: it is the thread's workspace now.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, payload_json)
          VALUES ('thread-in-temp', 'project', 'Notes', 'codex', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            ${JSON.stringify({ worktreePath: temp[0]!.path })})
        `;
        const bound = (yield* reclaim.usage({ rescan: true })).items.find(
          (item) => item.kind === "temp",
        );
        expect(bound).toMatchObject({
          state: "protected",
          reason: "A thread or project on this server uses it",
        });
        const result = yield* reclaim.clean({
          items: [{ id: temp[0]!.id, token: temp[0]!.token }],
          actor: "test",
        });
        expect(result.results[0]?.outcome).toBe("skipped");
        expect(yield* fs.exists(temp[0]!.path)).toBe(true);
      });
      yield* run.pipe(Effect.provide(layer(tempRoot)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("keeps an old runtime a thread was launched into", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      for (const version of ["0.0.1", "0.0.2"]) {
        const directory = path.join(versions, version);
        yield* fs.makeDirectory(path.join(directory, "notes"), { recursive: true });
        const sentinel = path.join(directory, ".install-complete");
        yield* fs.writeFileString(sentinel, version + "\n");
        yield* fs.utimes(sentinel, version === "0.0.1" ? 1 : 2, version === "0.0.1" ? 1 : 2);
      }
      const oldest = path.join(versions, "0.0.1");
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find((item) => item.kind === "runtime_version" && item.path === oldest),
            ),
          );
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      yield* fs.writeFileString(path.join(oldest, "notes", "findings.md"), "what broke\n");
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('thread-in-runtime', 'project', 'Runtime', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          ${JSON.stringify({ worktreePath: path.join(oldest, "notes") })})
      `;
      expect(yield* runtime()).toMatchObject({
        state: "protected",
        reason: "A thread or project on this server uses it",
      });
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(oldest, "notes", "findings.md"))).toBe(
        "what broke\n",
      );
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("removes only the runtime folder a person chose, never past it", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim, outside } = yield* setup;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      const install = (root: string, version: string, at: number) =>
        Effect.gen(function* () {
          const directory = path.join(root, version);
          yield* fs.makeDirectory(path.join(directory, "notes"), { recursive: true });
          const sentinel = path.join(directory, ".install-complete");
          yield* fs.writeFileString(sentinel, version + "\n");
          yield* fs.utimes(sentinel, at, at);
        });
      yield* install(versions, "0.0.1", 1);
      yield* install(versions, "0.0.2", 2);
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find(
                (item) => item.kind === "runtime_version" && item.path.endsWith("0.0.1"),
              ),
            ),
          );
      const clean = (item: StorageItem) =>
        reclaim
          .clean({ items: [{ id: item.id, token: item.token }], actor: "test" })
          .pipe(Effect.map((result) => result.results[0]));

      // An earlier removal's leftover, with someone's notes in it, is not part of the approval.
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      const leftover = path.join(versions, ".pruned-0.0.1");
      yield* fs.makeDirectory(leftover);
      yield* fs.writeFileString(path.join(leftover, "kept.md"), "notes\n");
      expect((yield* clean(offered))?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(leftover, "kept.md"))).toBe("notes\n");
      expect(yield* runtime()).toMatchObject({ state: "needs_attention" });
      yield* fs.remove(leftover, { recursive: true });

      // The versions folder swapped for a link to runtimes outside the GOAT home.
      const reviewed = (yield* runtime())!;
      expect(reviewed.state).toBe("removable");
      const elsewhere = path.join(outside, "versions");
      yield* fs.rename(versions, elsewhere);
      yield* fs.symlink(elsewhere, versions);
      expect((yield* clean(reviewed))?.outcome).toBe("skipped");
      expect(yield* fs.exists(path.join(elsewhere, "0.0.1", "notes"))).toBe(true);
      expect(yield* runtime()).toMatchObject({
        state: "needs_attention",
        reason: "It is reached through a link inside the GOAT home",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live(
    "never takes GOAT's own data for leftovers when the worktrees folder is the GOAT home",
    () =>
      Effect.gen(function* () {
        const { fs, path, config, reclaim } = yield* setup;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          worktreesDirectory: config.baseDir,
        });
        const runtime = path.join(pinnedRuntimeVersionsDir(path, config.baseDir), "0.0.1");
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fs.writeFileString(path.join(config.attachmentsDir, "kept.png"), "image\n");
        const stray = path.join(config.baseDir, "some-repo", "old-checkout");
        yield* fs.makeDirectory(stray, { recursive: true });
        yield* fs.writeFileString(path.join(stray, "notes.txt"), "old\n");
        yield* backdate(config.baseDir);

        const leftovers = (yield* reclaim.usage({ rescan: true })).items.filter(
          (item) => item.kind === "orphan_folder" && item.path.startsWith(config.baseDir),
        );
        // Runtimes, state, logs and attachments are GOAT's own, and the default worktrees folder
        // inside the home is scanned as itself: only real leftovers are offered.
        expect(
          leftovers.map((item) => path.relative(config.baseDir, item.path)).toSorted(),
        ).toEqual([
          path.join("some-repo", "old-checkout"),
          path.join("worktrees", "goat", "old-branch"),
        ]);
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps rotated logs while a thread works in the logs folder", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        storageCleanup: { logsAfterDays: 7 },
      });
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      const rotated = path.join(config.logsDir, "server.log.1");
      yield* fs.writeFileString(rotated, "old log\n");
      yield* fs.utimes(rotated, LONG_AGO, LONG_AGO);
      const logs = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(Effect.map((report) => report.items.find((item) => item.kind === "rotated_logs")));
      const offered = (yield* logs())!;
      expect(offered.state).toBe("removable");
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('thread-in-logs', 'project', 'Logs', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          ${JSON.stringify({ worktreePath: config.logsDir })})
      `;
      expect(yield* logs()).toMatchObject({
        state: "protected",
        reason: "A thread works in this folder",
      });
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(rotated)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("skips a reviewed leftover folder once anything inside it changed", () =>
    Effect.gen(function* () {
      const { fs, path, leftover, reclaim, find } = yield* setup;
      const item = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      expect(item.state).toBe("removable");
      const file = path.join(leftover, "node_modules", "pkg", "index.js");
      yield* fs.writeFileString(file, "work written after review\n");
      // Setting the write time back hides nothing: the change time moved and cannot be set back.
      yield* fs.utimes(file, LONG_AGO, LONG_AGO);

      const result = yield* reclaim.clean({
        items: [{ id: item.id, token: item.token }],
        actor: "test",
      });
      expect(result.results).toMatchObject([
        { outcome: "skipped", reason: "It changed since it was reviewed" },
      ]);
      expect(yield* fs.readFileString(file)).toBe("work written after review\n");

      // Fresh writes inside an old folder mean someone uses it: not offered at all.
      yield* fs.writeFileString(path.join(leftover, "node_modules", "pkg", "notes.txt"), "today\n");
      expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)).toMatchObject({
        state: "needs_attention",
        reason: "Something inside it changed recently",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps the build outputs of a worktree any unarchived thread uses, idle or not", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find } = yield* setup;
      const { output, uses } = yield* buildOutputWorktree(worktrees);
      machine.facts = uses(false);
      expect(find((yield* reclaim.usage({ rescan: true })).items, output)).toMatchObject({
        kind: "build_output",
        state: "protected",
        reason: "A thread still uses this worktree; archive it first",
      });

      // Offered while only an archived thread used it; unarchived before deletion, it stays.
      machine.facts = uses(true);
      const offered = find((yield* reclaim.usage({ rescan: true })).items, output)!;
      expect(offered.state).toBe("removable");
      machine.facts = uses(false);
      const late = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(late.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(output)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live(
    "holds the lease of every thread path inside the worktree while removing its build output",
    () =>
      Effect.gen(function* () {
        const { path, worktrees, reclaim, find } = yield* setup;
        const { checkout, output, uses } = yield* buildOutputWorktree(worktrees);
        machine.facts = uses(true);
        const offered = find((yield* reclaim.usage({ rescan: true })).items, output)!;
        expect(offered.state).toBe("removable");
        // An archived thread recorded a folder inside the worktree; resuming it leases that path.
        let resumed: Option.Option<void> | null = null;
        machine.onProcessListing = {
          after: 1,
          run: tryWithWorkspaceLease(path.join(checkout, "packages", "app"), Effect.void).pipe(
            Effect.map((entered) => {
              resumed = entered;
            }),
          ),
        };
        const result = yield* reclaim.clean({
          items: [{ id: offered.id, token: offered.token }],
          actor: "test",
        });
        expect(result.results[0]?.outcome).toBe("removed");
        // The thread could not start while the final checks and removal ran.
        expect(resumed).toEqual(Option.none());
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps a build output git tracks files in or does not ignore, whatever its name", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find } = yield* setup;
      const { checkout, output, uses, git } = yield* buildOutputWorktree(worktrees);
      machine.facts = uses(true);
      const offered = find((yield* reclaim.usage({ rescan: true })).items, output)!;
      expect(offered.state).toBe("removable");

      // Committed work under node_modules/ after review: the check right before deletion keeps it.
      yield* fs.writeFileString(path.join(output, "pkg", "patched.js"), "local fix\n");
      yield* git(["add", "-f", "node_modules/pkg/patched.js"]);
      const late = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      // Git stops reporting a folder with tracked files as ignored; either answer keeps it.
      expect(late.results[0]).toMatchObject({
        outcome: "skipped",
        reason: expect.stringMatching(/^Git (tracks files in it|does not ignore it)/),
      });
      expect(yield* fs.readFileString(path.join(output, "pkg", "patched.js"))).toBe("local fix\n");
      expect(find((yield* reclaim.usage({ rescan: true })).items, output)).toMatchObject({
        state: "needs_attention",
        reason: expect.stringMatching(/^Git (tracks files in it|does not ignore it); check it/),
      });

      yield* git(["rm", "-q", "--cached", "node_modules/pkg/patched.js"]);
      // A negation outranks any global excludes the machine running the test has.
      yield* fs.writeFileString(path.join(checkout, ".gitignore"), "!node_modules/\n");
      expect(find((yield* reclaim.usage({ rescan: true })).items, output)).toMatchObject({
        state: "needs_attention",
        reason: "Git does not ignore it; check it before deleting it yourself",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps any folder that holds a git checkout of its own, wherever it sits", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, leftover, reclaim, find } = yield* setup;
      // A package installed from git, its history and local commits inside: its own repository.
      const { output, uses } = yield* buildOutputWorktree(worktrees);
      machine.facts = uses(true);
      const offered = find((yield* reclaim.usage({ rescan: true })).items, output)!;
      expect(offered.state).toBe("removable");
      // Spelled as a case-insensitive volume lets git find it.
      yield* fs.makeDirectory(path.join(output, "pkg", ".GIT"));
      const late = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(late.results[0]).toMatchObject({
        outcome: "skipped",
        reason: "It holds a git checkout, whose work its worktree's git cannot see",
      });
      expect(yield* fs.exists(path.join(output, "pkg", ".GIT"))).toBe(true);

      // A linked worktree's .git file deep in a leftover folder.
      yield* fs.writeFileString(
        path.join(leftover, "node_modules", "pkg", ".git"),
        "gitdir: /elsewhere/.git/worktrees/pkg\n",
      );
      yield* backdate(leftover);
      expect(find((yield* reclaim.usage({ rescan: true })).items, leftover)).toMatchObject({
        state: "needs_attention",
        reason: "It holds a git checkout; check it for work before deleting it yourself",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps a clean, pushed worktree whose git status cannot see all of its work", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find } = yield* setup;
      const { checkout, git } = yield* buildOutputWorktree(worktrees);
      machine.facts = [
        {
          entry: {
            path: checkout,
            repository: path.join(worktrees, "repo"),
            branch: "idle-branch",
            main: false,
            missing: false,
            managed: true,
            threads: [],
            dirtyCount: 0,
            aheadCount: 0,
          },
          head: "abc",
          holdsProject: false,
          leaseKeys: [checkout],
        },
      ];
      const clean = () =>
        Effect.gen(function* () {
          const item = find((yield* reclaim.usage({ rescan: true })).items, checkout)!;
          expect(item).toMatchObject({ kind: "worktree", state: "removable" });
          return (yield* reclaim.clean({
            items: [{ id: item.id, token: item.token }],
            actor: "test",
          })).results[0];
        });

      // A package installed from git keeps its own history and edits under node_modules/.
      const nested = path.join(checkout, "node_modules", "pkg", ".git");
      yield* fs.makeDirectory(nested);
      expect(yield* clean()).toMatchObject({
        outcome: "skipped",
        reason: "It holds another git checkout, whose work its own git status cannot see",
      });
      yield* fs.remove(nested, { recursive: true });

      // An edited file git is told to assume unchanged.
      yield* fs.writeFileString(path.join(checkout, "tracked.txt"), "edited\n");
      yield* git(["add", "tracked.txt"]);
      yield* git(["update-index", "--assume-unchanged", "tracked.txt"]);
      expect(yield* clean()).toMatchObject({
        outcome: "skipped",
        reason: "Git is told to assume tracked.txt is unchanged",
      });
      yield* git(["update-index", "--no-assume-unchanged", "tracked.txt"]);
      expect(yield* clean()).toMatchObject({ outcome: "removed" });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("removes files of deleted threads only while nothing surviving mentions them", () =>
    Effect.gen(function* () {
      const { fs, path, config, leftover, reclaim } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const thread = (id: string, deleted: boolean, payload: object = {}) =>
        sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, deleted_at, payload_json)
          VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            ${deleted ? "2026-01-02T00:00:00.000Z" : null}, ${JSON.stringify(payload)})
        `;
      yield* thread("thread-gone", true);
      yield* thread("thread-forked", true);
      yield* thread("thread-recent", true);
      yield* thread("thread-live", false, { lineage: { parentThreadId: "thread-forked" } });
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      const file = (segment: string, digit: string, old: boolean) =>
        Effect.gen(function* () {
          const id =
            segment +
            "-" +
            digit.repeat(8) +
            "-" +
            digit.repeat(4) +
            "-4" +
            digit.repeat(3) +
            "-8" +
            digit.repeat(3) +
            "-" +
            digit.repeat(12);
          const target = path.join(config.attachmentsDir, id + ".png");
          yield* fs.writeFileString(target, "image\n");
          if (old) yield* fs.utimes(target, LONG_AGO, LONG_AGO);
          return { id, target };
        });
      const gone = yield* file("thread-gone", "1", true);
      const forked = yield* file("thread-forked", "2", true);
      const recent = yield* file("thread-recent", "3", false);
      const live = yield* file("thread-live", "4", true);

      // Only a surviving thread's archived history names the thread, or that history is unreadable.
      for (const archived of [new Set(["thread-gone"]), null]) {
        machine.archived = archived;
        expect(
          (yield* reclaim.usage({ rescan: true })).items.filter(
            (item) => item.kind === "attachments",
          ),
        ).toMatchObject([{ state: "report_only" }]);
      }
      machine.archived = new Set();

      // A thread archived while the check ran could hide a reference from both reads.
      machine.archiveKeys = ["before", "after"];
      expect(
        (yield* reclaim.usage({ rescan: true })).items.filter(
          (item) => item.kind === "attachments",
        ),
      ).toMatchObject([{ state: "report_only" }]);

      const offered = (yield* reclaim.usage({ rescan: true })).items.filter(
        (item) => item.kind === "attachments",
      );
      expect(offered).toMatchObject([
        { state: "removable", selected: false, label: "1 files of deleted threads" },
      ]);
      expect(offered[0]?.reason).toContain("2 more stay");

      // A surviving thread quotes the file after review: the cleanup keeps it.
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message-quote', 'thread-live', 'user', 0, '2026-01-03T00:00:00.000Z',
          '2026-01-03T00:00:00.000Z', ${JSON.stringify({ attachments: [{ id: gone.id }] })})
      `;
      const quoted = yield* reclaim.clean({
        items: [{ id: offered[0]!.id, token: offered[0]!.token }],
        actor: "test",
      });
      expect(quoted.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(gone.target)).toBe(true);

      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-quote'`;

      // Selected after a leftover folder: a message quotes the file while the folder goes.
      const quote = sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('message-late', 'thread-live', 'user', 0, '2026-01-04T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z', ${JSON.stringify({ attachments: [{ id: gone.id }] })})
      `;
      const selection = (yield* reclaim.usage({ rescan: true })).items
        .filter((item) => item.kind === "attachments" || item.path === leftover)
        .toSorted((left) => (left.kind === "orphan_folder" ? -1 : 1));
      // The clean's scan lists processes once; the folder's final check lists them again.
      machine.onProcessListing = { after: 1, run: quote };
      const during = yield* reclaim.clean({
        items: selection.map(({ id, token }) => ({ id, token })),
        actor: "test",
      });
      expect(during.results.map((result) => [result.kind, result.outcome])).toEqual([
        ["orphan_folder", "removed"],
        ["attachments", "skipped"],
      ]);
      expect(yield* fs.exists(gone.target)).toBe(true);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-late'`;

      const again = (yield* reclaim.usage({ rescan: true })).items.find(
        (item) => item.kind === "attachments",
      )!;
      const done = yield* reclaim.clean({
        items: [{ id: again.id, token: again.token }],
        actor: "test",
      });
      expect(done.results[0]?.outcome).toBe("removed");
      expect(yield* fs.exists(gone.target)).toBe(false);
      for (const kept of [forked, recent, live]) expect(yield* fs.exists(kept.target)).toBe(true);
      // The group's line names the folder; each file has its own intent and outcome.
      const lines = (yield* fs.readFileString(done.logPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.filter((line) => line.path === gone.target).map((line) => line.event)).toEqual([
        "intent",
        "removed",
      ]);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live(
    "keeps the next leftover of a batch when it changed while an earlier one was removed",
    () =>
      Effect.gen(function* () {
        const { fs, path, leftover, reclaim, find } = yield* setup;
        const second = path.join(path.dirname(leftover), "older-branch");
        yield* fs.makeDirectory(path.join(second, "src"), { recursive: true });
        yield* fs.writeFileString(path.join(second, "src", "notes.txt"), "kept\n");
        yield* backdate(second);
        const items = (yield* reclaim.usage({ rescan: true })).items;
        const first = find(items, leftover)!;
        const next = find(items, second)!;
        expect([first.state, next.state]).toEqual(["removable", "removable"]);
        // While the first folder's final checks run, someone starts work in the second one.
        machine.onProcessListing = {
          after: 1,
          run: fs
            .makeDirectory(path.join(second, ".git"))
            .pipe(
              Effect.andThen(
                fs.writeFileString(path.join(second, "src", "draft.ts"), "new work\n"),
              ),
              Effect.orDie,
            ),
        };
        const result = yield* reclaim.clean({
          items: [first, next].map(({ id, token }) => ({ id, token })),
          actor: "test",
        });
        expect(result.results.map((outcome) => outcome.outcome)).toEqual(["removed", "skipped"]);
        expect(yield* fs.readFileString(path.join(second, "src", "draft.ts"))).toBe("new work\n");
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("no thread can start inside a leftover folder while it is removed", () =>
    Effect.gen(function* () {
      const { path, leftover, reclaim, find } = yield* setup;
      const item = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      expect(item.state).toBe("removable");
      // The cleanup pauses inside its final checks while a thread launched into a folder inside
      // the leftover tries to start its turn, which leases that folder.
      const checking = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      machine.onProcessListing = {
        after: 1,
        run: Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      };
      const cleaning = yield* reclaim
        .clean({ items: [{ id: item.id, token: item.token }], actor: "test" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(checking);
      const started = yield* tryWithWorkspaceLease(
        path.join(leftover, "node_modules", "pkg"),
        Effect.void,
      );
      yield* Deferred.succeed(proceed, undefined);
      const result = yield* Fiber.join(cleaning);
      expect(result.results[0]?.outcome).toBe("removed");
      expect(started).toEqual(Option.none());
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps a leftover folder a thread here binds after the clean's own scan", () =>
    Effect.gen(function* () {
      const { fs, leftover, reclaim, find } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const item = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      expect(item.state).toBe("removable");
      // The clean's scan lists processes once; the binding lands after it, before deletion.
      machine.onProcessListing = {
        after: 1,
        run: sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, payload_json)
          VALUES ('thread-new', 'project', 'New', 'codex', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            ${JSON.stringify({ worktreePath: leftover })})
        `,
      };
      const result = yield* reclaim.clean({
        items: [{ id: item.id, token: item.token }],
        actor: "test",
      });
      expect(machine.onProcessListing).toBeNull();
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        reason: "A thread on this server uses it now",
      });
      expect(yield* fs.exists(leftover)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );
});
