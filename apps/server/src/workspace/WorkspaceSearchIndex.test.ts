import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
      );
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("fetches past a first page of Git-ignored results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-search-ignored-" });
      const vcsProcess = yield* VcsProcess.VcsProcess;
      yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fs.writeFileString(path.join(cwd, ".git", "info", "exclude"), "hidden/\n");
      yield* fs.makeDirectory(path.join(cwd, "hidden"));
      yield* fs.writeFileString(path.join(cwd, "hidden", "a.ts"), "");

      const items = [
        fileItem("hidden/a.ts"),
        fileItem("hidden/b.ts"),
        fileItem("hidden/c.ts"),
        fileItem("src/a.ts"),
      ];
      const fileSearch = vi.fn((_query: string, options?: { pageSize?: number }) => ({
        ok: true as const,
        value: {
          items: items.slice(0, options?.pageSize),
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const result = yield* searchIndex.search("a", 1, "file", false);

      expect(result).toEqual({ entries: [{ kind: "file", path: "src/a.ts" }], truncated: false });
    }),
  ).pipe(Effect.provide(testLayer)),
);

// A backslash is a file name character on Linux and macOS, so only Windows may treat it as a separator.
it.effect("keeps a backslash in a POSIX folder name as part of the search result path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [fileItem("dir\\one/report.txt")];
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch: vi.fn(() => ({
          ok: true as const,
          value: { items, scores: [], totalMatched: 1, totalFiles: 1 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
      );
      const result = yield* searchIndex.search("report", 50, "file");

      expect(result.entries).toEqual([{ kind: "file", path: "dir\\one/report.txt" }]);
    }),
  ).pipe(Effect.provide(testLayer), Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
        "content",
      );
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  {
    platform: "linux" as const,
    ignored: "dir\\one/",
    hidden: "dir\\one/report.txt",
    visible: "dir/one/report.txt",
  },
  {
    platform: "win32" as const,
    ignored: "dir\\one/",
    hidden: "dir\\one/report.txt",
    visible: "other/report.txt",
  },
])(
  "matches ignored paths using host separators: $platform",
  ({ platform, ignored, hidden, visible }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const items = [fileItem(hidden), fileItem(visible)];
        const finder = {
          destroy: vi.fn(),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          fileSearch: vi.fn(() => ({
            ok: true as const,
            value: { items, scores: [], totalMatched: 2, totalFiles: 2 },
          })),
        } as unknown as FileFinder;
        vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
        const process = VcsProcess.VcsProcess.of({
          run: () =>
            Effect.succeed({
              exitCode: 0 as VcsProcess.VcsProcessOutput["exitCode"],
              stdout: `${ignored}\0`,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        });
        const index = yield* WorkspaceSearchIndex.make("/workspace/project").pipe(
          Effect.provideService(VcsProcess.VcsProcess, process),
        );
        const result = yield* index.search("report", 50, "file");
        expect(result.entries).toEqual([{ kind: "file", path: visible }]);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, platform)),
);

it.effect("searches a plain directory when Git is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(cwd, "needle.txt"), "found");
      const actual = yield* VcsProcess.VcsProcess;
      const unavailable = VcsProcess.VcsProcess.of({
        run: (input) => actual.run({ ...input, command: "goat-test-missing-git-executable" }),
      });
      const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(VcsProcess.VcsProcess, unavailable),
      );
      const result = yield* index.search("needle", 20, "file");
      expect(result.entries).toContainEqual({ path: "needle.txt", kind: "file" });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("searches a non-repository independently of the inherited locale", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(cwd, "needle.txt"), "found");
      const actual = yield* VcsProcess.VcsProcess;
      const localized = VcsProcess.VcsProcess.of({
        run: (input) =>
          actual
            .run(input)
            .pipe(
              Effect.map((result) =>
                result.exitCode !== 0 && input.env?.LC_ALL !== "C"
                  ? { ...result, stderr: "fatal: kein Git-Repository" }
                  : result,
              ),
            ),
      });
      const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(VcsProcess.VcsProcess, localized),
      );
      const result = yield* index.search("needle", 20, "file");
      expect(result.entries).toContainEqual({ path: "needle.txt", kind: "file" });
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  ["non-repository", "fatal: not a git repository (or any of the parent directories): .git", false],
  ["dubious ownership", "fatal: detected dubious ownership in repository", true],
] as const)("logs ignore enumeration failures for %s", ([_name, stderr, shouldWarn]) => {
  const messages: unknown[] = [];
  const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
  return Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const actual = yield* VcsProcess.VcsProcess;
      const failing = VcsProcess.VcsProcess.of({
        run: (input) =>
          input.args.includes("ls-files")
            ? Effect.succeed({
                exitCode: 128 as VcsProcess.VcsProcessOutput["exitCode"],
                stdout: "",
                stderr,
                stdoutTruncated: false,
                stderrTruncated: false,
              })
            : actual.run(input),
      });
      yield* WorkspaceSearchIndex.make(cwd).pipe(
        Effect.provideService(VcsProcess.VcsProcess, failing),
      );
      if (shouldWarn) {
        expect(messages).toEqual([
          ["Could not list Git ignored paths; continuing without them.", { cwd, exitCode: 128 }],
        ]);
      } else {
        expect(messages).toEqual([]);
      }
    }),
  ).pipe(Effect.provide(Layer.merge(testLayer, Logger.layer([logger]))));
});

it.effect.each(["spawn", "non-zero", "truncated"] as const)(
  "searches when Git ignore enumeration fails: %s",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(cwd, "needle.txt"), "found");
        const actual = yield* VcsProcess.VcsProcess;
        const failing = VcsProcess.VcsProcess.of({
          run: (input) =>
            input.args.includes("ls-files")
              ? failure === "spawn"
                ? actual.run({ ...input, command: "goat-test-missing-git-executable" })
                : Effect.succeed({
                    exitCode: (failure === "non-zero"
                      ? 128
                      : 0) as VcsProcess.VcsProcessOutput["exitCode"],
                    stdout: failure === "truncated" ? "needle.txt\0" : "",
                    stderr: failure === "non-zero" ? "fatal: dubious ownership" : "",
                    stdoutTruncated: failure === "truncated",
                    stderrTruncated: false,
                  })
              : actual.run(input),
        });
        const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
          Effect.provideService(VcsProcess.VcsProcess, failing),
        );
        const result = yield* index.search("needle", 20, "file");
        expect(result.entries).toContainEqual({ path: "needle.txt", kind: "file" });
      }),
    ).pipe(Effect.provide(testLayer)),
);
