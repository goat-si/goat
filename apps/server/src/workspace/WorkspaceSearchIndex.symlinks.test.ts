import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileFinder, type WatchEvent } from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import { WorkspaceSearchFinderCache } from "./workspaceSearchFinderCache.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeSymlinkFinder(
  directories: ReadonlyArray<string>,
  options: {
    readonly indexed?: ReadonlyArray<{
      readonly path: string;
      readonly kind: "file" | "directory";
    }>;
    readonly watchFailures?: number;
  } = {},
) {
  const watchers: Array<(events: ReadonlyArray<WatchEvent>) => void> = [];
  let watchFailures = options.watchFailures ?? 0;
  // fff's pageIndex is an offset into the results, not a page number.
  const directorySearch = vi.fn(
    async (_query: string, searchOptions?: { pageIndex?: number; pageSize?: number }) => {
      const offset = searchOptions?.pageIndex ?? 0;
      const items = directories.slice(offset, offset + (searchOptions?.pageSize ?? 100));
      return {
        ok: true as const,
        value: {
          items: items.map((relativePath) => ({ relativePath })),
          totalMatched: directories.length,
        },
      };
    },
  );
  const indexedItems = (options.indexed ?? []).map((entry) => ({
    type: entry.kind,
    item: { relativePath: entry.path, fileName: entry.path.split("/").at(-1) },
  }));
  const finder = {
    destroyAsync: vi.fn(async () => {}),
    waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    // fff's isScanning waits on the picker lock on the JS thread.
    isScanning: () => {
      throw new Error("isScanning must not run on the JS thread");
    },
    getScanProgressAsync: async () => ({
      ok: true as const,
      value: { isScanning: false },
    }),
    // fff's watch waits on the picker lock on the JS thread.
    watch: () => {
      throw new Error("watch must not run on the JS thread");
    },
    watchAsync: async (callback: (events: ReadonlyArray<WatchEvent>) => void) => {
      if (watchFailures > 0) {
        watchFailures -= 1;
        return { ok: false as const, error: "File system watcher is not ready" };
      }
      watchers.push(callback);
      return { ok: true as const, value: () => undefined };
    },
    directorySearchAsync: directorySearch,
    fileSearchAsync: async () => {
      const items = indexedItems.flatMap((entry) => (entry.type === "file" ? [entry.item] : []));
      return { ok: true as const, value: { items, scores: [], totalMatched: items.length } };
    },
    mixedSearchAsync: async () => ({
      ok: true as const,
      value: { items: indexedItems, totalMatched: indexedItems.length },
    }),
  } as unknown as FileFinder;
  vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
  return {
    directorySearch,
    notifyWatchers: (events: ReadonlyArray<WatchEvent>) =>
      watchers.forEach((watcher) => watcher(events)),
  };
}

const listedPaths = (searchIndex: WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]) =>
  searchIndex.list().pipe(Effect.map((result) => result.entries.map((entry) => entry.path)));

