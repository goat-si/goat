// @effect-diagnostics nodeBuiltinImport:off - Node's glob matcher is the minimatch @electron/universal applies to x64ArchFiles.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import {
  createBuildConfig,
  MacDesktopBuildPrerequisitesMissingError,
  preflightMacDesktopBuild,
} from "./build-desktop-artifact.ts";

function exitedProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// Command Line Tools' lipo rejects -version, while xcrun --find locates it and
// fails only when no developer tools are installed.
const macPreflightSpawner = (lipo: "found" | "missing" | "unspawnable") =>
  Layer.merge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const childProcess = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        const invocation = [childProcess.command, ...childProcess.args].join(" ");
        if (invocation === "xcrun --find lipo" && lipo === "unspawnable") {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: "xcrun",
            }),
          );
        }
        const fails =
          invocation === "lipo -version" ||
          (invocation === "xcrun --find lipo" && lipo === "missing");
        return Effect.succeed(exitedProcess(fails ? 1 : 0));
      }),
    ),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({ env: { GOAT_DESKTOP_REUSE_RESOURCE_MONITOR: "true" } }),
    ),
  );

it.layer(NodeServices.layer)("universal macOS desktop builds", (it) => {
  it.effect("accepts the Command Line Tools lipo", () =>
    preflightMacDesktopBuild("universal").pipe(Effect.provide(macPreflightSpawner("found"))),
  );

  it.effect("refuse to start when lipo is missing", () =>
    Effect.gen(function* () {
      for (const lipo of ["missing", "unspawnable"] as const) {
        const error = yield* preflightMacDesktopBuild("universal").pipe(
          Effect.provide(macPreflightSpawner(lipo)),
          Effect.flip,
        );

        assert.instanceOf(error, MacDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["lipo"]);
        assert.include(error.message, "Xcode universal-binary tool (lipo)");
      }
    }),
  );

  it.effect("leave single-architecture builds independent of lipo", () =>
    Effect.forEach(["arm64", "x64"] as const, (arch) =>
      preflightMacDesktopBuild(arch).pipe(Effect.provide(macPreflightSpawner("unspawnable"))),
    ),
  );

  it.effect("keep both halves of per-architecture native payloads", () =>
    Effect.gen(function* () {
      const configFor = (arch: "universal" | "arm64") =>
        createBuildConfig("mac", "zip", "1.2.3", false, false, undefined, undefined, false, arch);
      const universal = yield* configFor("universal");
      const arm64 = yield* configFor("arm64");
      const x64ArchFiles = (universal.mac as { readonly x64ArchFiles?: unknown }).x64ArchFiles;
      assert.notProperty(arm64.mac, "x64ArchFiles");
      if (typeof x64ArchFiles !== "string") {
        return assert.fail("universal builds need an x64ArchFiles rule");
      }

      const resources = "Contents/Resources";
      const unpacked = `${resources}/app.asar.unpacked/node_modules`;
      // Thin Mach-O files a universal build found byte-identical in both slices.
      const singleArchPayloads = ["arm64", "x64"].flatMap((architecture) => [
        `${unpacked}/@clerk/electron-passkeys/electron-passkeys.darwin-${architecture}.node`,
        `${unpacked}/@clerk/electron-passkeys-darwin-${architecture}/electron-passkeys.darwin-${architecture}.node`,
        `${unpacked}/@napi-rs/keyring/keyring.darwin-${architecture}.node`,
        `${unpacked}/@napi-rs/keyring-darwin-${architecture}/keyring.darwin-${architecture}.node`,
        `${unpacked}/@crowecawcaw/xa11y-darwin-${architecture}/xa11y.darwin-${architecture}.node`,
        `${unpacked}/@ff-labs/fff-bin-darwin-${architecture}/libfff_c.dylib`,
        `${unpacked}/@ubjs/node-darwin-${architecture}/uniffi-runtime-napi.darwin-${architecture}.node`,
        `${unpacked}/@yuuang/ffi-rs-darwin-${architecture}/ffi-rs.darwin-${architecture}.node`,
        `${unpacked}/node-pty/prebuilds/darwin-${architecture}/pty.node`,
        `${unpacked}/node-pty/prebuilds/darwin-${architecture}/spawn-helper`,
        `${unpacked}/objc-js/prebuilds/darwin-${architecture}/node.napi.node`,
        `${resources}/node_modules/@cursor/sdk-darwin-${architecture}/bin/rg`,
        `${resources}/node_modules/@cursor/sdk-darwin-${architecture}/vendor/tree-sitter/binding.node`,
      ]);
      for (const payload of singleArchPayloads) {
        assert.isTrue(NodePath.matchesGlob(payload, x64ArchFiles), payload);
      }
      // Binaries rebuilt or merged per slice must still reach lipo or fail loudly.
      for (const merged of [
        `${unpacked}/node-pty/build/Release/pty.node`,
        `${unpacked}/@clerk/electron-passkeys/electron-passkeys.node`,
        `${unpacked}/some-addon/build/Release/addon.node`,
        `${unpacked}/@napi-rs/keyring/keyring.linux-x64-gnu.node`,
        `${unpacked}/@clerk/electron-passkeys/electron-passkeys.win32-x64-msvc.node`,
        `${resources}/resource-monitor/goat-resource-monitor`,
        "Contents/Frameworks/Electron Framework.framework/Electron Framework",
      ]) {
        assert.isFalse(NodePath.matchesGlob(merged, x64ArchFiles), merged);
      }
    }),
  );
});
