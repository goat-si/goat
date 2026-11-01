// @effect-diagnostics nodeBuiltinImport:off - Observes only the fixture children this launcher spawns.
import type * as NodeChildProcess from "node:child_process";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { cliArchiveFileName, cliArchivePlatformKey } from "@goat/shared/cliRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http";
import { vi } from "vite-plus/test";

import { makeMockUpdateRouteLayer } from "../../../scripts/mock-update-server.ts";
import { ensurePinnedRuntimeInstalled } from "./cloud/pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_STATE_FILE } from "./cloud/serviceProtocol.ts";
import * as ProcessRunner from "./processRunner.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";

const observed = vi.hoisted(() => ({
  onChild: undefined as ((child: NodeChildProcess.ChildProcess) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    observed.onChild?.(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const version = "1.1.0";

it.layer(NodeServices.layer)("release install and launcher trial", (it) => {
  it.effect.each(["failed-start", "wrong-smoke", "checksum-mismatch"] as const)(
    "handles %s from a real mock release archive",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-update-release-" });
        const platform = yield* HostProcess.Platform;
        const arch = yield* HostProcess.Architecture;
        const platformKey = cliArchivePlatformKey(platform, arch);
        assert.isDefined(platformKey);
        // The fixture uses a Node shebang, like serviceLauncher.test.ts, on Unix release targets.
        assert.notEqual(platform, "win32");
        const archiveName = cliArchiveFileName(version, platformKey!);
        const releaseRoot = path.join(root, "releases");
        const assets = path.join(releaseRoot, "download", `v${version}`);
        const staging = path.join(root, "archive-source");
        const archiveStem = archiveName.replace(/\.tar\.gz$/, "");
        const archiveTree = path.join(staging, archiveStem);
        const executedPath = path.join(root, "runtime-executed");
        yield* fs.makeDirectory(assets, { recursive: true });
        yield* fs.makeDirectory(archiveTree, { recursive: true });
        const entry = path.join(archiveTree, "goat");
        yield* fs.writeFileString(
          entry,
          `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(executedPath)}, process.argv.slice(2).join(" "));
if (process.argv[2] === "--version") { console.log("${version}"); process.exit(0); }
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (${JSON.stringify(scenario)} === "failed-start") process.exit(23);
const server = require("node:http").createServer((request, response) => {
  if (request.url !== "/.well-known/goat/environment") process.exit(24);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ serverVersion: "8.0.0", protocol: { ssh: { min: 1001, max: 1001 }, orchestration: { min: 1, max: 2 } } }));
});
server.listen(0, "127.0.0.1", () => process.send({ type: "prepared", updateId: context.update.id, port: server.address().port }));
`,
        );
        yield* fs.chmod(entry, 0o755);
        const packed = yield* runner.run({
          command: "tar",
          args: ["-czf", path.join(assets, archiveName), "-C", staging, archiveStem],
        });
        assert.equal(packed.code, 0);
        const archive = yield* fs.readFile(path.join(assets, archiveName));
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archive));
        const checksum =
          scenario === "checksum-mismatch"
            ? "0".repeat(64)
            : Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
                "",
              );
        yield* fs.writeFileString(path.join(assets, "SHA256SUMS"), `${checksum}  ${archiveName}\n`);
        const baseDir = path.join(root, "home");
        const previousDir = path.join(baseDir, "runtime", "goat", "versions", "1.0.0");
        yield* fs.makeDirectory(previousDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(previousDir, "goat"),
          `#!${process.execPath}
process.send({ type: "test-previous-active" });
setInterval(() => {}, 1000);
`,
        );
        yield* fs.chmod(path.join(previousDir, "goat"), 0o755);
        yield* fs.writeFileString(path.join(previousDir, ".install-complete"), "1.0.0\n");
        const statePath = path.join(baseDir, "runtime", SERVICE_STATE_FILE);
        const initial = { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" } as const;
        yield* Effect.promise(() => writeServiceState(statePath, initial));
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
        yield* fs.writeFileString(dbPath, "database before release");
        yield* Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          assert.isTrue("port" in server.address);
          if (!("port" in server.address)) return yield* Effect.die("Expected TCP listener");
          const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
          let validations = 0;
          const installation = yield* ensurePinnedRuntimeInstalled({
            baseDir,
            version,
            fs,
            path,
            runner,
            platform,
            arch,
            httpClient: client,
            releaseBaseUrl: `http://127.0.0.1:${server.address.port}/download`,
            validate: (paths) =>
              Effect.gen(function* () {
                validations++;
                const result = yield* runner
                  .run({ command: paths.entryPath, args: ["--version"] })
                  .pipe(Effect.orDie);
                assert.equal(result.code, 0);
                assert.equal(result.stdout.trim(), version);
              }),
          }).pipe(Effect.result);
          if (scenario === "checksum-mismatch") {
            assert.equal(installation._tag, "Failure");
            if (
              installation._tag === "Failure" &&
              installation.failure._tag === "PinnedRuntimeInstallError"
            )
              assert.equal(
                installation.failure.step,
                "verifying the GOAT release archive checksum",
              );
            assert.equal(validations, 0);
            assert.isFalse(yield* fs.exists(executedPath));
            assert.isFalse(
              yield* fs.exists(path.join(baseDir, "runtime", "goat", "versions", version)),
            );
            assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), initial);
            return;
          }
          assert.equal(installation._tag, "Success");
          assert.equal(validations, 1);
          yield* Effect.promise(() =>
            writeServiceState(statePath, {
              ...initial,
              update: {
                id: "release-update",
                fromVersion: "1.0.0",
                targetVersion: version,
                dbPath,
                status: "pending",
              },
            }),
          );
          const previousActive = Promise.withResolvers<NodeChildProcess.ChildProcess>();
          const children: NodeChildProcess.ChildProcess[] = [];
          observed.onChild = (child) => {
            children.push(child);
            child.on("message", (message) => {
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "test-previous-active"
              )
                previousActive.resolve(child);
            });
          };
          const launcher = new Launcher(
            baseDir,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run().then(
            () => undefined,
            (error: unknown) => error,
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await launcher.stop("SIGTERM");
              observed.onChild = undefined;
            }),
          );
          const previous = yield* Effect.promise(() => previousActive.promise);
          assert.isNull(previous.exitCode);
          assert.isTrue(previous.connected);
          assert.equal(children.length, 2);
          const state = yield* Effect.promise(() => readServiceState(statePath));
          assert.equal(state.activeVersion, "1.0.0");
          assert.equal(state.update?.status, "rolled-back");
          assert.equal(
            state.update?.status === "rolled-back" ? state.update.reason : undefined,
            scenario === "failed-start" ? "candidate-exited:23" : "smoke-failed:version",
          );
          assert.equal(yield* fs.readFileString(dbPath), "database before release");
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          assert.isUndefined(yield* Effect.promise(() => running));
        }).pipe(
          Effect.provide(
            HttpRouter.serve(makeMockUpdateRouteLayer(yield* fs.realPath(releaseRoot)), {
              disableListenLog: true,
              disableLogger: true,
            }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
          ),
        );
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});