it.effect("reads symlinks again after the watcher reports a change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-watch-" });
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-outside-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "old-link.ts"));
      const { directorySearch, notifyWatchers } = fakeSymlinkFinder([]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const concurrent = yield* Effect.all(
        Array.from({ length: 8 }, () => listedPaths(searchIndex)),
        { concurrency: "unbounded" },
      );
      yield* fileSystem.remove(path.join(cwd, "old-link.ts"));
      yield* fileSystem.symlink("a.ts", path.join(cwd, "new-link.ts"));
      const beforeNotice = yield* listedPaths(searchIndex);
      // Editing a file cannot move a link, so it does not cost a rescan.
      notifyWatchers([{ kind: "modified", path: path.join(cwd, "a.ts") }]);
      const afterEdit = yield* listedPaths(searchIndex);
      notifyWatchers([{ kind: "created", path: path.join(cwd, "new-link.ts") }]);
      const afterNotice = yield* listedPaths(searchIndex);
      // fff reports a link replaced in place as modified.
      yield* fileSystem.remove(path.join(cwd, "new-link.ts"));
      yield* fileSystem.symlink(outside, path.join(cwd, "new-link.ts"));
      notifyWatchers([{ kind: "modified", path: path.join(cwd, "new-link.ts") }]);
      const afterReplace = yield* listedPaths(searchIndex);

      expect(concurrent).toEqual(Array.from({ length: 8 }, () => ["old-link.ts"]));
      expect(beforeNotice).toEqual(["old-link.ts"]);
      expect(afterEdit).toEqual(["old-link.ts"]);
      expect(afterNotice).toEqual(["new-link.ts"]);
      expect(afterReplace).toEqual([]);
      expect(directorySearch).toHaveBeenCalledTimes(3);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("answers from the last symlink scan while a slow rescan runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-stale-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "old-link.ts"));
      const { notifyWatchers } = fakeSymlinkFinder([]);
      // Holding git's ignore check open keeps the rescan from finishing.
      const gate = yield* Deferred.make<void>();
      let holdIgnoreChecks = false;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const searchIndex = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          ...vcsProcess,
          run: (input) =>
            holdIgnoreChecks && input.operation === "WorkspaceSearchIndex.listGitIgnored"
              ? Deferred.await(gate).pipe(Effect.andThen(vcsProcess.run(input)))
              : vcsProcess.run(input),
        }),
      );
      expect(yield* listedPaths(searchIndex)).toEqual(["old-link.ts"]);

      holdIgnoreChecks = true;
      yield* fileSystem.symlink("a.ts", path.join(cwd, "new-link.ts"));
      notifyWatchers([{ kind: "created", path: path.join(cwd, "new-link.ts") }]);
      const duringRescan = yield* Effect.forkChild(listedPaths(searchIndex));
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(duringRescan)).toEqual(["old-link.ts"]);

      yield* Deferred.succeed(gate, undefined);
      expect(yield* listedPaths(searchIndex)).toEqual(["new-link.ts", "old-link.ts"]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps symlinks once the watcher subscribes after starting late", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-watch-" });
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "link.ts"));
      const { directorySearch } = fakeSymlinkFinder([], { watchFailures: 2 });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const scansAfterRound: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        scansAfterRound.push(directorySearch.mock.calls.length);
        yield* TestClock.adjust("1 minute");
      }

      // An unwatched scan serves reads only briefly; the third has a watcher and is kept.
      expect(scansAfterRound).toEqual([1, 2, 3, 3, 3]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "lists a symlink the watcher indexed once, with the link's kind, and drops rejected ones",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-dupe-" });
        const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-outside-" });
        yield* fileSystem.makeDirectory(path.join(cwd, "src"));
        yield* fileSystem.symlink("src", path.join(cwd, "src-link"));
        // A link the scan rejects stays out even when the watcher indexed it.
        yield* fileSystem.symlink(outside, path.join(cwd, "outside-link"));
        fakeSymlinkFinder([], {
          indexed: [
            { path: "outside-link", kind: "file" },
            { path: "src-link", kind: "file" },
            { path: "link-file.ts", kind: "file" },
          ],
        });

        const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
        const searched = yield* searchIndex.search("link", 10);
        const files = yield* searchIndex.search("link", 1, "file");
        const listed = yield* searchIndex.list();

        expect(searched.entries).toEqual([
          { path: "src-link", kind: "directory" },
          { path: "link-file.ts", kind: "file" },
        ]);
        // The dropped link does not take the only slot.
        expect(files).toEqual({
          entries: [{ path: "link-file.ts", kind: "file" }],
          truncated: false,
        });
        expect(listed.entries).toEqual([
          { path: "link-file.ts", kind: "file" },
          { path: "src-link", kind: "directory" },
        ]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("finds symlinks in folders past the first page of the index", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-pages-" });
      yield* fileSystem.makeDirectory(path.join(cwd, "late"));
      yield* fileSystem.writeFileString(path.join(cwd, "late/a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "late/link.ts"));
      // Folders fff lists but that are gone by the time they are read are skipped.
      const firstPage = Array.from({ length: 1_000 }, (_, index) => `missing-${index}`);
      const { directorySearch } = fakeSymlinkFinder([...firstPage, "late"]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      expect(yield* listedPaths(searchIndex)).toEqual(["late", "late/link.ts"]);
      expect(directorySearch.mock.calls.map(([, options]) => options?.pageIndex)).toEqual([
        0, 1_000,
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps symlinks Git does not ignore when a link's name looks like a git pathspec", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-pathspec-" });
      yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored-link\n");
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
      yield* fileSystem.symlink("a.ts", path.join(cwd, "docs-link"));
      yield* fileSystem.symlink("a.ts", path.join(cwd, ":(link)"));
      yield* fileSystem.symlink("a.ts", path.join(cwd, "ignored-link"));
      // Stage so `ls-files --others` skips it and `listGitIgnored` must hide it.
      yield* vcsProcess.run({
        operation: "test.gitAdd",
        command: "git",
        args: ["add", "-f", "ignored-link"],
        cwd,
      });
      fakeSymlinkFinder([]);

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);

      expect(yield* listedPaths(searchIndex)).toEqual([":(link)", "docs-link"]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

// watchAsync failing either way leaves the scan unwatched: kept 2 s, and the next read subscribes again.
it.effect.each(["answers not-ok", "rejects"] as const)(
  "a watcher subscription that %s falls back to the short reuse and is retried",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-retry-" });
        yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
        yield* fileSystem.symlink("a.ts", path.join(cwd, "link.ts"));
        const subscriptions: Array<string> = [];
        const directorySearch = vi.fn(async () => ({
          ok: true as const,
          value: { items: [], totalMatched: 0 },
        }));
        const finder = {
          destroyAsync: vi.fn(async () => {}),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          getScanProgressAsync: async () => ({ ok: true as const, value: { isScanning: false } }),
          watchAsync: async () => {
            subscriptions.push(subscriptions.length === 0 ? failure : "ok");
            if (subscriptions.length > 1) return { ok: true as const, value: () => undefined };
            if (failure === "rejects") throw new Error("watcher thread gone");
            return { ok: false as const, error: "File system watcher is not ready" };
          },
          directorySearchAsync: directorySearch,
          mixedSearchAsync: async () => ({
            ok: true as const,
            value: { items: [], totalMatched: 0 },
          }),
        } as unknown as FileFinder;
        vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

        const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        expect(directorySearch).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust("3 seconds");
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);
        yield* TestClock.adjust("1 minute");
        expect(yield* listedPaths(searchIndex)).toEqual(["link.ts"]);

        expect(subscriptions).toEqual([failure, "ok"]);
        // The second scan was watched, so it is kept.
        expect(directorySearch).toHaveBeenCalledTimes(2);
      }),
    ).pipe(Effect.provide(testLayer)),
);

// GOAT's side only: the fake finder plays fff, and the index must not retry or keep a handler.
// What keeps a real destroyed finder from holding one is the patch's own check of the handle
// after the native call in watchAsync (patches/@ff-labs__fff-node@0.11.0.patch).
it.effect("an index closed while its watcher subscription is pending keeps no watcher", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-symlink-close-" });
    yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "");
    let alive = true;
    const handlers: Array<unknown> = [];
    let answer: (() => void) | undefined;
    const asked = yield* Deferred.make<void>();
    const destroy = vi.fn(() => {
      alive = false;
    });
    const finder = {
      destroy,
      destroyAsync: async () => {
        destroy();
      },
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
      getScanProgressAsync: async () => ({ ok: true as const, value: { isScanning: false } }),
      watchAsync: (callback: unknown) => {
        Deferred.doneUnsafe(asked, Effect.void);
        return new Promise((resolve) => {
          answer = () => {
            if (!alive) return resolve({ ok: false as const, error: "File finder destroyed" });
            handlers.push(callback);
            resolve({ ok: true as const, value: () => undefined });
          };
        });
      },
      directorySearchAsync: async () => ({
        ok: true as const,
        value: { items: [], totalMatched: 0 },
      }),
      mixedSearchAsync: async () => ({ ok: true as const, value: { items: [], totalMatched: 0 } }),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const scope = yield* Scope.make();
    const searchIndex = yield* WorkspaceSearchIndex.make(cwd).pipe(Scope.provide(scope));
    const listing = yield* listedPaths(searchIndex).pipe(Effect.forkChild);
    yield* Deferred.await(asked);
    yield* Scope.close(scope, Exit.void);
    answer?.();
    yield* Fiber.interrupt(listing);

    expect(finder.destroy).toHaveBeenCalledTimes(1);
    expect(handlers).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "truncates the symlink directory scan and verifies native entries from unscanned folders",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const outside = yield* fs.makeTempDirectoryScoped();
        const extra = path.join(cwd, "extra");
        yield* fs.makeDirectory(extra);
        yield* fs.writeFileString(path.join(extra, "safe.ts"), "");
        yield* fs.symlink(outside, path.join(extra, "unverified.ts"));
        const dirs = [...Array.from({ length: 4_096 }, (_, i) => `absent-${i}`), "extra"];
        fakeSymlinkFinder(dirs, {
          indexed: [
            { path: "extra/safe.ts", kind: "file" },
            { path: "extra/unverified.ts", kind: "file" },
          ],
        });
        const index = yield* WorkspaceSearchIndex.make(cwd);
        const listed = yield* index.list();
        const searched = yield* index.search("ts", 10, "file");
        expect(listed.truncated).toBe(true);
        expect(searched).toEqual({
          entries: [{ path: "extra/safe.ts", kind: "file" }],
          truncated: true,
        });
        expect(listed.entries.map((entry) => entry.path)).toEqual(["extra", "extra/safe.ts"]);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "omits aliases whose ignore file exceeds the scan read budget and marks results truncated",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          path.join(cwd, ".ignore"),
          `#${"x".repeat(64 * 1024)}\nlink.ts\n`,
        );
        yield* fs.writeFileString(path.join(cwd, "target.ts"), "");
        yield* fs.symlink("target.ts", path.join(cwd, "link.ts"));
        fakeSymlinkFinder([], {
          indexed: [
            { path: "link.ts", kind: "file" },
            { path: "target.ts", kind: "file" },
          ],
        });
        const index = yield* WorkspaceSearchIndex.make(cwd);
        expect(yield* index.search("ts", 10, "file")).toEqual({
          entries: [{ path: "target.ts", kind: "file" }],
          truncated: true,
        });
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("omits stale native descendants of a directory skipped within the scan budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(outside, "stale.ts"), "");
      yield* fs.symlink(outside, path.join(cwd, "alias"));
      yield* fs.makeDirectory(path.join(cwd, "real"));
      yield* fs.writeFileString(path.join(cwd, "real", "safe.ts"), "");
      fakeSymlinkFinder(["alias", "real"], {
        indexed: [
          { path: "alias/stale.ts", kind: "file" },
          { path: "real/safe.ts", kind: "file" },
        ],
      });
      const index = yield* WorkspaceSearchIndex.make(cwd);
      expect(yield* index.search("ts", 10, "file")).toEqual({
        entries: [{ path: "real/safe.ts", kind: "file" }],
        truncated: false,
      });
      expect((yield* index.list()).entries.map((entry) => entry.path)).toEqual([
        "real",
        "real/safe.ts",
      ]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("holds the index scope open until native finder teardown completes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const cleanupStarted = yield* Deferred.make<void>();
    const finish = Promise.withResolvers<void>();
    const teardown = vi.fn(() => {
      Deferred.doneUnsafe(cleanupStarted, Effect.void);
      return finish.promise;
    });
    const finder = {
      destroy: () => {
        void teardown();
      },
      destroyAsync: teardown,
      waitForIndexReady: async () => ({ ok: true, value: true }),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

    const scope = yield* Scope.make();
    yield* WorkspaceSearchIndex.make(cwd).pipe(Scope.provide(scope));
    const closing = yield* Scope.close(scope, Exit.void).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(cleanupStarted);
    const beforeCleanup = closing.pollUnsafe();
    finish.resolve();
    yield* Fiber.join(closing);
    expect(beforeCleanup).toBeUndefined();
    expect(teardown).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(["completes", "fails"] as const)(
  "serves a cached workspace while native teardown is pending and then %s",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cache = yield* WorkspaceSearchFinderCache;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<string>();
      const finish = Promise.withResolvers<void>();
      const live = new Set<string>();
      let peak = 0;
      let firstTeardown = true;
      vi.spyOn(FileFinder, "create").mockImplementation(({ basePath }) => {
        live.add(basePath);
        peak = Math.max(peak, live.size);
        return {
          ok: true,
          value: {
            destroyAsync: async () => {
              if (firstTeardown) {
                firstTeardown = false;
                Deferred.doneUnsafe(started, Effect.succeed(basePath));
                await finish.promise;
              }
              live.delete(basePath);
            },
            waitForIndexReady: async () => ({ ok: true, value: true }),
          } as unknown as FileFinder,
        };
      });
      const read = (root: string) => Effect.scoped(cache.get(root, "paths"));
      const warmed = new Map<string, WorkspaceSearchIndex.WorkspaceSearchIndex["Service"]>();
      for (let index = 0; index < 16; index += 1) {
        const root = path.join(cwd, `repo-${index}`);
        yield* fs.makeDirectory(root);
        warmed.set(root, yield* read(root));
      }
      const firstCold = path.join(cwd, "cold-a");
      const secondCold = path.join(cwd, "cold-b");
      yield* fs.makeDirectory(firstCold);
      yield* fs.makeDirectory(secondCold);
      const eviction = yield* read(firstCold).pipe(Effect.forkChild({ startImmediately: true }));
      try {
        warmed.delete(yield* Deferred.await(started));
        const entry = warmed.entries().next().value;
        if (!entry) return yield* Effect.die("No unrelated cached workspace");
        const [cachedRoot, cachedIndex] = entry;
        const hit = yield* read(cachedRoot).pipe(Effect.forkChild({ startImmediately: true }));
        const overflow = yield* read(secondCold).pipe(Effect.forkChild({ startImmediately: true }));
        const hitBeforeCleanup = hit.pollUnsafe();
        const overflowBeforeCleanup = overflow.pollUnsafe();
        const createdWhileClosing = [live.has(firstCold), live.has(secondCold)];
        if (outcome === "fails") finish.reject(new Error("native teardown failed"));
        else finish.resolve();

        expect(hitBeforeCleanup).toEqual(Exit.succeed(cachedIndex));
        expect(overflowBeforeCleanup).toBeUndefined();
        expect(createdWhileClosing).toEqual([false, false]);
        if (outcome === "fails") {
          expect(Exit.isFailure(yield* Fiber.await(eviction))).toBe(true);
          yield* TestClock.adjust(0);
          expect(overflow.pollUnsafe()).toMatchObject({ _tag: "Failure" });
          // A retry can evict another idle finder even though the failed slot is quarantined.
          yield* read(secondCold);
        } else {
          yield* Fiber.join(eviction);
          yield* Fiber.join(overflow);
        }
        expect(peak).toBe(16);
      } finally {
        finish.resolve();
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(WorkspaceSearchFinderCache.layer.pipe(Layer.provideMerge(testLayer))),
    ),
);
