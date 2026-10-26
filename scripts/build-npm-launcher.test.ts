// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import { buildNpmLauncher } from "./build-npm-launcher.ts";
import { verifyNpmLauncherTarball } from "./lib/release-verify.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

/** A release archive for this host with a stub `goat` that echoes its args and launcher. */
const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (
  root: string,
  version = VERSION,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `goat-${version}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "release", stem, "goat"),
    '#!/bin/sh\necho "stub $* launcher=$GOAT_NPM_LAUNCHER_PATH"\nexit 7\n',
  );
  yield* fs.chmod(path.join(root, "release", stem, "goat"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: process.env.PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${version}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${version}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    corruptChecksum: () => {
      checksum = "0".repeat(64);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "npm installs and updates both GOAT commands in the original isolated prefix without a registry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-npm-install-" });
        const prefix = path.join(root, "custom prefix");
        const env = {
          PATH: process.env.PATH,
          HOME: path.join(root, "user"),
          GOAT_HOME: path.join(root, "home"),
          NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
          NPM_CONFIG_GLOBALCONFIG: path.join(root, "global-npmrc"),
          NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
        };
        for (const version of [VERSION, "1.2.4-nightly.20261024.1"]) {
          const stage = path.join(root, version);
          yield* fs.makeDirectory(stage);
          const built = yield* buildNpmLauncher({ version, outputDir: path.join(stage, "out") });
          const release = yield* serveFakeRelease(stage, version);
          const installed = yield* run(
            "npm",
            [
              "--prefix",
              prefix,
              "install",
              "--global",
              "--offline",
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              built.tarball,
            ],
            { cwd: root, env },
          );
          assert.equal(installed.exitCode, 0, installed.stderr);
          const launcherEnv = { ...env, GOAT_RELEASE_BASE_URL: release.baseUrl };
          for (const command of ["goat", "t3"]) {
            const result = yield* run(path.join(prefix, "bin", command), ["--version"], {
              cwd: root,
              env: launcherEnv,
            });
            assert.equal(result.exitCode, 7, result.stderr);
            assert.include(result.stdout, "stub --version launcher=");
          }
          assert.include(release.requests.join("\n"), `/v${version}/SHA256SUMS`);
          assert.equal(
            (yield* fs.readFileString(
              path.join(env.GOAT_HOME, "runtime/goat/versions", version, ".install-complete"),
            )).trim(),
            version,
          );
          const manifest = yield* decodeManifest(
            yield* fs.readFileString(
              path.join(prefix, "lib/node_modules/@goat-si/goat/package.json"),
            ),
          );
          assert.equal(manifest.name, "@goat-si/goat");
          assert.equal(manifest.version, version);
        }
      }),
  );

  it.effect(
    "release verification rejects tarballs with a foreign name, version, publication flag, bin, or dependencies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const output = yield* buildNpmLauncher({ version: VERSION, outputDir: root });
        yield* verifyNpmLauncherTarball(output.tarball, VERSION);
        const installed = path.join(root, "unpacked");
        yield* fs.makeDirectory(installed);
        assert.equal(
          (yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
            cwd: root,
            env: { PATH: process.env.PATH },
          })).exitCode,
          0,
        );
        const manifestPath = path.join(installed, "package/package.json");
        const manifest = yield* decodeManifest(yield* fs.readFileString(manifestPath));
        for (const patch of [
          { name: "goat" },
          { name: "t3" },
          { version: "9.9.9" },
          { private: false },
          { bin: { goat: "./dist/foreign.mjs" } },
          { dependencies: { goat: "*" } },
          { optionalDependencies: { goat: "*" } },
          { peerDependencies: { goat: "*" } },
          { bundledDependencies: ["goat"] },
          { bundleDependencies: ["goat"] },
          { scripts: { postinstall: "npm install goat" } },
        ]) {
          yield* fs.writeFileString(manifestPath, JSON.stringify({ ...manifest, ...patch }));
          assert.equal(
            (yield* run("tar", ["-czf", output.tarball, "-C", installed, "package"], {
              cwd: root,
              env: { PATH: process.env.PATH },
            })).exitCode,
            0,
          );
          assert.equal(
            (yield* Effect.result(verifyNpmLauncherTarball(output.tarball, VERSION)))._tag,
            "Failure",
          );
        }
      }),
  );
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-npm-launcher-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "@goat-si/goat");
        assert.equal(manifest.private, true);
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { goat: "./bin/goat.mjs", t3: "./bin/goat.mjs" });
        assert.isTrue(output.tarball.endsWith("goat-npm.tgz"));
        // Nothing for npm to resolve, so nothing that can lag behind the launcher.
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);

        // Run what npm would install: the published tarball, unpacked.
        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: process.env.PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          GOAT_HOME: home,
          GOAT_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/goat.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        // The same layout the install scripts and `goat update` use.
        const versionDir = path.join(home, "runtime/goat/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/goat/versions"))).sort(),
          [VERSION],
        );

        // A second run reuses the download.
        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst);

        // Services installed before 0.0.41 fork dist/bin.mjs and talk to the
        // server over IPC; the channel and SIGTERM must reach the executable.
        const ipcServer = path.join(home, "runtime/goat/versions", VERSION, "goat");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        // Two first runs at once both start, and neither removes the other's install.
        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, GOAT_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 7, one.stderr);
        assert.equal(two.exitCode, 7, two.stderr);
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(raceHome, "runtime/goat/versions")),
          [VERSION],
        );

        // Without GOAT_HOME, a pre-rename ~/.t3 that holds state stays the home.
        const userHome = path.join(root, "user");
        yield* fs.makeDirectory(path.join(userHome, ".t3/userdata"), { recursive: true });
        const legacyHome = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: userHome, GOAT_RELEASE_BASE_URL: release.baseUrl },
        });
        assert.equal(legacyHome.exitCode, 7, legacyHome.stderr);
        assert.isTrue(
          yield* fs.exists(path.join(userHome, ".t3/runtime/goat/versions", VERSION, "goat")),
        );
        assert.isFalse(yield* fs.exists(path.join(userHome, ".goat")));

        // A download that does not match the release checksums is never installed.
        release.corruptChecksum();
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, GOAT_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/goat/versions")),
          [],
        );
      }),
  );
});
