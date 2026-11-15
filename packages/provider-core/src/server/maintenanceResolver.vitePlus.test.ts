// @effect-diagnostics nodeBuiltinImport:off
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
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./maintenanceResolver.ts";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

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
  provider: ProviderDriverKind.make("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
const noSpawn = lazyChildProcessSpawner(() =>
  Effect.die("maintenance resolution should not spawn a process here"),
);
const installedPackageToolProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("packageTool"),
  driver: ProviderDriverKind.make("packageTool"),
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

function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string) {
  return lazyChildProcessSpawner((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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

// `vp env off` makes each shim run the next matching executable on PATH instead.
it.effect.each([
  {
    name: "a system_first shim (VP_HOME layout) to a later install",
    vpHome: ".vite-plus",
    setVpHome: true,
    configs: { ".vite-plus": "system_first" },
    vitePlus: false,
  },
  {
    name: "a system_first shim (XDG layout) to a later install",
    vpHome: ".local/share/vite-plus",
    setVpHome: false,
    configs: { ".config/vite-plus": "system_first" },
    vitePlus: false,
  },
  {
    name: "a managed VP_HOME shim despite a system_first XDG config",
    vpHome: ".local/share/vite-plus",
    setVpHome: true,
    configs: { ".local/share/vite-plus": "managed", ".config/vite-plus": "system_first" },
    vitePlus: true,
  },
] as const)("updates through vp only for the install the shim runs: $name", (fixture) =>
  Effect.gen(function* () {
    const tempDir = yield* makeTempDir("vite-plus-system-first");
    const vpHome = NodePath.join(tempDir, fixture.vpHome);
    for (const [dir, shimMode] of Object.entries(fixture.configs)) {
      NodeFS.mkdirSync(NodePath.join(tempDir, dir), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(tempDir, dir, "config.json"),
        JSON.stringify({ shimMode }),
      );
    }
    const shim = NodePath.join(vpHome, "bin", "package-tool");
    writeExecutable(shim);
    const otherInstall = linkIntoPackage(NodePath.join(tempDir, "npm"), "package-tool", [
      "lib",
      "node_modules",
      "@example",
      "package-tool",
    ]);

    const capabilities = yield* packageToolUpdate
      .resolve({
        binaryPath: "package-tool",
        resolvedCommandPath: shim,
        realCommandPath: NodePath.join(vpHome, "current", "bin", "vp"),
        env: {
          ...(fixture.setVpHome ? { VP_HOME: vpHome } : {}),
          PATH: [NodePath.dirname(shim), NodePath.dirname(otherInstall)].join(":"),
        },
        platform: "linux",
      })
      .pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      );

    expect(capabilities.update?.lockKey === "vite-plus-global").toBe(fixture.vitePlus);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(windowsHost)(
  "does not offer a Vite+ update npm's release-age policy will not install",
  () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("goat-release-age");
      const npmBinDir = NodePath.join(tempDir, "npm-bin");
      const npmPath = NodePath.join(npmBinDir, "npm");
      writeExecutable(npmPath);
      const vitePlusNodePath = NodePath.join(tempDir, "vite-plus-node/bin/node");
      const binaryPath = NodePath.join(tempDir, ".vite-plus/bin/package-tool");
      writeExecutable(binaryPath);
      const advise = (env: NodeJS.ProcessEnv, vitePlusPacks: string, nodeSource = "lts") =>
        resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
          binaryPath,
          env: { PATH: npmBinDir, ...env },
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            // `vp i -g` runs the npm beside Vite+'s Node; `npm view` ignores min-release-age.
            stdoutSpawner((command, args) => {
              if (command === "vp") {
                return JSON.stringify({
                  node: { source: nodeSource, bin_path: vitePlusNodePath, installed: true },
                });
              }
              if (command === npmPath) {
                return args[0] === "view" ? '"1.2.0"' : "example-package-tool-1.2.0.tgz\n";
              }
              return command === NodePath.join(NodePath.dirname(vitePlusNodePath), "npm") &&
                args[0] === "pack"
                ? `example-package-tool-${vitePlusPacks}.tgz\n`
                : "";
            }),
          ),
          Effect.flatMap((capabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(
              { ...installedPackageToolProvider, version: "1.1.0" },
              capabilities,
            ),
          ),
          Effect.map((snapshot) => snapshot.versionAdvisory),
        );

      expect(yield* advise({ npm_config_min_release_age: "7" }, "1.1.0")).toMatchObject({
        status: "current",
        currentVersion: "1.1.0",
        latestVersion: "1.1.0",
      });
      expect((yield* advise({}, "1.2.0"))?.latestVersion).toBe("1.2.0");
      // Install never uses the system Node `vp env off` reports, so this falls back to `npm view`.
      expect(
        (yield* advise(
          { npm_config_min_release_age: "7", VP_HOME: "system-first" },
          "1.1.0",
          "system PATH",
        ))?.latestVersion,
      ).toBe("1.2.0");
    }).pipe(
      Effect.scoped,
      Effect.provide(ProviderLatestVersions.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("a configured npm lookup must not fall back to public npm"),
        ),
      ),
      Effect.provide(
        NodeServices.layer.pipe(Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" }))),
      ),
    ),
);
