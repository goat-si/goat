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
