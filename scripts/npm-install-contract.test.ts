import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

it.layer(NodeServices.layer)("GOAT npm install contract", (it) => {
  it.effect("install, update and release guidance select the same GOAT tarball", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
      for (const file of [
        "docs/user/install.md",
        "docs/user/updating.md",
        "docs/operations/release.md",
      ]) {
        const text = yield* fs.readFileString(path.join(root, file));
        assert.include(text, "goat-npm.tgz", file);
        assert.include(text, "goat-si/goat-releases", file);
      }
      for (const file of [
        "docs/user/install.md",
        "docs/user/updating.md",
        "docs/operations/release.md",
        "apps/server/src/serverOwnership.ts",
        "apps/desktop/src/backend/DesktopBackendPool.ts",
        "apps/desktop/src/wsl/DesktopWslBackend.ts",
      ]) {
        const text = yield* fs.readFileString(path.join(root, file));
        assert.notMatch(text, /\b(?:npx|bunx|pnpm dlx)\s+goat(?:@|\s|`)/, file);
        assert.notMatch(
          text,
          /\bnpm\s+(?:i|install|update)\s+(?:-g\s+|--global\s+)?goat(?:@|\s|`)/,
          file,
        );
      }
      const workflow = yield* fs.readFileString(
        path.join(root, ".github/workflows/goat-nightly.yml"),
      );
      assert.isBelow(
        workflow.indexOf("node scripts/build-npm-launcher.ts"),
        workflow.indexOf("node scripts/verify-release-artifacts.ts assemble"),
      );
      assert.include(workflow, "goat-npm.tgz");
    }),
  );

  it.effect("the old publisher refuses before touching any npm registry", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const empty = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(empty, "goat.tgz"), "stale legacy tarball");
      yield* fs.writeFileString(
        path.join(empty, "npm"),
        "#!/bin/sh\necho npm-was-spawned >&2\nexit 99\n",
        { mode: 0o755 },
      );
      const script = yield* path.fromFileUrl(
        new URL("../apps/server/scripts/cli.ts", import.meta.url),
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [script, "publish", "--packages-dir", empty, "--dry-run"],
          { cwd: empty, env: { PATH: empty }, extendEnv: false },
        ),
      );
      const [stderr, stdout, code] = yield* Effect.all(
        [
          child.stderr.pipe(Stream.decodeText(), Stream.runCollect),
          child.stdout.pipe(Stream.decodeText(), Stream.runCollect),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      assert.notEqual(Number(code), 0);
      assert.include([...stderr, ...stdout].join(""), "Registry publishing is disabled");
      assert.notInclude([...stderr, ...stdout].join(""), "npm-was-spawned");
    }),
  );
});
