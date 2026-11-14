import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  enrichProviderSnapshotWithVersionAdvisory,
} from "./maintenanceResolver.ts";
const driver = (value: string) => ProviderDriverKind.make(value);
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const makeTempDir = (name: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4()),
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
function writeExecutable(path: string) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "#!/bin/sh\n");
  NodeFS.chmodSync(path, 0o755);
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

const bunOutdatedTable = (row: string) => [
  "|-------------------------------------------------------|",
  "| Package               | Current | Update | Latest   |",
  "|-----------------------|---------|--------|----------|",
  row,
  "|-------------------------------------------------------|",
  "Note: The * indicates that version isn't true latest due to minimum release age",
];
it.layer(
  NodeServices.layer.pipe(Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" }))),
)("bun global updates", (it) => {
  it.effect.each([
    {
      case: "the eligible release under minimumReleaseAge",
      row: "| @example/package-tool | 1.0.0   | 1.0.0  | 1.1.0 *  |",
      expected: "1.1.0",
    },
    {
      case: "no update when the installed version is the eligible release",
      row: "| @example/package-tool | 1.0.0   | 1.0.0 * | 1.0.0 * |",
      expected: "1.0.0",
    },
    {
      // bun prints only its banner both when nothing is outdated and when the registry fails.
      case: "the npm fallback when bun reports no row",
      row: null,
      expected: "1.2.0",
    },
  ])(
    "advertises $case for bun-global installs",
    (fixture) =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("goat-bun-latest");
        const bunBinDir = NodePath.join(tempDir, ".bun", "bin");
        writeExecutable(NodePath.join(bunBinDir, "bun"));
        writeExecutable(NodePath.join(bunBinDir, "package-tool"));
        const outdated = [
          "bun outdated v1.3.3 (274e01c7)",
          ...(fixture.row === null ? [] : bunOutdatedTable(fixture.row)),
          "",
        ].join("\n");

        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          packageToolUpdate,
          { binaryPath: "package-tool", env: { PATH: bunBinDir } },
        ).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner((_command, args) =>
              args[0] === "outdated"
                ? outdated
                : `${tempDir} node_modules (1)\n└── @example/package-tool@1.0.0\n`,
            ),
          ),
        );

        const provider = yield* enrichProviderSnapshotWithVersionAdvisory(
          installedPackageToolProvider,
          capabilities,
        ).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@example/package-tool", "1.2.0"]]),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("the npm version is already cached")),
          ),
        );
        expect(provider.versionAdvisory).toMatchObject({
          status: fixture.expected === "1.0.0" ? "current" : "behind_latest",
          currentVersion: "1.0.0",
          latestVersion: fixture.expected,
        });
      }),
    { skip: windowsHost },
  );
});
