import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@goat/provider-core/server/ProviderAdapter";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";
import { resolveLatestProviderVersion } from "@goat/provider-core/server/maintenanceResolver";

import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = lazyChildProcessSpawner(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

/** Answers every spawn with `onSpawn(command, args)` on stdout, like a stub `brew`. */
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

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect("regression #3079: status reads the current host PATH while instance PATH wins", () => {
    const host = { PATH: "/old/bin", HOME: "/tmp", XAI_API_KEY: "" };
    const paths: Array<string | undefined> = [];
    let failSpawn = false;
    const spawner = lazyChildProcessSpawner((command) => {
      if (ChildProcess.isStandardCommand(command)) paths.push(command.options.env?.PATH);
      if (failSpawn)
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: { code: "ENOENT" },
          }),
        );
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return Effect.gen(function* () {
      const make = (override: boolean) =>
        GrokDriver.create({
          instanceId: ProviderInstanceId.make(override ? "grok-override" : "grok-inherit"),
          displayName: undefined,
          enabled: true,
          environment: override
            ? [{ name: "PATH", value: "/old/bin", sensitive: false }]
            : [{ name: "TEST_VAR", value: "1", sensitive: false }],
          config: GrokDriver.defaultConfig(),
        });
      const inherited = yield* make(false);
      const overridden = yield* make(true);
      host.PATH = "/new/bin";
      yield* inherited.snapshot.refresh;
      expect(paths.at(-1)).toBe("/new/bin");
      yield* overridden.snapshot.refresh;
      expect(paths.at(-1)).toBe("/old/bin");
      failSpawn = true;
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/tmp",
      });
      const launch = (instance: typeof inherited, id: string) =>
        instance.orchestrationAdapter
          .openSession({
            threadId: ThreadId.make(id),
            providerSessionId: ProviderSessionId.make(id),
            modelSelection: { instanceId: instance.instanceId, model: "default" },
            runtimePolicy,
          })
          .pipe(Effect.result);
      paths.length = 0;
      yield* launch(inherited, "inherited-session");
      expect(paths.at(-1)).toBe("/new/bin");
      yield* launch(overridden, "overridden-session");
      expect(paths.at(-1)).toBe("/old/bin");
    }).pipe(
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.scoped,
    );
  });

  it.effect("regression #3079: maintenance follows changes to the current PATH", () => {
    const host = { PATH: "", HOME: "/tmp" };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-maintenance-path-" });
      const dirs = [path.join(root, "first"), path.join(root, "second")];
      for (const dir of dirs) {
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(path.join(dir, "grok"), "#!/bin/sh\n");
        yield* fs.chmod(path.join(dir, "grok"), 0o755);
      }
      host.PATH = dirs[0]!;
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-maintenance-path"),
        displayName: undefined,
        enabled: false,
        environment: [],
        config: GrokDriver.defaultConfig(),
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(
        path.join(dirs[0]!, "grok"),
      );
      host.PATH = dirs[1]!;
      expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(
        path.join(dirs[1]!, "grok"),
      );
    }).pipe(
      Effect.provideService(HostProcess.Environment, host),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    );
  });

  // The grok fixtures are POSIX shell scripts, which Windows command resolution rejects.
  it.effect.skipIf(windowsHost)(
    "a host PATH change while a check resolves the executable keeps that check on one install",
    () => {
      const host = { PATH: "", HOME: "/tmp" };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-maintenance-race-" });
        const dirs = [path.join(root, "first"), path.join(root, "second")];
        for (const dir of dirs) {
          yield* fs.makeDirectory(dir);
          yield* fs.writeFileString(path.join(dir, "grok"), "#!/bin/sh\n");
          yield* fs.chmod(path.join(dir, "grok"), 0o755);
        }
        host.PATH = dirs[0]!;
        const first = path.join(dirs[0]!, "grok");
        let moved = false;
        // The host moves to the second install while the check is looking at the first.
        const movingFs: FileSystem.FileSystem = {
          ...fs,
          stat: (target) => {
            if (target === first && !moved) {
              moved = true;
              host.PATH = dirs[1]!;
            }
            return fs.stat(target);
          },
        };
        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-maintenance-race"),
          displayName: undefined,
          enabled: false,
          environment: [],
          config: GrokDriver.defaultConfig(),
        }).pipe(Effect.provideService(FileSystem.FileSystem, movingFs));
        expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(first);
        expect(moved).toBe(true);
        expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(
          path.join(dirs[1]!, "grok"),
        );
      }).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      );
    },
  );

  // The grok and npm fixtures are POSIX shell scripts, which Windows command resolution rejects.
  it.effect.skipIf(windowsHost)(
    "a host registry change an instance override masks reaches the next manual install advisory",
    () => {
      const host: NodeJS.ProcessEnv = { PATH: "", HOME: "/tmp" };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "grok-masked-registry-" }),
        );
        // A cask whose brew GOAT cannot find is a manual install: npm only advises.
        const cask = path.join(root, "Caskroom", "grok", "1.0", "grok");
        yield* fs.makeDirectory(path.dirname(cask), { recursive: true });
        yield* fs.writeFileString(cask, "#!/bin/sh\n");
        yield* fs.chmod(cask, 0o755);
        const dirs = [path.join(root, "first"), path.join(root, "second")];
        for (const dir of dirs) {
          yield* fs.makeDirectory(dir);
          yield* fs.symlink(cask, path.join(dir, "grok"));
          yield* fs.writeFileString(
            path.join(dir, "npm"),
            `#!/bin/sh\ncase "$NPM_CONFIG_REGISTRY" in *y.example*) echo '"2.0.0"';; *instance*) echo '"9.0.0"';; *) echo '"1.0.0"';; esac\n`,
          );
          yield* fs.chmod(path.join(dir, "npm"), 0o755);
        }
        Object.assign(host, {
          PATH: dirs[0],
          HOME: root,
          NPM_CONFIG_REGISTRY: "https://x.example",
        });
        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-masked-registry"),
          displayName: undefined,
          enabled: false,
          environment: [
            { name: "NPM_CONFIG_REGISTRY", value: "https://instance.example", sensitive: false },
          ],
          config: GrokDriver.defaultConfig(),
        });
        const advisory = instance.snapshot
          .resolveMaintenance()
          .pipe(
            Effect.flatMap(
              (maintenance) => maintenance.lookupLatestVersion ?? Effect.succeed(null),
            ),
          );
        // A manual install's advisory reads the host registry; the instance's own one masks it.
        expect(yield* advisory).toBe("1.0.0");
        yield* TestClock.adjust("50 minutes");
        host.PATH = dirs[1];
        expect(yield* advisory).toBe("1.0.0");
        yield* TestClock.adjust("5 minutes");
        host.NPM_CONFIG_REGISTRY = "https://y.example";
        expect(yield* advisory).toBe("2.0.0");
      }).pipe(Effect.provideService(HostProcess.Environment, host), Effect.scoped);
    },
  );

  it.effect(
    "regression #3079: maintenance detects a newly installed executable in the same PATH",
    () => {
      const host = { PATH: "", HOME: "/tmp" };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-maintenance-path-" });
        const dirs = [path.join(root, "first"), path.join(root, "second")];
        for (const dir of dirs) {
          yield* fs.makeDirectory(dir);
        }
        yield* fs.writeFileString(path.join(dirs[1]!, "grok"), "#!/bin/sh\n");
        yield* fs.chmod(path.join(dirs[1]!, "grok"), 0o755);
        host.PATH = dirs.join(":");
        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-maintenance-path"),
          displayName: undefined,
          enabled: false,
          environment: [],
          config: GrokDriver.defaultConfig(),
        });
        expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(
          path.join(dirs[1]!, "grok"),
        );
        yield* fs.writeFileString(path.join(dirs[0]!, "grok"), "#!/bin/sh\n");
        yield* fs.chmod(path.join(dirs[0]!, "grok"), 0o755);
        expect((yield* instance.snapshot.resolveMaintenance()).update?.executable).toBe(
          path.join(dirs[0]!, "grok"),
        );
      }).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      );
    },
  );

  // Each case puts a stub `brew` at `<prefix>/bin/brew` beside the Grok binary.
  const homebrewCases = [
    {
      name: "upgrades a Homebrew grok-build cask through brew",
      binary: ["Caskroom", "grok-build", "1.2.3,456", "grok"],
      reportedPrefix: "own",
      brewArgs: [["--prefix"]],
      latestVersion: "1.2.4",
      update: (brewPath: string, _binaryPath: string) => ({
        command: "brew upgrade --cask grok-build",
        executable: brewPath,
        args: ["upgrade", "--cask", "grok-build"],
        lockKey: "homebrew",
      }),
    },
    {
      // `grok update` would install a second copy beside the cask.
      name: "stays manual-only for a cask another brew prefix owns",
      binary: ["Caskroom", "grok-build", "1.2.3", "grok"],
      reportedPrefix: "/opt/homebrew",
      brewArgs: [["--prefix"]],
      latestVersion: undefined,
      update: () => null,
    },
    {
      // A formula keg such as `node` holding an npm global is not Grok's owner.
      name: "keeps grok update for an npm global inside a Homebrew node keg",
      binary: [
        "Cellar",
        "node",
        "22",
        "lib",
        "node_modules",
        "@xai-official",
        "grok",
        "bin",
        "grok",
      ],
      reportedPrefix: "own",
      brewArgs: [],
      latestVersion: undefined,
      update: (_brewPath: string, binaryPath: string) => ({
        executable: binaryPath,
        args: ["update"],
        lockKey: "grok",
        // npm 12 otherwise skips the postinstall that installs the new binary.
        env: expect.objectContaining({ npm_config_allow_scripts: "@xai-official/grok" }),
      }),
    },
  ] as const;

  for (const testCase of homebrewCases) {
    it.effect.skipIf(windowsHost)(testCase.name, () => {
      const brewArgs: Array<ReadonlyArray<string>> = [];
      let prefix = "";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        prefix = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-brew-" }),
        );
        const brewPath = path.join(prefix, "bin", "brew");
        const binaryPath = path.join(prefix, ...testCase.binary);
        for (const executable of [brewPath, binaryPath]) {
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "#!/bin/sh\n");
          yield* fs.chmod(executable, 0o755);
        }

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-homebrew"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        });
        const capabilities = yield* instance.snapshot.resolveMaintenance();

        const update = testCase.update(brewPath, binaryPath);
        expect(brewArgs).toEqual(testCase.brewArgs);
        expect(capabilities.update).toEqual(update && expect.objectContaining(update));
        if (testCase.latestVersion !== undefined) {
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(testCase.latestVersion);
          expect(brewArgs).toEqual([...testCase.brewArgs, ["info", "--json=v2", "grok-build"]]);
        }
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((command, args) => {
            expect(command).toBe(`${prefix}/bin/brew`);
            brewArgs.push(args);
            if (args[0] === "--prefix") {
              return `${testCase.reportedPrefix === "own" ? prefix : testCase.reportedPrefix}\n`;
            }
            return JSON.stringify({ casks: [{ version: "1.2.4,789" }] });
          }),
        ),
        Effect.scoped,
      );
    });
  }

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect("exposes in-app API key sign-in", () =>
    Effect.gen(function* () {
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-auth"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "XAI_API_KEY", value: "", sensitive: true }],
        config: GrokDriver.defaultConfig(),
      });
      expect(instance.auth?.start).toEqual(expect.any(Function));
      expect(instance.auth?.logout).toEqual(expect.any(Function));
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.setup).toEqual({ canAuthenticate: false, canInstall: false });
      expect(snapshot.auth.canLogout).toBe(false);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
