import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HostCapacitySnapshot, StorageItem } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorktreeInventory from "../mcp/WorktreeInventoryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
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
};

const layer = (tempRoot: string) =>
  StorageReclaim.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(LocalGoatServers, {
          otherServers: () => Effect.sync(() => machine.others),
          workingDirectories: Effect.sync(() => machine.cwds),
        }),
        Layer.mock(WorktreeInventory.WorktreeInventoryService)({ facts: Effect.succeed([]) }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(false),
        }),
        Layer.succeed(HostResources.HostResources, {
          read: Effect.succeed({ disk: null } as unknown as HostCapacitySnapshot),
        }),
        ProcessRunner.layer,
        GitVcsDriver.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
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
  yield* fs.utimes(leftover, LONG_AGO, LONG_AGO);
  const outside = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "storage-outside-" }),
  );
  yield* fs.writeFileString(path.join(outside, "keep.txt"), "not GOAT's\n");
  const reclaim = yield* StorageReclaim.StorageReclaim;
  const find = (items: ReadonlyArray<StorageItem>, target: string) =>
    items.find((item) => item.path === target);
  return { fs, path, config, worktrees, leftover, outside, reclaim, find };
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
      });
      yield* run.pipe(Effect.provide(layer(tempRoot)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
