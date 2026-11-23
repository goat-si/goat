// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./maintenanceResolver.ts";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import { linkIntoPackage, writeExecutable } from "./maintenanceResolver.testkit.ts";
const driver = (value: string) => ProviderDriverKind.make(value);
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
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: driver("packageTool"),
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

const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
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

it.layer(NodeServices.layer)("npm batching", (it) => {
  it.effect("asks npm about every provider package installed into the same global prefix", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("goat-npm-latest-shared");
      const npmBinDir = NodePath.join(tempDir, "npm-bin");
      writeExecutable(NodePath.join(npmBinDir, "npm"));
      const binaryPath = linkIntoPackage(tempDir, "package-tool", [
        "lib",
        "node_modules",
        "@example",
        "package-tool",
      ]);
      const otherToolDir = NodePath.join(tempDir, "lib", "node_modules", "@example", "other-tool");
      NodeFS.mkdirSync(otherToolDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(otherToolDir, "package.json"), "{}");
      // Registers a second provider package; the others this file registers are not installed.
      makePackageManagedProviderMaintenanceResolver({
        provider: driver("otherTool"),
        npmPackageName: "@example/other-tool",
        nativeUpdate: null,
      });
      const spawned: Array<ReadonlyArray<string>> = [];
      const latestVersion = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath,
        env: { PATH: npmBinDir },
      }).pipe(
        Effect.flatMap(resolveLatestProviderVersion),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner(
            (_command, args) => {
              spawned.push(args);
              return JSON.stringify(
                args[0] === "outdated"
                  ? { "@example/other-tool": { current: "1.0.0", latest: "1.1.0" } }
                  : { dependencies: { "@example/package-tool": { version: "1.0.0" } } },
              );
            },
            (args) => (args[0] === "outdated" ? 1 : 0),
          ),
        ),
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make(),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("npm answers for the package")),
        ),
      );

      expect(latestVersion).toBe("1.0.0");
      expect(spawned).toEqual([
        [
          "outdated",
          "-g",
          "--prefix",
          tempDir,
          "--json",
          "@example/package-tool",
          "@example/other-tool",
        ],
        ["ls", "-g", "--prefix", tempDir, "--depth", "0", "--json", "@example/package-tool"],
      ]);
    }),
  );
  it.effect.each([
    {
      case: "the eligible release",
      outdated: { "@example/package-tool": { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" } },
      exitCode: 1,
      status: "behind_latest",
      latestVersion: "1.1.0",
    },
    {
      case: "no update during cooldown",
      outdated: {},
      exitCode: 0,
      status: "current",
      latestVersion: "1.0.0",
    },
    {
      case: "no update during cooldown beside a broken global",
      outdated: {},
      exitCode: 0,
      listExitCode: 1,
      status: "current",
      latestVersion: "1.0.0",
    },
    {
      case: "no registry version when npm cannot reach the registry",
      outdated: { error: { code: "ECONNREFUSED" } },
      exitCode: 1,
      status: "unknown",
      latestVersion: null,
    },
  ])("advertises $case for npm-global installs", (fixture) =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("goat-npm-latest");
      const npmBinDir = NodePath.join(tempDir, "npm-bin");
      const npmPath = NodePath.join(npmBinDir, "npm");
      writeExecutable(npmPath);
      const link = linkIntoPackage(tempDir, "package-tool", [
        "lib",
        "node_modules",
        "@example",
        "package-tool",
      ]);

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: link,
        env: { PATH: npmBinDir },
      }).pipe(
        // The updater's npm comes from the provider's PATH.
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner(
            (command, args) => {
              expect(command).toBe(npmPath);
              expect(args.slice(1, 4)).toEqual(["-g", "--prefix", tempDir]);
              return JSON.stringify(
                args[0] === "outdated"
                  ? fixture.outdated
                  : {
                      dependencies: { "@example/package-tool": { version: "1.0.0" } },
                    },
              );
            },
            (args) => (args[0] === "outdated" ? fixture.exitCode : (fixture.listExitCode ?? 0)),
          ),
        ),
      );

      const provider = yield* enrichProviderSnapshotWithVersionAdvisory(
        installedPackageToolProvider,
        capabilities,
      ).pipe(
        Effect.provideServiceEffect(
          ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([["@example/package-tool", "9.9.9"]]),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("the npm version is already cached")),
        ),
      );
      expect(provider.versionAdvisory).toMatchObject({
        status: fixture.status,
        currentVersion: "1.0.0",
        latestVersion: fixture.latestVersion,
        updateCommand: expect.stringMatching(/@example\/package-tool@latest$/),
      });
    }),
  );
});
