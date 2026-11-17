// @effect-diagnostics nodeBuiltinImport:off - spells paths with the native realpath and runs the hook in a plain Node child.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BundleNotSelfContainedError,
  packWindowsServerAsar,
  verifyPackagedBundleIsSelfContained,
} from "./build-desktop-artifact.ts";
import { BUNDLE_SELF_CHECK_RESOLVE_HOOK } from "./lib/bundle-self-check-hook.ts";

// The self-check runs its probe under the OS temp directory. A node_modules above it is real
// machine state (an install left in /private/tmp), so the probe must judge only the packaged tree.
const withAncestorNodeModules = Effect.fn("test.withAncestorNodeModules")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-ancestor-node-modules-" });
  const packageDir = path.join(root, "node_modules/goat-ancestor-only-package");
  yield* fs.makeDirectory(packageDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "goat-ancestor-only-package", main: "index.js" }),
  );
  yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = 1;\n");
  yield* fs.writeFileString(path.join(packageDir, "addon.node"), "not a native addon");
  const tempDir = path.join(root, "tmp");
  yield* fs.makeDirectory(tempDir);
  const names = ["TMPDIR", "TEMP", "TMP"] as const;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const saved = names.map((name) => [name, process.env[name]] as const);
      for (const name of names) process.env[name] = tempDir;
      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }),
  );
});

const serverAsar = Effect.fn("test.serverAsar")(function* (serverEntrySource: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-selfcheck-bundle-" });
  const sourceDir = path.join(root, "server-source");
  const entry = path.join(sourceDir, "apps/server/dist/bin.mjs");
  yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
  yield* fs.writeFileString(entry, serverEntrySource);
  // The Windows packer requires at least one unpacked PE native.
  const native = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(native), { recursive: true });
  yield* fs.writeFileString(native, "MZ native-binary");
  const asarPath = path.join(root, "server.asar");
  yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
  return asarPath;
});

// A tiny tree directly under the OS temp directory, where the builder makes its probe.
const hookProbe = Effect.fn("test.hookProbe")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-selfcheck-hook-" });
  const app = path.join(root, "app");
  yield* fs.makeDirectory(app);
  yield* fs.writeFileString(path.join(app, "dep.mjs"), "export default 1;\n");
  yield* fs.writeFileString(path.join(app, "entry.mjs"), 'import "./dep.mjs";\n');
  yield* fs.writeFileString(path.join(app, "escape.mjs"), 'import "../outside.mjs";\n');
  yield* fs.writeFileString(path.join(root, "outside.mjs"), "export default 1;\n");
  const hookPath = path.join(root, "contain-resolution.cjs");
  yield* fs.writeFileString(hookPath, BUNDLE_SELF_CHECK_RESOLVE_HOOK);
  // The temp directory's own spelling (C:\Users\RUNNER~1 on a hosted Windows runner), the native
  // realpath's (the long name, /private/var), and a letter-case variant where the volume folds case.
  const flipped = root.replace("goat-selfcheck-hook-", "GOAT-SELFCHECK-HOOK-");
  const canonical = NodeFS.realpathSync.native(root);
  const spellings = [root, canonical, ...(NodeFS.existsSync(flipped) ? [flipped] : [])];
  const run = (treeRoot: string, entry: string) => {
    const tree = NodeURL.pathToFileURL(`${path.join(treeRoot, "app")}${path.sep}`).href;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--no-global-search-paths", "--require", hookPath, entry],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", GOAT_BUNDLE_SELF_CHECK_TREE: tree },
      },
    );
    return { tree, entry, status: result.status, stderr: result.stderr };
  };
  return { canonical, spellings, run, path };
});

it.layer(NodeServices.layer)("bundle self-check resolve hook", (it) => {
  it.effect("accepts the tree's own files however the tree and the entry are spelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spellings, run, path } = yield* hookProbe();
        const failures: string[] = [];
        for (const treeRoot of spellings) {
          for (const entryRoot of spellings) {
            const result = run(treeRoot, path.join(entryRoot, "app", "entry.mjs"));
            if (result.status !== 0) {
              failures.push(
                `tree ${result.tree} rejected entry ${result.entry} (exit ${String(result.status)}):\n${result.stderr}`,
              );
            }
          }
        }
        assert.deepStrictEqual(failures, []);
      }),
    ),
  );

  it.effect("still rejects an import that resolves outside the tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { canonical, spellings, run, path } = yield* hookProbe();
        for (const entryRoot of spellings) {
          const result = run(canonical, path.join(entryRoot, "app", "escape.mjs"));
          assert.notStrictEqual(result.status, 0, result.stderr);
          assert.include(result.stderr, "ERR_MODULE_NOT_FOUND");
          assert.include(result.stderr, "outside the packaged tree");
        }
      }),
    ),
  );
});

it.layer(NodeServices.layer)("bundle self-check", (it) => {
  it.effect(
    "verifies a self-contained sidecar when the temp directory has an ancestor node_modules",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withAncestorNodeModules();
          const asarPath = yield* serverAsar("console.log('server');\n");
          yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: false });
        }),
      ),
  );

  it.effect.each([
    ["import", 'import "goat-ancestor-only-package";\n'],
    [
      "require",
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("goat-ancestor-only-package");\n',
    ],
    [
      "child Node process",
      'import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, ["-e", "require(\'goat-ancestor-only-package\')"], { stdio: "inherit" });\n',
    ],
    [
      "string-evaluated worker",
      'import { Worker } from "node:worker_threads";\nawait new Promise((resolve, reject) => new Worker("require(\'goat-ancestor-only-package\')", { eval: true }).on("error", reject).on("exit", resolve));\n',
    ],
    [
      "native addon",
      [
        'import { existsSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "// Found by walking directories, as addon loaders do, so it never passes through resolve.",
        'const addon = "node_modules/goat-ancestor-only-package/addon.node";',
        "let dir = dirname(fileURLToPath(import.meta.url));",
        "while (!existsSync(join(dir, addon))) dir = dirname(dir);",
        "process.dlopen({ exports: {} }, join(dir, addon));",
        "",
      ].join("\n"),
    ],
  ] as const)(
    "rejects a sidecar whose %s resolves only through an ancestor node_modules",
    ([, serverEntrySource]) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* withAncestorNodeModules();
          const asarPath = yield* serverAsar(serverEntrySource);
          const error = yield* verifyPackagedBundleIsSelfContained({
            asarPath,
            verbose: false,
          }).pipe(Effect.flip);

          assert.instanceOf(error, BundleNotSelfContainedError);
          assert.include(error.output, "goat-ancestor-only-package");
          assert.include(error.output, "outside the packaged tree");
        }),
      ),
  );
});
