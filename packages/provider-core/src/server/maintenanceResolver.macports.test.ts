// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  normalizeCommandPath,
  resolvePackageManagedProviderMaintenance,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
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
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer).pipe(
    Layer.merge(Layer.succeed(HostProcess.Environment, { PATH: "" })),
  ),
)("MacPorts ownership", (it) => {
  const claudeUpdate = {
    provider: driver("claudeAgent"),
    npmPackageName: "@anthropic-ai/claude-code",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isNativeTestCommandPath("/.local/bin/claude"),
    },
  };
  for (const fixture of [
    { name: "a launcher outside the prefix's bin", npm: false, alias: true, owner: "claude-code" },
    { name: "an unreadable registry", npm: true, alias: false, owner: null },
    { name: "files MacPorts does not own", npm: true, alias: false, owner: "" },
  ]) {
    it.effect.skipIf(windowsHost)(`checks MacPorts ownership for ${fixture.name}`, () =>
      Effect.gen(function* () {
        const prefix = yield* makeTempDir("goat-macports-owner");
        const port = NodePath.join(prefix, "bin", "port");
        writeExecutable(port);
        const real = fixture.npm
          ? NodePath.join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
          : NodePath.join(prefix, "share", "claude-code", "claude");
        const resolved = fixture.alias
          ? NodePath.join(prefix, ".local", "bin", "claude")
          : NodePath.join(prefix, "bin", "claude");
        writeExecutable(real);
        writeExecutable(resolved);
        const capabilities = yield* resolvePackageManagedProviderMaintenance(claudeUpdate, {
          binaryPath: resolved,
          resolvedCommandPath: resolved,
          realCommandPath: real,
          env: { PATH: "" },
          platform: "darwin",
        }).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            stdoutSpawner(
              (command, args) => {
                expect(command).toBe(port);
                expect(args).toEqual(["provides", resolved, real]);
                return [resolved, real]
                  .map((file) =>
                    fixture.owner
                      ? `${file} is provided by: ${fixture.owner}\n`
                      : `${file} is not provided by a MacPorts port.\n`,
                  )
                  .join("");
              },
              () => (fixture.owner === null ? 1 : 0),
            ),
          ),
        );
        if (fixture.owner === "") {
          expect(capabilities.update?.lockKey).toBe(`npm-global:${normalizeCommandPath(prefix)}`);
        } else {
          expect(capabilities.update).toBeNull();
          expect(capabilities.manualCommand).toBe(
            fixture.owner ? `sudo port upgrade ${fixture.owner}` : undefined,
          );
        }
      }),
    );
  }

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
