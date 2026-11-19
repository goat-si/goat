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
import { ChildProcessSpawner } from "effect/process";
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

const writeIndexedFixture = Effect.fn(function* (cwd: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(cwd, relativePath);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, "");
});

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(async () => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroyAsync: vi.fn(async () => {}),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearchAsync: fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* writeIndexedFixture(cwd, "public/icon.svg");
      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith(expect.stringContaining("**/*.{"), { pageSize: 201 });
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
      yield* writeIndexedFixture(cwd, "src/a.ts");

      const items = [
        fileItem("hidden/a.ts"),
        fileItem("hidden/b.ts"),
        fileItem("hidden/c.ts"),
        fileItem("src/a.ts"),
      ];
      const fileSearch = vi.fn(async (_query: string, options?: { pageSize?: number }) => ({
        ok: true as const,
        value: {
          items: items.slice(0, options?.pageSize),
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroyAsync: vi.fn(async () => {}),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearchAsync: fileSearch,
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
        destroyAsync: vi.fn(async () => {}),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearchAsync: vi.fn(async () => ({
          ok: true as const,
          value: { items, scores: [], totalMatched: 1, totalFiles: 1 },
        })),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* writeIndexedFixture(cwd, "dir\\one/report.txt");
      const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
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
      const grep = vi.fn(async (_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroyAsync: vi.fn(async () => {}),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grepAsync: grep,
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
          destroyAsync: vi.fn(async () => {}),
          waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
          fileSearchAsync: vi.fn(async () => ({
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
        const cwd = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
        yield* writeIndexedFixture(cwd, visible);
        const index = yield* WorkspaceSearchIndex.make(cwd).pipe(
          Effect.provideService(VcsProcess.VcsProcess, process),
        );
        const result = yield* index.search("report", 50, "file");
        expect(result.entries).toEqual([{ kind: "file", path: visible }]);
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(NodeServices.layer),
    ),
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

it.live("answers content searches with git grep while a slow content index builds", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-content-warmup-" });
    yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
    yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
    yield* fileSystem.makeDirectory(path.join(cwd, "src"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "src/a.ts"),
      "const Needle = 1;\r\nneedles(a.b);\nnone\n",
    );
    yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "needle\n");
    // fff leaves out what `.ignore` excludes, so git results must leave it out too.
    yield* fileSystem.writeFileString(path.join(cwd, ".ignore"), "out/\n");
    yield* fileSystem.makeDirectory(path.join(cwd, "out/deep"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, "out/deep/g.txt"), "needle\n");

    let isWarmupComplete = false;
    const grep = vi.fn(async () => ({
      ok: true as const,
      value: {
        items: [],
        totalMatched: 0,
        totalFilesSearched: 0,
        totalFiles: 0,
        filteredFileCount: 0,
        nextCursor: null,
      } satisfies GrepResult,
    }));
    const destroy = vi.fn();
    const finder = {
      destroy,
      destroyAsync: async () => {
        destroy();
      },
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
      getScanProgressAsync: async () => ({
        ok: true as const,
        value: { isScanning: false, isWarmupComplete },
      }),
      grepAsync: grep,
    } as unknown as FileFinder;
    const noPcreFinder = {
      ...finder,
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
    } as unknown as FileFinder;
    vi.spyOn(FileFinder, "create")
      .mockReturnValueOnce({ ok: true, value: finder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder })
      .mockReturnValueOnce({ ok: true, value: noPcreFinder });

    const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "content");
    const search = (input: Partial<Parameters<typeof searchIndex.searchContents>[0]>) =>
      searchIndex.searchContents({
        query: "needle",
        limit: 10,
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        ...input,
      });

    expect(yield* search({})).toEqual({
      matches: [
        {
          path: "src/a.ts",
          lineNumber: 1,
          lineContent: "const Needle = 1;",
          matchRanges: [{ start: 6, end: 12 }],
        },
        {
          path: "src/a.ts",
          lineNumber: 2,
          lineContent: "needles(a.b);",
          matchRanges: [{ start: 0, end: 6 }],
        },
      ],
      truncated: false,
    });
    expect((yield* search({ caseSensitive: true, wholeWord: true })).matches).toEqual([]);
    expect((yield* search({ query: "a.b" })).matches.map((match) => match.matchRanges)).toEqual([
      [{ start: 8, end: 11 }],
    ]);
    expect(
      (yield* search({ query: "ne+dles?", useRegex: true })).matches.map(
        (match) => match.matchRanges,
      ),
    ).toEqual([[{ start: 6, end: 12 }], [{ start: 0, end: 7 }]]);
    expect(
      (yield* search({ query: "[a-z]e", useRegex: true })).matches.map(
        (match) => match.matchRanges,
      ),
    ).toEqual([
      [{ start: 4, end: 6 }],
      [
        { start: 6, end: 8 },
        { start: 10, end: 12 },
      ],
      [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ],
      [{ start: 2, end: 4 }],
    ]);
    const invalid = yield* search({ query: "a.b(", useRegex: true });
    expect(invalid.matches).toEqual([]);
    expect(invalid.regexFallbackError).toBeDefined();
    expect(yield* search({ limit: 1 })).toMatchObject({ truncated: true });
    if ((yield* HostProcess.Platform) !== "win32") {
      const relativePath = "src/line\nname.ts";
      yield* fileSystem.writeFileString(path.join(cwd, relativePath), "first\npath marker\n");
      expect((yield* search({ query: "path marker" })).matches).toEqual([
        {
          path: relativePath,
          lineNumber: 2,
          lineContent: "path marker",
          matchRanges: [{ start: 0, end: 11 }],
        },
      ]);
    }
    expect(grep).not.toHaveBeenCalled();

    // When git cannot give regex results or their ranges, fff answers once ready instead.
    const failingGitIndex = (
      failingArgument: string,
      stderr: string,
      output: { readonly exitCode: number; readonly stdout: string } = {
        exitCode: 128,
        stdout: "",
      },
    ) =>
      WorkspaceSearchIndex.make(cwd, "content").pipe(
        Effect.provideService(
          VcsProcess.VcsProcess,
          VcsProcess.VcsProcess.of({
            run: (input) =>
              input.args.includes(failingArgument)
                ? Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(output.exitCode),
                    stdout: output.stdout,
                    stderr,
                    stdoutTruncated: output.exitCode === 0,
                    stderrTruncated: false,
                  })
                : vcsProcess.run(input),
          }),
        ),
      );
    const regexInput = {
      query: "ne+dles?",
      limit: 10,
      caseSensitive: false,
      wholeWord: true,
      useRegex: true,
    };
    const noPcreIndex = yield* failingGitIndex(
      "-P",
      "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE\n",
    );
    expect((yield* noPcreIndex.searchContents(regexInput)).regexFallbackError).toBeUndefined();
    expect(grep).toHaveBeenCalledTimes(1);
    const noRangesIndex = yield* failingGitIndex("-o", "fatal: unexpected failure\n");
    yield* noRangesIndex.searchContents(regexInput);
    expect(grep).toHaveBeenCalledTimes(2);
    // Ranges output cut off after line 1: line 2 is left out and the result says so.
    const cutRangesIndex = yield* failingGitIndex("-o", "", {
      exitCode: 0,
      stdout: "src/a.ts\u00001\u00007\u0000Needle\nsrc/a.ts\u00002",
    });
    expect(yield* cutRangesIndex.searchContents(regexInput)).toEqual({
      matches: [
        {
          path: "src/a.ts",
          lineNumber: 1,
          lineContent: "const Needle = 1;",
          matchRanges: [{ start: 6, end: 12 }],
        },
      ],
      truncated: true,
    });

    isWarmupComplete = true;
    yield* search({});
    expect(grep).toHaveBeenCalledTimes(3);
    expect(finder.destroy).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("finds Git-ignored files re-included by .ignore during and after content warmup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-search-reinclude-" });
    yield* vcsProcess.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
    yield* fs.writeFileString(path.join(cwd, ".gitignore"), "notes/\ngenerated/\nsecret.txt\n");
    yield* fs.writeFileString(
      path.join(cwd, ".ignore"),
      "!notes/\nnotes/**/*\n!notes/**/\n!generated/\n",
    );
    yield* fs.makeDirectory(path.join(cwd, "notes", "daily"), { recursive: true });
    yield* fs.makeDirectory(path.join(cwd, "generated"));
    yield* fs.writeFileString(path.join(cwd, "generated", ".gitignore"), "[[:digit:]].txt\n");
    yield* fs.writeFileString(path.join(cwd, "generated", "1.txt"), "needle\n");
    yield* fs.writeFileString(path.join(cwd, "notes", ".gitignore"), "*.txt\n");
    yield* fs.writeFileString(path.join(cwd, "notes", "daily", ".ignore"), "!standup.md\n");
    yield* fs.writeFileString(path.join(cwd, "notes", "daily", "standup.md"), "needle\n");
    yield* fs.writeFileString(path.join(cwd, "notes", "daily", "standup.txt"), "needle\n");
    yield* fs.writeFileString(path.join(cwd, "secret.txt"), "needle\n");
    yield* fs.writeFileString(path.join(cwd, "regular.txt"), "needle\n");

    let scanning = true;
    let settle = () => Promise.resolve();
    const create = FileFinder.create.bind(FileFinder);
    vi.spyOn(FileFinder, "create").mockImplementation((options) => {
      const result = create(options);
      if (result.ok && !options.disableContentIndexing) {
        const finder = result.value;
        const wait = finder.waitForIndexReady.bind(finder);
        finder.waitForIndexReady = (timeout) => {
          scanning = false;
          return wait(timeout);
        };
        settle = async () => {
          const ready = await wait(15_000);
          expect(ready).toEqual({ ok: true, value: true });
        };
        const progress = finder.getScanProgressAsync.bind(finder);
        finder.getScanProgressAsync = async () => {
          const result = await progress();
          return scanning && result.ok
            ? { ok: true, value: { ...result.value, isScanning: true, isWarmupComplete: false } }
            : result;
        };
      }
      return result;
    });
    const paths = yield* WorkspaceSearchIndex.make(cwd);
    const content = yield* WorkspaceSearchIndex.make(cwd, "content");
    const search = content.searchContents({
      query: "needle",
      limit: 20,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });
    const file = "notes/daily/standup.md";
    const fallback = yield* search;
    scanning = false;
    yield* Effect.promise(settle);
    const native = yield* search;

    expect((yield* paths.search("standup", 20, "file")).entries).toEqual([
      { kind: "file", path: file },
    ]);
    for (const result of [fallback, native]) {
      expect(result.matches.map((match) => match.path).toSorted()).toEqual([file, "regular.txt"]);
      expect(result.truncated).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live.each(["grep.column", "grep.fullName"])(
  "keeps cold content paths and ranges stable under local %s",
  (config) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const repo = yield* fs.makeTempDirectoryScoped();
      const cwd = path.join(repo, "workspace");
      const git = (args: string[]) =>
        vcs.run({
          operation: "test.gitConfigureGrep",
          command: "git",
          args,
          cwd: repo,
        });
      yield* git(["init"]);
      yield* git(["config", config, "true"]);
      yield* fs.makeDirectory(cwd);
      yield* fs.writeFileString(path.join(cwd, "note.txt"), "a needle\n");

      const finder = {
        destroyAsync: vi.fn(async () => {}),
        getScanProgressAsync: async () => ({
          ok: true as const,
          value: { isScanning: true, isWarmupComplete: false },
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make(cwd, "content");
      for (const useRegex of [false, true]) {
        const result = yield* index.searchContents({
          query: useRegex ? "ne+dle" : "needle",
          limit: 20,
          caseSensitive: true,
          wholeWord: false,
          useRegex,
        });
        expect(result.matches).toEqual([
          {
            path: "note.txt",
            lineNumber: 1,
            lineContent: "a needle",
            matchRanges: [{ start: 2, end: 8 }],
          },
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live.each(["before grep", "during grep"])(
  "keeps descendants out when a re-included file becomes a directory %s",
  (when) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const generated = path.join(cwd, "generated");
      yield* git.run({ operation: "test.gitInit", command: "git", args: ["init"], cwd });
      yield* fs.writeFileString(path.join(cwd, ".gitignore"), "generated\n");
      yield* fs.writeFileString(path.join(cwd, ".ignore"), "!generated\n");
      yield* fs.writeFileString(generated, "needle\n");

      const replaceFile = Effect.gen(function* () {
        yield* fs.remove(generated);
        yield* fs.makeDirectory(generated);
        yield* fs.writeFileString(path.join(generated, ".gitignore"), "[[:digit:]].txt\n");
        yield* fs.writeFileString(path.join(generated, "1.txt"), "needle\n");
      });
      let replaceOnWiden = false;
      const process = VcsProcess.VcsProcess.of({
        run: (input) => {
          if (!replaceOnWiden || !input.args.includes("--no-exclude-standard")) {
            return git.run(input);
          }
          replaceOnWiden = false;
          return replaceFile.pipe(Effect.orDie, Effect.andThen(git.run(input)));
        },
      });

      const finder = {
        destroyAsync: vi.fn(async () => {}),
        getScanProgressAsync: async () => ({
          ok: true as const,
          value: { isScanning: true, isWarmupComplete: false },
        }),
        waitForIndexReady: async () => ({ ok: true, value: true }),
        grepAsync: async () => ({
          ok: true as const,
          value: { items: [], nextCursor: null },
        }),
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make(cwd, "content").pipe(
        Effect.provideService(VcsProcess.VcsProcess, process),
      );
      const search = index.searchContents({
        query: "needle",
        limit: 10,
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      expect((yield* search).matches.map((match) => match.path)).toEqual(["generated"]);

      if (when === "before grep") yield* replaceFile;
      else replaceOnWiden = true;
      expect(yield* search).toEqual({ matches: [], truncated: false });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
