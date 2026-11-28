// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import { expect } from "vite-plus/test";

effectIt.layer(NodeServices.layer)("POSIX PATH", (it) => {
  // Candidates are checked against the process cwd, so the lookup runs in a child with a temp cwd.
  const resolveInChild = `
import { createRequire } from "node:module";
const [shellPath, command, rawPaths, rawGitPaths, gitShim, xcodeGit] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
const resolved = {};
const resolvedGit = {};
const defaultResolver = Shell.SpawnExecutableResolution.defaultValue();
const resolveExecutable = async (...args) => {
  const found = await defaultResolver(...args);
  return found === gitShim ? "/usr/bin/git" : found;
};
const locateXcodeGit = () => Effect.succeed(xcodeGit);
await Effect.runPromise(Effect.gen(function* () {
  const caches = new Map();
  for (const [label, { PATH, cwd, cacheGroup }] of Object.entries(JSON.parse(rawPaths))) {
    process.chdir(cwd);
    let cache = caches.get(cacheGroup);
    if (!cache) caches.set(cacheGroup, cache = new Map());
    resolved[label] = {
      effect: yield* Shell.resolveCommandPath(command, { env: { PATH } }).pipe(
        Effect.provideService(HostProcess.Platform, process.platform),
        Effect.provideService(Shell.CommandResolutionCache, cache),
      ),
      spawn: (yield* Effect.promise(async () => Shell.SpawnExecutableResolution.defaultValue()(command, process.platform, { PATH }))) ?? null,
    };
  }
  for (const [label, { PATH, cwd, cacheGroup }] of Object.entries(JSON.parse(rawGitPaths))) {
    process.chdir(cwd);
    let cache = caches.get(cacheGroup);
    if (!cache) caches.set(cacheGroup, cache = new Map());
    resolvedGit[label] = yield* Shell.resolveSpawnCommand("git", ["status"], { env: { PATH } }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(Shell.SpawnExecutableResolution, resolveExecutable),
      Effect.provideService(Shell.XcodeGitLocation, locateXcodeGit),
      Effect.provideService(Shell.CommandResolutionCache, cache),
    );
  }
}).pipe(Effect.provide(layer)));
console.log(JSON.stringify({ resolved, resolvedGit }));
`;

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "searches the current directory for empty POSIX PATH components across cached lookups",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Real paths: the child's process.cwd() reports them, and anchored matches start with it.
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-cwd-" }),
        );
        const listed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-listed-" });
        const empty = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-empty-path-absent-" }),
        );
        const command = "t3-empty-path-cli";
        const inCwd = path.join(cwd, command);
        const inListed = path.join(listed, command);
        const gitShim = path.join(listed, "git");
        const xcodeGit = path.join(listed, "xcode-git");
        yield* fs.writeFileString(inCwd, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(inListed, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(path.join(cwd, "git"), "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(gitShim, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(xcodeGit, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.utimes(cwd, 4_102_444_800, 4_102_444_800);
        yield* fs.utimes(empty, 4_102_444_800, 4_102_444_800);
        const missing = path.join(cwd, "missing");

        const searches = {
          dot: { PATH: ".", expected: inCwd },
          leading: { PATH: `:${missing}`, expected: inCwd },
          trailing: { PATH: `${missing}:`, expected: inCwd },
          interior: { PATH: `${missing}::${missing}-2`, expected: inCwd },
          leadingBeforeListed: { PATH: `:${listed}`, expected: inCwd },
          listedBeforeTrailing: { PATH: `${listed}:`, expected: inListed },
          dotBeforeEmpty: { PATH: `.:${missing}:`, expected: inCwd },
          emptyBeforeDot: { PATH: `:.:${missing}`, expected: inCwd },
          entirelyEmpty: { PATH: "", expected: null },
          whitespaceOnly: { PATH: `${missing}: `, expected: null },
        };

        const cachedSearches = {
          cachedMiss: { PATH: `:${missing}`, cwd: empty, cacheGroup: "miss", expected: null },
          afterMiss: { PATH: `:${missing}`, cwd, cacheGroup: "miss", expected: inCwd },
          cachedHit: { PATH: `:${missing}`, cwd, cacheGroup: "hit", expected: inCwd },
          afterHit: { PATH: `:${missing}`, cwd: empty, cacheGroup: "hit", expected: null },
          cachedListed: {
            PATH: `:${listed}`,
            cwd: empty,
            cacheGroup: "listed",
            expected: inListed,
          },
          beforeListed: { PATH: `:${listed}`, cwd, cacheGroup: "listed", expected: inCwd },
          cachedLocal: { PATH: `:${listed}`, cwd, cacheGroup: "local", expected: inCwd },
          afterLocal: { PATH: `:${listed}`, cwd: empty, cacheGroup: "local", expected: inListed },
        };
        const entries = [
          ...Object.entries(cachedSearches),
          ...Object.entries(searches).map(
            ([label, row]) => [label, { ...row, cwd, cacheGroup: label }] as const,
          ),
        ];
        const gitEntries = ["", "."].flatMap((entry) => {
          const PATH = `${entry}:${listed}`;
          // An empty entry launches the local git it found; "." keeps its relative spelling.
          const localGit = entry === "" ? path.join(cwd, "git") : "git";
          return [
            { PATH, cwd: empty, cacheGroup: `xcode-first-${entry}`, expected: xcodeGit },
            { PATH, cwd, cacheGroup: `xcode-first-${entry}`, expected: localGit },
            { PATH, cwd, cacheGroup: `local-first-${entry}`, expected: localGit },
            { PATH, cwd: empty, cacheGroup: `local-first-${entry}`, expected: xcodeGit },
          ];
        });
        // A match from an absolute entry stays bare `git`, even when PATH also has a relative entry.
        gitEntries.push({ PATH: `.:${cwd}`, cwd: empty, cacheGroup: "absolute", expected: "git" });
        const stdout = NodeChildProcess.execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            resolveInChild,
            path.join(import.meta.dirname, "shell.ts"),
            command,
            JSON.stringify(
              Object.fromEntries(
                entries.map(([label, row]) => [
                  label,
                  {
                    PATH: row.PATH,
                    cwd: row.cwd,
                    cacheGroup: row.cacheGroup,
                  },
                ]),
              ),
            ),
            JSON.stringify(gitEntries),
            gitShim,
            xcodeGit,
          ],
          { cwd, encoding: "utf8", env: {} },
        );
        const {
          resolved,
          resolvedGit,
        }: {
          resolved: Record<string, { effect: string | null; spawn: string | null }>;
          resolvedGit: Record<string, { command: string; args: string[]; shell: boolean }>;
        } = JSON.parse(stdout);

        // A relative result is relative to the child's cwd.
        const anchored = (found: string | null, directory: string) =>
          found === null ? null : path.resolve(directory, found);
        const directories = Object.fromEntries(entries.map(([label, row]) => [label, row.cwd]));
        expect(
          Object.fromEntries(
            Object.entries(resolved).map(([label, found]) => {
              const directory = directories[label];
              if (directory === undefined) throw new Error(`Unexpected resolver case: ${label}`);
              return [
                label,
                {
                  effect: anchored(found.effect, directory),
                  spawn: anchored(found.spawn, directory),
                },
              ];
            }),
          ),
        ).toEqual(
          Object.fromEntries(
            entries.map(([label, row]) => [label, { effect: row.expected, spawn: row.expected }]),
          ),
        );
        // A match through an empty component comes back absolute, so callers can launch it from
        // another cwd or through a wrapper; a literal "." keeps main's relative spelling.
        for (const label of [
          "leading",
          "trailing",
          "interior",
          "leadingBeforeListed",
          "afterMiss",
          "cachedHit",
          "beforeListed",
          "cachedLocal",
          "emptyBeforeDot",
        ]) {
          expect(resolved[label], label).toEqual({ effect: inCwd, spawn: inCwd });
        }
        for (const label of ["dot", "dotBeforeEmpty"]) {
          expect(resolved[label], label).toEqual({ effect: command, spawn: command });
        }
        expect(resolvedGit).toEqual(
          Object.fromEntries(
            gitEntries.map((row, index) => [
              String(index),
              { command: row.expected, args: ["status"], shell: false },
            ]),
          ),
        );
      }),
  );

  // Deleting the working directory makes process.cwd() throw, so this also runs in a child.
  const resolveWithoutCwd = `
import { createRequire } from "node:module";
import * as NodeFS from "node:fs";
const [shellPath, command, PATH, removed, gitShim, xcodeGit] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
const defaultResolver = Shell.SpawnExecutableResolution.defaultValue();
const resolveExecutable = async (...args) => {
  const found = await defaultResolver(...args);
  return found === gitShim ? "/usr/bin/git" : found;
};
process.chdir(removed);
NodeFS.rmdirSync(removed);
const cache = new Map();
const result = await Effect.runPromise(Effect.gen(function* () {
  const effect = yield* Shell.resolveCommandPath(command, { env: { PATH } }).pipe(
    Effect.provideService(HostProcess.Platform, process.platform),
  );
  const git = yield* Shell.resolveSpawnCommand("git", ["status"], { env: { PATH } }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(Shell.SpawnExecutableResolution, resolveExecutable),
    Effect.provideService(Shell.XcodeGitLocation, () => Effect.succeed(xcodeGit)),
  );
  return { effect, git: git.command };
}).pipe(
  Effect.provideService(Shell.CommandResolutionCache, cache),
  Effect.provide(layer),
));
console.log(JSON.stringify({ ...result, cached: cache.size }));
`;

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "searches absolute PATH entries and caches nothing when the working directory is gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const listed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gone-cwd-listed-" });
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gone-cwd-parent-" });
        const removed = path.join(parent, "removed");
        yield* fs.makeDirectory(removed);
        const command = "t3-gone-cwd-cli";
        const inListed = path.join(listed, command);
        const gitShim = path.join(listed, "git");
        const xcodeGit = path.join(listed, "xcode-git");
        yield* fs.writeFileString(inListed, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(gitShim, "#!/bin/sh\n", { mode: 0o755 });
        yield* fs.writeFileString(xcodeGit, "#!/bin/sh\n", { mode: 0o755 });

        const stdout = NodeChildProcess.execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            resolveWithoutCwd,
            path.join(import.meta.dirname, "shell.ts"),
            command,
            `:${listed}`,
            removed,
            gitShim,
            xcodeGit,
          ],
          { cwd: parent, encoding: "utf8", env: {} },
        );

        expect(JSON.parse(stdout)).toEqual({ effect: inListed, git: xcodeGit, cached: 0 });
      }),
  );

  // Node caches process.cwd(), so after a rename it names a path that no longer exists.
  const resolveAfterRename = `
import { createRequire } from "node:module";
import * as NodeFS from "node:fs";
const [shellPath, command, cwd, renamed] = process.argv.slice(1);
const requireFromShell = createRequire(shellPath);
const Effect = await import(requireFromShell.resolve("effect/Effect"));
const { layer } = await import(requireFromShell.resolve("@effect/platform-node/NodeServices"));
const HostProcess = await import(shellPath.replace(/shell\\.ts$/, "HostProcess.ts"));
const Shell = await import(shellPath);
process.chdir(cwd);
process.cwd();
NodeFS.renameSync(cwd, renamed);
const resolved = await Effect.runPromise(
  Shell.resolveCommandPath(command, { env: { PATH: "bin" } }).pipe(
    Effect.provideService(HostProcess.Platform, process.platform),
    Effect.provideService(Shell.CommandResolutionCache, new Map()),
    Effect.provide(layer),
  ),
);
console.log(JSON.stringify(resolved));
`;

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resolves a relative PATH entry after the working directory is renamed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-renamed-cwd-" });
        const cwd = path.join(parent, "before");
        const command = "t3-renamed-cwd-cli";
        yield* fs.makeDirectory(path.join(cwd, "bin"), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, "bin", command), "#!/bin/sh\n", { mode: 0o755 });

        const stdout = NodeChildProcess.execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            resolveAfterRename,
            path.join(import.meta.dirname, "shell.ts"),
            command,
            cwd,
            path.join(parent, "after"),
          ],
          { cwd: parent, encoding: "utf8", env: {} },
        );

        expect(JSON.parse(stdout)).toBe(path.join("bin", command));
      }),
  );
});
