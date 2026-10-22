// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO, and reads spy on native realpath.
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

// Temp folders count as known workspaces unless named as unknown.
const UNKNOWN_WORKSPACE_PREFIX = "t3code-unknown-workspace-";
const layerKnownWorkspacesTest = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: (cwd) =>
    cwd.includes(UNKNOWN_WORKSPACE_PREFIX)
      ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
      : Effect.void,
});

const layerProject = WorkspaceFileSystem.layer.pipe(
  Layer.provide(layerKnownWorkspacesTest),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(layerProject),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "goat-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "goat-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

afterEach(() => vi.restoreAllMocks());

it.layer(layerTest, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("guarded saves", () => {
    it.effect("rejects a stale save and leaves external bytes intact", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "file.txt", "loaded");
        const loaded = yield* service.readFile({ cwd, relativePath: "file.txt" });
        yield* writeTextFile(cwd, "file.txt", "external");
        const result = yield* service
          .writeFile({
            cwd,
            relativePath: "file.txt",
            contents: "draft",
            expectedVersion: loaded.version!,
          })
          .pipe(Effect.flip);
        expect(result._tag).toBe("WorkspaceFileChangedOnDiskError");
        expect(yield* fs.readFileString(path.join(cwd, "file.txt"))).toBe("external");
        expect(yield* fs.readDirectory(cwd)).toEqual(["file.txt"]);
      }),
    );

    it.effect("does not recreate a deleted file or its parents until explicitly overwritten", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "dir/file.txt", "loaded");
        const loaded = yield* service.readFile({ cwd, relativePath: "dir/file.txt" });
        yield* fs.remove(path.join(cwd, "dir"), { recursive: true });
        const result = yield* service
          .writeFile({
            cwd,
            relativePath: "dir/file.txt",
            contents: "draft",
            expectedVersion: loaded.version!,
          })
          .pipe(Effect.flip);
        expect(result._tag).toBe("WorkspaceFileDeletedOnDiskError");
        expect(yield* fs.readDirectory(cwd)).toEqual([]);
        yield* service.writeFile({ cwd, relativePath: "dir/file.txt", contents: "draft" });
        expect(yield* fs.readFileString(path.join(cwd, "dir/file.txt"))).toBe("draft");
      }),
    );

    it.effect.each([
      { ending: "\n", bom: "" },
      { ending: "\n", bom: "\ufeff" },
      { ending: "\r\n", bom: "" },
      { ending: "\r\n", bom: "\ufeff" },
      { ending: "\r", bom: "" },
      { ending: "\r", bom: "\ufeff" },
    ])("round-trips format %j and advances the raw-byte version", ({ ending, bom }) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "file.txt", `${bom}one${ending}two${ending}`);
        const loaded = yield* service.readFile({ cwd, relativePath: "file.txt" });
        expect(loaded.contents).toBe(`one${ending}two${ending}`);
        expect(loaded.version).toMatch(/^sha256:[a-f0-9]{64}$/);
        const written = yield* service.writeFile({
          cwd,
          relativePath: "file.txt",
          contents: "new\ntext\n",
          expectedVersion: loaded.version!,
          textFormat: loaded.textFormat!,
        });
        expect(Buffer.from(yield* fs.readFile(path.join(cwd, "file.txt"))).toString("utf8")).toBe(
          `${bom}new${ending}text${ending}`,
        );
        const reread = yield* service.readFile({ cwd, relativePath: "file.txt" });
        expect(written.version).toBe(reread.version);
        expect(written.version).not.toBe(loaded.version);
        yield* service.writeFile({
          cwd,
          relativePath: "file.txt",
          contents: "again",
          expectedVersion: written.version!,
        });
      }),
    );

    it.effect("marks mixed and invalid UTF-8 text unsupported for editing", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "mixed", "one\r\ntwo\n");
        yield* fs.writeFile(path.join(cwd, "invalid"), new Uint8Array([0xc3, 0x28]));
        for (const relativePath of ["mixed", "invalid"]) {
          const read = yield* service.readFile({ cwd, relativePath });
          expect(read.textFormat).toMatchObject(
            relativePath === "mixed" ? { lineEnding: "mixed" } : { encoding: "unsupported" },
          );
          const result = yield* service
            .writeFile({
              cwd,
              relativePath,
              contents: "draft",
              expectedVersion: read.version!,
              textFormat: read.textFormat!,
            })
            .pipe(Effect.flip);
          expect(result._tag).toBe("WorkspaceUnsupportedTextFormatError");
        }
      }),
    );

    it.effect("checks again after staging, immediately before rename", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "file.txt", "loaded");
        const loaded = yield* service.readFile({ cwd, relativePath: "file.txt" });
        const open = NodeFS.promises.open;
        vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith(".tmp")) {
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              await sync();
              await NodeFS.promises.writeFile(path.join(cwd, "file.txt"), "changed during stage");
            });
          }
          return handle;
        });
        const result = yield* service
          .writeFile({
            cwd,
            relativePath: "file.txt",
            contents: "draft",
            expectedVersion: loaded.version!,
          })
          .pipe(Effect.flip);
        expect(result._tag).toBe("WorkspaceFileChangedOnDiskError");
        expect(yield* fs.readFileString(path.join(cwd, "file.txt"))).toBe("changed during stage");
        expect(yield* fs.readDirectory(cwd)).toEqual(["file.txt"]);
      }),
    );
  });

  describe("getMetadata", () => {
    it.effect(
      "reports actual kinds for extensionless files, dotfiles, and dotted directories",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "custom-name", "hello");
          yield* writeTextFile(cwd, ".npmrc", "registry=test");
          yield* fs.makeDirectory(path.join(cwd, "folder.ts"));
          const file = path.join(cwd, "custom-name");
          const result = yield* service.getMetadata({
            paths: [
              file,
              path.join(cwd, ".npmrc"),
              path.join(cwd, "folder.ts"),
              file,
              path.join(cwd, "missing"),
              "relative-path",
            ],
          });
          expect(result.entries).toEqual([
            { kind: "file", byteLength: 5 },
            { kind: "file", byteLength: 13 },
            { kind: "directory" },
            { kind: "file", byteLength: 5 },
            null,
            null,
          ]);
        }),
    );

    it.effect("detects an extensionless script and image without returning their contents", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const script = "#!/usr/bin/env python3\nprint('hello')\n";
        yield* writeTextFile(cwd, "run", script);
        const image = path.join(cwd, "image");
        yield* fs.writeFile(
          image,
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        expect(
          (yield* service.getMetadata({ paths: [path.join(cwd, "run"), image] })).entries,
        ).toEqual([
          { kind: "file", byteLength: script.length, mimeType: "text/x-python" },
          { kind: "file", byteLength: 8, mimeType: "image/png" },
        ]);
      }),
    );

    // A file chip for `file://attacker.test/s/a.ts` in an agent's message sent
    // the Windows user's NTLM credentials to attacker.test as it rendered.
    it.effect("never stats a network path", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statted: Array<string> = [];
        const service = yield* WorkspaceFileSystem.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              stat: (requestedPath) => {
                statted.push(requestedPath);
                return fs.stat(requestedPath);
              },
            }),
          ),
          Effect.provide(layerKnownWorkspacesTest),
        );
        const paths = [
          "\\\\attacker.test\\s\\a.ts",
          "//attacker.test/s/a.ts",
          "/\\attacker.test\\s",
        ];
        expect((yield* service.getMetadata({ paths })).entries).toEqual([null, null, null]);
        expect(statted).toEqual([]);
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads UTF-8 files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/index.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/index.ts",
        });

        expect(result).toMatchObject({
          relativePath: "src/index.ts",
          contents: "export const answer = 42;\n",
          byteLength: 26,
          truncated: false,
        });
      }),
    );

    it.effect("reads host files outside the workspace root by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "cleanup-report.md", "# Report\n");
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: absolutePath,
        });

        expect(result).toMatchObject({
          relativePath: absolutePath,
          contents: "# Report\n",
          byteLength: 9,
          truncated: false,
        });
      }),
    );

    it.effect("reads ~/ paths from the server home outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const home = yield* makeTempDir;
        yield* writeTextFile(home, ".claude/CLAUDE.md", "# Notes\n");
        yield* writeTextFile(cwd, "~/.claude/CLAUDE.md", "Workspace decoy\n");

        const result = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "~/.claude/CLAUDE.md" })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

        expect(result).toEqual({
          relativePath: "~/.claude/CLAUDE.md",
          contents: "# Notes\n",
          textFormat: { bom: false, encoding: "utf-8", lineEnding: "lf" },
          version: "sha256:365d0b84ae63c2afc293dedd2b00bdf0dc8d6ef70c9297d90f9e5682ab0d72ee",
          byteLength: 8,
          truncated: false,
        });
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "rejects a FIFO without blocking on open",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const fifoPath = path.join(outsideDir, "pipe");
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [fifoPath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: fifoPath })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspacePathNotFileError);
          expect((yield* workspaceFileSystem.getMetadata({ paths: [fifoPath] })).entries).toEqual([
            { kind: "other" },
          ]);
        }),
    );

    it.effect("refuses a network path outside the workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

        const error = yield* workspaceFileSystem
          .readFile({ cwd: "//nas.test/share/project", relativePath: "//attacker.test/s/a.md" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    // This resolves inside the project, but Windows reads `\\?\` paths as
    // written, so realpath on the raw string signed in to attacker.test.
    it.effect("reads the network path it checked", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.make.pipe(
          Effect.provide(Layer.merge(layerKnownWorkspacesTest, NodePath.layerWin32)),
        );
        // Rejects without touching the filesystem, so a Windows runner never looks the share up.
        const realpath = vi
          .mocked(NodeFSP.realpath)
          .mockClear()
          .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

        yield* workspaceFileSystem
          .readFile({
            cwd: "\\\\?\\UNC\\nas.test\\share\\project",
            relativePath: "\\\\?\\UNC\\attacker.test\\s\\..\\..\\nas.test\\share\\project\\a.md",
          })
          .pipe(Effect.exit);

        expect(realpath.mock.calls.map(([target]) => target)).toEqual([
          "\\\\?\\UNC\\nas.test\\share\\project\\a.md",
        ]);
      }),
    );

    // Resolving `..` before realpath would read beside the link instead of its target.
    // Windows collapses `..` before the filesystem sees a path, so it has no such reads.
    it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() === "win32")(
      "reads `..` after a link from the link's target",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir;
          yield* writeTextFile(root, "target/parent.md", "beside the target\n");
          yield* writeTextFile(root, "parent.md", "beside the link\n");
          yield* fs.makeDirectory(path.join(root, "target", "child"));
          yield* fs.symlink(path.join(root, "target", "child"), path.join(root, "link"));

          const result = yield* workspaceFileSystem.readFile({
            cwd: root,
            relativePath: `${root}/link/../parent.md`,
          });

          expect(result.contents).toBe("beside the target\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "secret.txt", "outside\n");
          yield* fileSystem.symlink(
            path.join(outsideDir, "secret.txt"),
            path.join(cwd, "linked-secret.txt"),
          );

          const error = yield* workspaceFileSystem
            .readFile({ cwd, relativePath: "linked-secret.txt" })
            .pipe(Effect.flip);
          const resolvedWorkspaceRoot = yield* fileSystem.realPath(cwd);
          const resolvedPath = yield* fileSystem.realPath(path.join(outsideDir, "secret.txt"));

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(error).toMatchObject({
            workspaceRoot: cwd,
            relativePath: "linked-secret.txt",
            resolvedWorkspaceRoot,
            resolvedPath,
          });
          expect("cause" in error).toBe(false);

          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          const missingChildError = yield* workspaceFileSystem
            .readFile(
              Object.assign(
                { cwd, relativePath: "linked-dir/missing/t3.json" },
                { allowMissing: true },
              ),
            )
            .pipe(Effect.flip);
          expect(missingChildError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFilePathEscapeError,
          );
        }),
    );

    it.effect("rejects binary files without leaking their contents into the error", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "asset.bin");
        yield* fileSystem.writeFile(absolutePath, Uint8Array.from([0x61, 0, 0x62]));

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "asset.bin" })
          .pipe(Effect.flip);
        const resolvedPath = yield* fileSystem.realPath(absolutePath);

        expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceBinaryFileError);
        expect(error).toMatchObject({
          workspaceRoot: cwd,
          relativePath: "asset.bin",
          resolvedPath,
        });
        expect("cause" in error).toBe(false);
        expect("contents" in error).toBe(false);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect.each(["a".repeat(240), "界".repeat(80)])(
      "creates and replaces a file with a 240-byte basename: %s",
      (relativePath, context) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const target = path.join(cwd, relativePath);
          expect(Buffer.byteLength(relativePath, "utf8")).toBe(240);
          // Probe the destination itself so only a smaller filesystem name limit skips.
          const supported = yield* Effect.promise(async () => {
            try {
              await NodeFS.promises.writeFile(target, "", { flag: "wx" });
              await NodeFS.promises.unlink(target);
              return true;
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "ENAMETOOLONG") {
                return false;
              }
              throw cause;
            }
          });
          if (!supported) context.skip("Filesystem does not support a 240-byte basename");

          for (const contents of ["created\n", "replaced\n"]) {
            expect(yield* service.writeFile({ cwd, relativePath, contents })).toEqual({
              relativePath,
              version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            });
            expect(yield* fs.readFileString(target)).toBe(contents);
            expect(yield* fs.readDirectory(cwd)).toEqual([relativePath]);
          }
        }),
    );

    it.effect("replaces an existing file while open readers retain the original bytes", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "file.txt", "before\n");
        const target = path.join(cwd, "file.txt");
        yield* Effect.acquireUseRelease(
          Effect.promise(() => NodeFS.promises.open(target, "r")),
          (reader) =>
            Effect.gen(function* () {
              expect(
                yield* service.writeFile({ cwd, relativePath: "file.txt", contents: "after\n" }),
              ).toMatchObject({ relativePath: "file.txt" });
              expect(yield* Effect.promise(() => reader.readFile("utf8"))).toBe("before\n");
              expect(yield* Effect.promise(() => NodeFS.promises.readFile(target, "utf8"))).toBe(
                "after\n",
              );
              expect(yield* Effect.promise(() => NodeFS.promises.readdir(cwd))).toEqual([
                "file.txt",
              ]);
            }),
          (reader) => Effect.promise(() => reader.close()),
        );
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "preserves mode bits despite a restrictive umask",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const target = path.join(cwd, "file.txt");
          yield* writeTextFile(cwd, "file.txt", "before\n");
          yield* Effect.promise(() => NodeFS.promises.chmod(target, 0o764));
          yield* Effect.acquireUseRelease(
            Effect.sync(() => process.umask(0o077)),
            () => service.writeFile({ cwd, relativePath: "file.txt", contents: "after\n" }),
            (previous) =>
              Effect.sync(() => {
                process.umask(previous);
              }),
          );
          expect((yield* Effect.promise(() => NodeFS.promises.stat(target))).mode & 0o7777).toBe(
            0o764,
          );
        }),
    );

    it.effect.each([false, true])(
      "rejects an outside symlink parent (existing file: %s)",
      (existing) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          if (existing) yield* writeTextFile(outside, "file.txt", "outside\n");
          yield* fs.symlink(outside, path.join(cwd, "alias"));
          const error = yield* service
            .writeFile({
              cwd,
              relativePath: existing ? "alias/file.txt" : "alias/new/deep/file.txt",
              contents: "bad\n",
            })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fs.readDirectory(outside)).toEqual(existing ? ["file.txt"] : []);
          if (existing)
            expect(yield* fs.readFileString(path.join(outside, "file.txt"))).toBe("outside\n");
        }),
      { skip: !symlinksSupported },
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects an outside file symlink without replacing the alias",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          yield* writeTextFile(outside, "file.txt", "outside\n");
          const alias = path.join(cwd, "alias.txt");
          yield* fs.symlink(path.join(outside, "file.txt"), alias);
          const error = yield* service
            .writeFile({ cwd, relativePath: "alias.txt", contents: "bad\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fs.readFileString(path.join(outside, "file.txt"))).toBe("outside\n");
          expect((yield* Effect.promise(() => NodeFS.promises.lstat(alias))).isSymbolicLink()).toBe(
            true,
          );
        }),
    );

    it.effect.each([false, true])(
      "rejects a dangling symlink (parent: %s)",
      (parent) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          const alias = path.join(cwd, "alias");
          yield* fs.symlink(path.join(outside, "missing"), alias);
          const error = yield* service
            .writeFile({
              cwd,
              relativePath: parent ? "alias/new/deep.txt" : "alias",
              contents: "bad\n",
            })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
          expect(yield* fs.readDirectory(outside)).toEqual([]);
          expect((yield* Effect.promise(() => NodeFS.promises.lstat(alias))).isSymbolicLink()).toBe(
            true,
          );
        }),
      { skip: !symlinksSupported },
    );

    it.effect.skipIf(!symlinksSupported)(
      "creates parents through an in-root directory alias and symlinked root",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const links = yield* makeTempDir;
          yield* fs.makeDirectory(path.join(cwd, "actual"));
          yield* fs.symlink(path.join(cwd, "actual"), path.join(cwd, "alias"));
          const rootAlias = path.join(links, "root");
          yield* fs.symlink(cwd, rootAlias);
          expect(
            yield* service.writeFile({
              cwd: rootAlias,
              relativePath: "alias/new/deep/file.txt",
              contents: "ok\n",
            }),
          ).toMatchObject({ relativePath: "alias/new/deep/file.txt" });
          expect(yield* fs.readFileString(path.join(cwd, "actual/new/deep/file.txt"))).toBe("ok\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "preserves an in-root file symlink and replaces its target",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "actual/file.txt", "before\n");
          const alias = path.join(cwd, "alias.txt");
          yield* fs.symlink(path.join(cwd, "actual/file.txt"), alias);
          yield* service.writeFile({ cwd, relativePath: "alias.txt", contents: "after\n" });
          expect((yield* Effect.promise(() => NodeFS.promises.lstat(alias))).isSymbolicLink()).toBe(
            true,
          );
          expect(yield* fs.readFileString(path.join(cwd, "actual/file.txt"))).toBe("after\n");
        }),
    );

    it.effect.each(["writeFile", "sync", "close", "rename"] as const)(
      "retains old bytes and cleans only its staging file when %s fails",
      (stage) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "file.txt", "before\n");
          yield* writeTextFile(cwd, ".unrelated.tmp", "keep\n");
          const failure = new Error("injected disk failure");
          if (stage === "rename") {
            vi.spyOn(NodeFS.promises, "rename").mockRejectedValueOnce(failure);
          } else {
            const open = NodeFS.promises.open;
            vi.spyOn(NodeFS.promises, "open").mockImplementationOnce(async (...args) => {
              const handle = await open(...args);
              vi.spyOn(handle, stage).mockImplementationOnce(async () => {
                if (stage === "writeFile") await handle.write("partial");
                throw failure;
              });
              return handle;
            });
          }
          const error = yield* service
            .writeFile({ cwd, relativePath: "file.txt", contents: "after\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
          expect(yield* fs.readFileString(path.join(cwd, "file.txt"))).toBe("before\n");
          expect(yield* fs.readFileString(path.join(cwd, ".unrelated.tmp"))).toBe("keep\n");
          expect((yield* fs.readDirectory(cwd)).sort()).toEqual([".unrelated.tmp", "file.txt"]);
        }),
    );

    it.effect("does not clean a staging pathname replaced with another file", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "file.txt", "before\n");
        const rename = NodeFS.promises.rename;
        let replacedPath = "";
        vi.spyOn(NodeFS.promises, "rename").mockImplementationOnce(async (source) => {
          replacedPath = String(source);
          await rename(source, `${source}.owned`);
          await NodeFS.promises.writeFile(source, "foreign\n");
          throw new Error("injected rename failure");
        });
        yield* service
          .writeFile({ cwd, relativePath: "file.txt", contents: "after\n" })
          .pipe(Effect.flip);
        expect(yield* fs.readFileString(path.join(cwd, "file.txt"))).toBe("before\n");
        expect(yield* fs.readFileString(replacedPath)).toBe("foreign\n");
        expect(yield* fs.readFileString(`${replacedPath}.owned`)).toBe("after\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a parent redirected outside the root before rename",
      () =>
        Effect.gen(function* () {
          const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          yield* writeTextFile(cwd, "parent/file.txt", "before\n");
          yield* writeTextFile(outside, "file.txt", "outside\n");
          const realRoot = yield* fs.realPath(cwd);
          const parent = path.join(realRoot, "parent");
          const moved = path.join(realRoot, "moved");
          const open = NodeFS.promises.open;
          vi.spyOn(NodeFS.promises, "open").mockImplementationOnce(async (...args) => {
            const handle = await open(...args);
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
              await sync();
              await NodeFS.promises.rename(parent, moved);
              await NodeFS.promises.symlink(outside, parent, "junction");
            });
            return handle;
          });
          const error = yield* service
            .writeFile({ cwd, relativePath: "parent/file.txt", contents: "after\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fs.readFileString(path.join(outside, "file.txt"))).toBe("outside\n");
          expect(yield* fs.readDirectory(outside)).toEqual(["file.txt"]);
          expect(yield* fs.readFileString(path.join(moved, "file.txt"))).toBe("before\n");
        }),
    );

    it.effect("rejects a directory destination without modifying its children", () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "directory/file.txt", "keep\n");
        yield* service
          .writeFile({ cwd, relativePath: "directory", contents: "bad\n" })
          .pipe(Effect.flip);
        expect(yield* fs.readFileString(path.join(cwd, "directory/file.txt"))).toBe("keep\n");
        expect(yield* fs.readDirectory(cwd)).toEqual(["directory"]);
      }),
    );

    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toMatchObject({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("rejects writes outside a known workspace", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: UNKNOWN_WORKSPACE_PREFIX,
        });

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "plan.md", contents: "# nope\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
        expect(yield* fileSystem.readDirectory(cwd)).toEqual([]);
      }),
    );

    it.effect("rejects writes by absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        const absolutePath = path.join(outsideDir, "cleanup-report.md");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: absolutePath, contents: "# Edited\n" })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.list({ cwd });
        expect(beforeWrite.entries.some((entry) => entry.path === "plans/effect-rpc.md")).toBe(
          false,
        );

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.list({ cwd });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.orElseSucceed(() => null));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects writes through symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "existing.md", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir"));
          yield* fileSystem.symlink(
            path.join(outsideDir, "existing.md"),
            path.join(cwd, "linked-file.md"),
          );
          yield* fileSystem.symlink(
            path.join(outsideDir, "missing.md"),
            path.join(cwd, "dangling.md"),
          );

          for (const relativePath of [
            "linked-dir/new.md",
            "linked-dir/nested/new.md",
            "linked-file.md",
          ]) {
            const error = yield* workspaceFileSystem
              .writeFile({ cwd, relativePath, contents: "# nope\n" })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          }
          const danglingError = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(danglingError).toBeInstanceOf(
            WorkspaceFileSystem.WorkspaceFileSystemOperationError,
          );
          expect(danglingError).toMatchObject({ operation: "realpath-target" });

          expect((yield* fileSystem.readDirectory(outsideDir)).toSorted()).toEqual(["existing.md"]);
          expect(yield* fileSystem.readFileString(path.join(outsideDir, "existing.md"))).toBe(
            "outside\n",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through symlinks that stay inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* makeTempDir;
          const cwd = path.join(parentDir, "workspace");
          const cwdAlias = path.join(parentDir, "workspace-alias");
          yield* writeTextFile(cwd, "docs/README.md", "old\n");
          yield* fileSystem.symlink(path.join(cwd, "docs"), path.join(cwd, "docs-alias"));
          yield* fileSystem.symlink("docs/README.md", path.join(cwd, "README.md"));
          yield* fileSystem.symlink(cwd, cwdAlias);

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "docs-alias/plans/plan.md",
            contents: "# Plan\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "README.md",
            contents: "new\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: cwdAlias,
            relativePath: "notes.md",
            contents: "notes\n",
          });
          // `..` after a link in cwd is resolved by name, as for the relative path.
          yield* fileSystem.symlink(path.join(cwd, "docs/plans"), path.join(cwd, "plans-alias"));
          yield* workspaceFileSystem.writeFile({
            cwd: `${path.join(cwd, "plans-alias")}${path.sep}..`,
            relativePath: "dotdot.md",
            contents: "dotdot\n",
          });

          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/plans/plan.md"))).toBe(
            "# Plan\n",
          );
          expect(yield* fileSystem.readFileString(path.join(cwd, "docs/README.md"))).toBe("new\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "README.md"))).toBe("docs/README.md");
          expect(yield* fileSystem.readFileString(path.join(cwd, "notes.md"))).toBe("notes\n");
          expect(yield* fileSystem.readFileString(path.join(cwd, "dotdot.md"))).toBe("dotdot\n");
        }),
    );

    // On Windows `\` is a separator, so the name cannot exist there.
    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "keeps a backslash in a file name as part of the name",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "a\\b.md", "old\n");

          yield* workspaceFileSystem.writeFile({ cwd, relativePath: "a\\b.md", contents: "new\n" });

          expect(
            (yield* workspaceFileSystem.readFile({ cwd, relativePath: "a\\b.md" })).contents,
          ).toBe("new\n");
          expect(yield* fileSystem.readDirectory(cwd)).toEqual(["a\\b.md"]);
        }),
    );

    it.effect("refuses writes into git's own folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".git/config", "[core]\n");
        // A bare repository named `.bare`, and a linked worktree's git folder inside it.
        yield* writeTextFile(cwd, ".bare/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/objects/info/packs");
        yield* writeTextFile(cwd, ".bare/refs/heads/main");
        yield* writeTextFile(cwd, ".bare/hooks/pre-push.sample");
        // Only a linked worktree's `.git` file ends the upward check, not any `.git` folder.
        yield* fileSystem.makeDirectory(path.join(cwd, ".bare/hooks/.git"));
        yield* writeTextFile(cwd, ".bare/worktrees/main/HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(cwd, ".bare/worktrees/main/commondir", "../..\n");
        if (symlinksSupported) yield* fileSystem.symlink(".git", path.join(cwd, "docs"));

        for (const [folder, relativePath] of [
          [cwd, ".git/config"],
          [cwd, ".git/hooks/pre-commit"],
          [cwd, "sub/.git"],
          [cwd, ".GIT/config"],
          [cwd, ".gıt/config"],
          [cwd, ".git. /config"],
          [cwd, ".git::$INDEX_ALLOCATION/config"],
          [cwd, "GIT~1/config"],
          [path.join(cwd, ".git"), "config"],
          [cwd, ".bare/config"],
          [path.join(cwd, ".bare"), "hooks/post-checkout"],
          [path.join(cwd, ".bare/hooks"), "post-checkout"],
          [path.join(cwd, ".bare/worktrees/main"), "commondir"],
          ...(symlinksSupported ? [[cwd, "docs/config"] as const] : []),
        ] as const) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd: folder, relativePath, contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
        }

        expect(yield* fileSystem.readFileString(path.join(cwd, ".git/config"))).toBe("[core]\n");
        expect(yield* fileSystem.exists(path.join(cwd, ".bare/config"))).toBe(false);
        expect((yield* fileSystem.readDirectory(path.join(cwd, ".bare/hooks"))).toSorted()).toEqual(
          [".git", "pre-push.sample"],
        );
        expect(yield* fileSystem.exists(path.join(cwd, "sub"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".bare/worktrees/main/commondir")),
        ).toBe("../..\n");
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses writes through a git config that links to a file outside git's folders",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* writeTextFile(cwd, "shared/config", "[core]\n");
          yield* fileSystem.makeDirectory(path.join(cwd, ".git"));
          yield* fileSystem.symlink("../shared/config", path.join(cwd, ".git/config"));

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: ".git/config", contents: "[core]\n\tfsmonitor = x\n" })
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFilePathEscapeError);
          expect(yield* fileSystem.readFileString(path.join(cwd, "shared/config"))).toBe(
            "[core]\n",
          );
        }),
    );

    it.effect("writes files that sit beside git's folders", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parentDir = yield* makeTempDir;
        // A bare repository with a worktree checked out inside it.
        const bare = path.join(parentDir, "repo.git");
        yield* writeTextFile(bare, "HEAD", "ref: refs/heads/main\n");
        yield* writeTextFile(bare, "objects/info/packs");
        yield* writeTextFile(bare, "refs/heads/main");
        yield* writeTextFile(bare, "main/.git", `gitdir: ${path.join(bare, "worktrees/main")}\n`);

        for (const [cwd, relativePath] of [
          [path.join(bare, "main"), ".gitignore"],
          [path.join(bare, "main"), ".gitattributes"],
          [path.join(bare, "main"), ".github/workflows/ci.yml"],
          [path.join(bare, "main"), "vendor/lib.git/README.md"],
          [path.join(bare, "main/.github"), "CODEOWNERS"],
          [bare, "main/plan.md"],
        ] as const) {
          yield* workspaceFileSystem.writeFile({ cwd, relativePath, contents: "ok\n" });
          expect(yield* fileSystem.readFileString(path.join(cwd, relativePath))).toBe("ok\n");
        }
      }),
    );
  });
});
