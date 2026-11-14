// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  normalizeCommandPath,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
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
const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
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

it.layer(
  NodeServices.layer.pipe(Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" }))),
)("MacPorts ownership", (it) => {
  for (const fixture of [
    {
      name: "an npm-shaped package",
      definition: packageToolUpdate,
      target: ["lib", "node_modules", "@example", "package-tool", "bin", "package-tool.exe"],
    },
    {
      name: "a launcher script",
      definition: nativePackageToolUpdate,
      target: ["share", "native-package-tool", "native-package-tool"],
    },
  ]) {
    it.effect.skipIf(!symlinksSupported || windowsHost)(
      `leaves ${fixture.name} owned by MacPorts to MacPorts`,
      () =>
        Effect.gen(function* () {
          const prefix = yield* makeTempDir("goat-macports");
          writeExecutable(NodePath.join(prefix, "bin", "port"));
          const target = NodePath.join(prefix, ...fixture.target);
          writeExecutable(target);
          const launcher = NodePath.join(prefix, "bin", NodePath.basename(target, ".exe"));
          NodeFS.symlinkSync(target, launcher);

          const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
            fixture.definition,
            { binaryPath: launcher, env: { PATH: NodePath.join(prefix, "bin") } },
          ).pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              stdoutSpawner((command, args) =>
                NodePath.basename(command) === "port" && args.includes("provides")
                  ? args.includes("-q")
                    ? "package-tool\n"
                    : args
                        .filter((arg) => arg.startsWith("/"))
                        .map((file) => `${file} is provided by: package-tool\n`)
                        .join("")
                  : "",
              ),
            ),
          );

          expect(capabilities.update).toBeNull();
          expect(capabilities.manualCommand).toBe("sudo port upgrade package-tool");
        }),
    );
  }
});
