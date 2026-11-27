// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  resolveLatestProviderVersion,
} from "./maintenanceResolver.ts";
const driver = (value: string) => ProviderDriverKind.make(value);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const makeTempDir = (name: string) =>
  SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.flatMap((id) =>
      Effect.acquireRelease(
        Effect.succeed(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), `${name}-${id}`)),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    ),
  );
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool",
  },
});
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("nativePackageTool"),
  driver: driver("nativePackageTool"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
}

function linkIntoPackage(tempDir: string, name: string, packageSegments: ReadonlyArray<string>) {
  const target = NodePath.join(tempDir, ...packageSegments, "bin", `${name}.js`);
  writeExecutable(target);
  const link = NodePath.join(tempDir, "bin", name);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
}

function stdoutSpawner(
  onSpawn: (command: string, args: ReadonlyArray<string>) => string,
  exitCodeOf: (args: ReadonlyArray<string>) => number = () => 0,
) {
  return lazyChildProcessSpawner((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCodeOf(args))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer).pipe(
    Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" })),
  ),
)("configured registry cache", (it) => {
  it.effect.skipIf(!symlinksSupported || windowsHost)(
    "keeps configured npm registries' latest versions apart for one install",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("goat-npm-registry-isolation");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        );
        const npmBinDir = NodePath.join(tempDir, "npm-bin");
        writeExecutable(NodePath.join(npmBinDir, "npm"));
        const binaryPath = linkIntoPackage(tempDir, "package-tool", [
          "lib",
          "node_modules",
          "@example",
          "package-tool",
        ]);
        let probes = 0;
        const latest = (registry: string, version: string) =>
          resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
            binaryPath,
            env: { PATH: npmBinDir, NPM_CONFIG_REGISTRY: registry },
          }).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              stdoutSpawner(() => {
                probes++;
                return JSON.stringify({ "@example/package-tool": { latest: version } });
              }),
            ),
            Effect.tap((capabilities) =>
              Effect.sync(() => {
                expect(capabilities.latestVersionCacheKey ?? "").not.toContain("private-token");
              }),
            ),
            Effect.flatMap(resolveLatestProviderVersion),
          );
        const first = "https://user:private-token@first.example.test";
        const second = "https://second.example.test";
        expect(yield* latest(first, "1.1.0")).toBe("1.1.0");
        expect(yield* latest(second, "2.0.0")).toBe("2.0.0");
        expect(yield* latest(first, "1.2.0")).toBe("1.1.0");
        expect(probes).toBe(2);
      }).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("configured registries must not use public npm")),
        ),
      ),
  );

  // A killed `npm view` leaves its partial packument in npm's cache tmp dir.
  it.effect.skipIf(!symlinksSupported || windowsHost)(
    "neither a refresh nor the probe timeout kills a slow npm version check or starts another download",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("goat-interrupted-npm-view");
        const npmBinDir = NodePath.join(tempDir, "npm-bin");
        writeExecutable(NodePath.join(npmBinDir, "npm"));
        const binaryPath = NodePath.join(tempDir, ".local/bin/native-package-tool");
        writeExecutable(binaryPath);
        const spawned = yield* Deferred.make<void>();
        const download = yield* Deferred.make<void>();
        let spawns = 0;
        let downloaded = false;
        let killedMidDownload = 0;
        const slowNpmView = ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawns++;
            Deferred.doneUnsafe(spawned, Effect.void);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(spawns),
              exitCode: Deferred.await(download).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Effect.succeed(true),
              kill: () =>
                Effect.sync(() => {
                  if (!downloaded) killedMidDownload++;
                }),
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.fromEffect(Deferred.await(download)).pipe(
                Stream.as('"1.2.0"'),
                Stream.encodeText,
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath, env: { PATH: "" } },
        ).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: npmBinDir }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, slowNpmView),
        );
        const check = enrichProviderSnapshotWithVersionAdvisory(
          installedPackageToolProvider,
          capabilities,
        );

        const first = yield* Effect.forkChild(check);
        yield* Deferred.await(spawned);
        // A provider refresh interrupts the enrichment still in flight.
        yield* Fiber.interrupt(first);
        const second = yield* Effect.forkChild(check);
        yield* Effect.yieldNow;
        // A slow registry outlasts the probe timeout.
        yield* TestClock.adjust("1 minute");
        downloaded = true;
        yield* Deferred.succeed(download, undefined);
        const snapshot = yield* Fiber.join(second);

        expect(snapshot.versionAdvisory?.latestVersion).toBe("1.2.0");
        expect({ spawns, killedMidDownload }).toEqual({ spawns: 1, killedMidDownload: 0 });
      }).pipe(
        Effect.provide(ProviderLatestVersions.layer),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die("a configured npm lookup must not fall back to public npm"),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "gives npm view GOAT's own lasting npm cache and drops its partial download on interrupt",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("goat-npm-view-cache");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        );
        const npmBinDir = NodePath.join(tempDir, "npm-bin");
        writeExecutable(NodePath.join(npmBinDir, "npm"));
        const binaryPath = NodePath.join(tempDir, ".local/bin/native-package-tool");
        writeExecutable(binaryPath);
        const npmCacheDir = NodePath.join(tempDir, "goat-caches", "npm");
        const cacheDirs: Array<unknown> = [];
        const viewStarted = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) => {
          const { options } = command as unknown as {
            readonly options: { readonly env: Record<string, unknown> };
          };
          const cacheDir = options.env.npm_config_cache;
          cacheDirs.push(cacheDir);
          if (typeof cacheDir === "string") {
            NodeFS.mkdirSync(NodePath.join(cacheDir, "_cacache", "tmp"), { recursive: true });
            NodeFS.writeFileSync(NodePath.join(cacheDir, "_cacache", "index"), "");
            NodeFS.writeFileSync(
              NodePath.join(cacheDir, "_cacache", "tmp", "partial-packument"),
              '{"name":"@example/native-package-tool"',
            );
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.fromEffect(Deferred.succeed(viewStarted, undefined)).pipe(
                Stream.flatMap(() => Stream.never),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          nativePackageToolUpdate,
          { binaryPath, env: { PATH: "" }, npmCacheDir },
        ).pipe(
          Effect.provideService(HostProcess.Environment, { PATH: npmBinDir }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const fiber = yield* Effect.forkChild(capabilities.lookupLatestVersion!);
        yield* Deferred.await(viewStarted);
        yield* Fiber.interrupt(fiber);
        expect(cacheDirs).toHaveLength(1);
        const cacheDir = cacheDirs[0] as string;
        expect(cacheDir.startsWith(npmCacheDir)).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(cacheDir, "_cacache", "tmp"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(cacheDir, "_cacache", "index"))).toBe(true);
      }),
  );
});
