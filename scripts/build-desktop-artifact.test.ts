// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createPackageWithOptions, extractFile, listPackage, statFile } from "@electron/asar";
import { vi } from "vite-plus/test";
import * as CuaRelease from "@goat/shared/cuaDriverRelease";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  buildDesktopBundles,
  DesktopBuildManifestRestoreError,
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  UnsupportedDesktopBuildArchitectureError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  stageWindowsServerSidecar,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveMacPasskeySigningConfiguration,
  resolveMergedStageDependencies,
  resolveBuildOptions,
  stageWslRuntimeArchive,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  stageBrowserSecret,
  validateWindowsPackagedPayload,
  verifyPackagedBundleIsSelfContained,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  stageCursorSdkPlatformPackages,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  wslRuntimeArchiveStem,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_EXTRA_RESOURCES,
  LINUX_CAPTURE_EXTRA_RESOURCES,
  LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
  LINUX_FILE_EXCLUSIONS,
  MAC_FILE_EXCLUSIONS,
  resolveOptionalMacPasskeySigningConfiguration,
  resolveDesktopProductName,
  resolveResourceMonitorRustTargets,
  resolveVp,
  VpNotFoundError,
  resourceMonitorExecutableName,
  stageResourceMonitor,
  stageSshRuntimeArchives,
  validateSshRuntimeArchives,
  validatePackagedSshRuntimeArchives,
  SSH_RUNTIME_PLATFORM_KEYS,
  SSH_RUNTIME_EXTRA_RESOURCES,
  SSH_RUNTIME_RESOURCE_SOURCE_DIR,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WSL_RUNTIME_EXTRA_RESOURCES,
  parseServerVersionOutput,
  resolveDesktopBuildVersion,
  sandboxedPreloadSyntaxError,
  stampReleaseVersionForBuild,
} from "./build-desktop-artifact.ts";
import { stageCuaDriverExecutable } from "./desktop-artifact-computer-use.ts";
import {
  ReleasePackageManifestError,
  releasePackageFiles,
} from "./update-release-package-versions.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

const stageWindowsSshRuntimeFixture = Effect.fn("test.stageWindowsSshRuntimeFixture")(function* (
  packagedAppDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const source = path.join(root, "source");
  yield* fs.makeDirectory(source);
  for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
    const stem = `goat-${WINDOWS_PAYLOAD_FIXTURE_VERSION}-${key}`;
    const archive = yield* makeLinuxCliArchiveFixture({
      root: path.join(root, key),
      stem,
      extraMembers: [`${stem}/resource-monitor/${key}/goat-resource-monitor`],
    });
    yield* fs.copyFile(archive, path.join(source, stem + ".tar.gz"));
  }
  const destination = path.join(packagedAppDir, "resources", "ssh-runtime", "archives");
  yield* stageSshRuntimeArchives({
    sourceDirectory: source,
    destinationDirectory: destination,
    version: WINDOWS_PAYLOAD_FIXTURE_VERSION,
    requireAll: true,
  });
  assert.equal((yield* fs.readDirectory(destination)).length, 6);
});

const encodeModuleUrl = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/goat`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archivePath = path.join(input.root, `${input.stem}.tar.gz`);
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return archivePath;
});

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// USTAR/gzip and DEFLATE/ZIP archives; each file contains its own name.
const cuaArchives = {
  mac: "H4sIAAAAAAAC/+3YwWqDMBwGcB+lL1D5GzNzHluhheGK9bJTcCYwWW0h6qBv37RljOWyk2nIvt8lGoQcvnxKbKdmqUz3pU0yG7IKzq+j5Y5EGfu5vs4LwViyoMSDaRgbY5dM/qfWQ/4Qdv7tZIajWY4futd36T+j3/3PMuI5+h9L/hCuffdut4C8fQLkoD5TdbJznvsvnP4zbh9H/yPJH4J+/3+HfzgqLc10GLtep5cbb/3PudP//IHQ/2jyh3C9bJ5W5W416xp/9p+c7z8Vggv0P5b8IVz1elM9y+1jVb/J8rW2u2GX9sr3+b9wz/854f9fNPkDAAAAAAAAAMD9nAFB4t6zACgAAA==",
  linux:
    "H4sIAAAAAAAC/+3az06DMAAGcB5lLzBWKC1XF0fiEp1m28UT6UYTUP4YCk7f3k7jYTVxF2FQv9+Fcerh69dSxkG856JMpqnMX2Q9c7pAtJCxz6tmXn/+9gjnnjNhTg9a1YhaD+/8T4fT/A9ZWct9o672rZhdLn9KPYL8+6BzniZ19irr7sY4m7/nG3MhDH3mTAjytyJ/GHb++7ZWVT1tUlnIi/TfN9d/jwQc/bclfxiuPNvpKRB/bQGxSp5dVfXf/8Dsf8h99N+W/GHQ6/93+GWVyLhuyyYrpHu86a3/1Ow/ZSRE/23JH0aRv9hlbjqY53/035r8YbiM979ZqeuQ565K++w/9Yz++5wT9N+W/GE0+Z/8/1PIRiSiEe6Tqsou+8/M/jOc/y3KH8aZv3xrZKmyqtQToNP9n5nP/wz7v0X5w2jyX0fzxV3kFkmv539q9t/3aID+25I/DNft8jpabaJOxziWmgfBL99/hcb3PzzE+z978ofh2t4s14v4Yb7ePsar+62eDZs/X/3P9t/n5vt/SnD+tyZ/AAAAAAAAAAAAAAAAAAAAAOjOB0iDKKUAUAAA",
  win: "UEsDBBQAAAAIAAAAIVxkdYIxEAAAAA4AAAAOAAAAY3VhLWRyaXZlci5leGVLLk3UTSnKLEst0kutSAUAUEsDBBQAAAAIAAAAIVw8tMWfFAAAABIAAAASAAAAY3VhLWRyaXZlci11aWEuZXhlSy5N1E0pyixLLdItzUzUS61IBQBQSwMEFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAABjdWEtY3Vyc29yLXRoZW1lLmV4ZUsuTdRNLi0qzi/SLclIzU3VS61IBQBQSwMEFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAABjdWFfZHJpdmVyX3Nkay5kbGxLLk2MTynKLEstii9OydZLyckBAFBLAwQUAAAACAAAACFcx8Y50BsAAAAcAAAAHAAAAGN1YV9kcml2ZXJfbm9kZV9ydW50aW1lLm5vZGVLLk2MTynKLEstis/LT0mNLyrNK8nMTdUDcQBQSwMEFAAAAAAAAAAhXAMKLWgHAAAABwAAAAcAAABMSUNFTlNFTElDRU5TRVBLAwQUAAAAAAAAACFcFmosixYAAAAWAAAAFgAAAFRISVJEX1BBUlRZX05PVElDRVMubWRUSElSRF9QQVJUWV9OT1RJQ0VTLm1kUEsBAhQDFAAAAAgAAAAhXGR1gjEQAAAADgAAAA4AAAAAAAAAAAAAAO2BAAAAAGN1YS1kcml2ZXIuZXhlUEsBAhQDFAAAAAgAAAAhXDy0xZ8UAAAAEgAAABIAAAAAAAAAAAAAAO2BPAAAAGN1YS1kcml2ZXItdWlhLmV4ZVBLAQIUAxQAAAAIAAAAIVyXVkbUFgAAABQAAAAUAAAAAAAAAAAAAADtgYAAAABjdWEtY3Vyc29yLXRoZW1lLmV4ZVBLAQIUAxQAAAAIAAAAIVxvciQcFAAAABIAAAASAAAAAAAAAAAAAADtgcgAAABjdWFfZHJpdmVyX3Nkay5kbGxQSwECFAMUAAAACAAAACFcx8Y50BsAAAAcAAAAHAAAAAAAAAAAAAAA7YEMAQAAY3VhX2RyaXZlcl9ub2RlX3J1bnRpbWUubm9kZVBLAQIUAxQAAAAAAAAAIVwDCi1oBwAAAAcAAAAHAAAAAAAAAAAAAACkgWEBAABMSUNFTlNFUEsBAhQDFAAAAAAAAAAhXBZqLIsWAAAAFgAAABYAAAAAAAAAAAAAAKSBjQEAAFRISVJEX1BBUlRZX05PVElDRVMubWRQSwUGAAAAAAcABwDBAQAA1wEAAAAA",
};
const makeCuaStageFixture = Effect.fn("test.makeCuaStageFixture")(function* (
  platform: "mac" | "linux" | "win",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cua-package-" });
  const resolveRelease = CuaRelease.cuaDriverRelease;
  const pinned = resolveRelease(
    platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux",
    "x64",
  );
  assert.isNotNull(pinned);
  const archive = Buffer.from(cuaArchives[platform], "base64");
  const release = {
    ...pinned!,
    bytes: archive.byteLength,
    sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
  };
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(CuaRelease, "cuaDriverRelease").mockImplementation((target, arch) => {
        const asset = resolveRelease(target, arch);
        assert.isNotNull(asset);
        assert.equal(asset!.archiveName, release.archiveName);
        return release;
      }),
    ),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
  const cacheDir = path.join(root, "node_modules/.cache/goat/cua-driver");
  const archivePath = path.join(cacheDir, release.archiveName);
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  let download = archive;
  let requests = 0;
  const downloadSpawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || command.command !== "curl") {
      return spawner.spawn(command);
    }
    const output = command.args[command.args.indexOf("--output") + 1];
    assert.isString(output);
    requests++;
    return fs.writeFile(output!, download).pipe(Effect.as(mockProcess(0)));
  });
  const stage = (name: string) => {
    const stageRoot = path.join(root, name);
    const stageResourcesDir = path.join(stageRoot, "resources");
    return stageCuaDriverExecutable({
      platform,
      arch: platform === "mac" ? "universal" : "x64",
      repoRoot: root,
      stageRoot,
      stageResourcesDir,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, downloadSpawner),
      Effect.as(stageResourcesDir),
    );
  };
  return {
    fs,
    path,
    root,
    archive,
    archivePath,
    cacheDir,
    stage,
    requests: () => requests,
    respondWith: (bytes: Buffer, expectedBytes = archive.byteLength) => {
      download = Buffer.from(bytes);
      release.bytes = expectedBytes;
    },
  };
});

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly wslRuntime?: "valid" | "loose-server-tree" | "missing-pty" | "bad-digest";
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "goat-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/goat-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem: "apps",
            omitMembers: ["apps/goat", "apps/client/index.html"],
            extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
          })
        : yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem,
            ...(input.wslRuntime === "missing-pty" || input.ptyPrebuildArch !== undefined
              ? { omitMembers: [`${stem}/node_modules/node-pty/build/Release/pty.node`] }
              : {}),
            ...(input.ptyPrebuildArch !== undefined
              ? {
                  extraMembers: [
                    `${stem}/node_modules/node-pty/prebuilds/linux-${input.ptyPrebuildArch}/pty.node`,
                  ],
                }
              : {}),
          });
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });
    if (input.wslRuntime === "bad-digest") {
      yield* fs.writeFileString(hashPath, `${"0".repeat(64)}\n`);
    }
  }

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect(
    "Cua release cache rejects bad bytes and hashes, redownloads corruption, and reuses verified bytes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeCuaStageFixture("linux");
        const wrongHash = Buffer.from(h.archive);
        wrongHash.writeUInt8(wrongHash.readUInt8(wrongHash.length - 1) ^ 1, wrongHash.length - 1);
        for (const [index, [bytes, expectedBytes]] of (
          [
            [h.archive, h.archive.length + 1],
            [h.archive, h.archive.length - 1],
            [wrongHash, h.archive.length],
          ] as const
        ).entries()) {
          h.respondWith(bytes, expectedBytes);
          yield* Effect.flip(h.stage(`rejected-${index}`));
          assert.deepStrictEqual(yield* h.fs.readDirectory(h.cacheDir), []);
          assert.isFalse(
            yield* h.fs.exists(h.path.join(h.root, `rejected-${index}/resources/cua-driver`)),
          );
        }
        h.respondWith(h.archive);
        yield* h.fs.writeFile(h.archivePath, wrongHash);
        const resources = yield* h.stage("repaired");
        assert.equal(h.requests(), 4);
        assert.deepStrictEqual(Buffer.from(yield* h.fs.readFile(h.archivePath)), h.archive);
        assert.equal(
          yield* h.fs.readFileString(h.path.join(resources, "cua-driver/cua-driver")),
          "cua-driver",
        );
        yield* h.stage("cached");
        assert.equal(h.requests(), 4);
        assert.deepStrictEqual(yield* h.fs.readDirectory(h.cacheDir), [
          h.path.basename(h.archivePath),
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("mac staging omits the in-process Cua executable (#1202)", () =>
    Effect.gen(function* () {
      const h = yield* makeCuaStageFixture("mac");
      const resources = yield* h.stage("release");
      assert.isFalse(yield* h.fs.exists(h.path.join(resources, "cua-driver")));
      assert.equal(h.requests(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["linux", "win"] as const)(
    "stages the Cua %s compressed release at the desktop host path",
    (platform) =>
      Effect.gen(function* () {
        const h = yield* makeCuaStageFixture(platform);
        yield* h.fs.writeFile(h.archivePath, h.archive);
        const resources = yield* h.stage("release");
        const destination = h.path.join(resources, "cua-driver");
        assert.equal(h.requests(), 0);
        const companions =
          platform === "win"
            ? ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"]
            : [
                "cua-driver",
                "cua-cursor-theme",
                "wayland-helper/README.md",
                "wayland-helper/install.sh",
                "wayland-helper/winrects@cua/metadata.json",
                "wayland-helper/winrects@cua/extension.js",
              ];
        assert.deepStrictEqual(
          (yield* h.fs.readDirectory(destination)).sort(),
          platform === "win"
            ? [...companions].sort()
            : ["cua-cursor-theme", "cua-driver", "wayland-helper"],
        );
        for (const member of companions) {
          assert.equal(yield* h.fs.readFileString(h.path.join(destination, member)), member);
        }
        if ((yield* HostProcess.Platform) !== "win32" && platform !== "win") {
          const executables = [
            h.path.join(destination, "cua-driver"),
            h.path.join(destination, "cua-cursor-theme"),
          ];
          for (const executable of executables) {
            assert.equal((yield* h.fs.stat(executable)).mode & 0o777, 0o755);
          }
        }
      }).pipe(Effect.scoped),
  );

  it.effect("Cua Windows SDK and driver fit the packaged 80 loose-file budget", () =>
    Effect.gen(function* () {
      const h = yield* makeCuaStageFixture("win");
      const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
      const resources = h.path.join(fixture.packagedAppDir, "resources");
      const natives = [
        "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
        "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_node_runtime.node",
        "node_modules/@ubjs/node-win32-x64-msvc/uniffi-runtime-napi.win32-x64-msvc.node",
      ];
      const javascript = Array.from(
        { length: 81 },
        (_, index) => `node_modules/@trycua/cua-driver/dist/native/module-${index}.js`,
      );
      for (const file of [...natives, ...javascript]) {
        const target = h.path.join(fixture.sourceDir, file);
        yield* h.fs.makeDirectory(h.path.dirname(target), { recursive: true });
        yield* h.fs.writeFileString(
          target,
          file.endsWith(".js") ? "export {};" : "MZ native fixture",
        );
      }
      const asarPath = h.path.join(resources, WINDOWS_SERVER_ASAR_RESOURCE);
      yield* packWindowsServerAsar({ sourceDir: fixture.sourceDir, asarPath, arch: "x64" });
      const config = yield* createBuildConfig(
        "win",
        "dir",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      assert.deepStrictEqual(config.asar, { smartUnpack: false });
      const globs = config.asarUnpack as string[];
      yield* Effect.promise(() =>
        createPackageWithOptions(fixture.sourceDir, h.path.join(resources, "app.asar"), {
          unpack: globs.length === 1 ? globs[0]! : `{${globs.join(",")}}`,
        }),
      );
      yield* h.fs.writeFile(h.archivePath, h.archive);
      const staged = yield* h.stage("driver");
      yield* h.fs.copy(h.path.join(staged, "cua-driver"), h.path.join(resources, "cua-driver"));
      const result = yield* validateWindowsPackagedPayload({
        stageDistDir: fixture.stageDistDir,
        appExecutableName: fixture.appExecutableName,
        targetArch: "x64",
        appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
      }).pipe(Effect.provideService(HostProcess.Platform, "linux"));
      assert.equal(WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT, 80);
      assert.isAtMost(result.fileCount, 80);
      assert.includeMembers(result.unpackedFiles, natives);
      for (const file of javascript) {
        assert.equal(extractFile(asarPath, h.path.normalize(file)).toString(), "export {};");
        assert.isNotTrue(statFile(asarPath, h.path.normalize(file)).unpacked);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects overlapping builds from another process until restoration finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-concurrent-build-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        '{ "scripts": { "build:desktop": "node build.cjs" } }',
      );
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      yield* fs.writeFileString(
        path.join(root, "build.cjs"),
        `require("node:fs").writeFileSync("version.txt", require("./apps/server/package.json").version);`,
      );
      const restoring = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const contenderPath = path.join(root, "contender.mjs");
      yield* fs.writeFileString(
        contenderPath,
        `import * as Effect from ${yield* encodeModuleUrl(import.meta.resolve("effect/Effect"))};
           import * as NodeServices from ${yield* encodeModuleUrl(import.meta.resolve("@effect/platform-node/NodeServices"))};
           import { buildDesktopBundles } from ${yield* encodeModuleUrl(import.meta.resolve("./build-desktop-artifact.ts"))};
           const result = await Effect.runPromise(buildDesktopBundles(process.argv[2], "0.0.44", false).pipe(
             Effect.as("success"), Effect.catch(error => Effect.succeed(error._tag)),
             Effect.scoped, Effect.provide(NodeServices.layer)));
           process.stdout.write(result);`,
      );
      const first = yield* Effect.forkChild(
        Effect.exit(buildDesktopBundles(root, "0.0.43", false)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (filePath, contents, options) =>
              filePath === path.join(root, releasePackageFiles[0]) && contents === original
                ? Deferred.succeed(restoring, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.writeFileString(filePath, contents, options)),
                  )
                : fs.writeFileString(filePath, contents, options),
          }),
        ),
      );
      yield* Deferred.await(restoring);
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [contenderPath, root]),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(Number(exitCode), 0, stderr);
        assert.equal(stdout, "DesktopBuildAlreadyRunningError");
      }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      const firstExit = yield* Fiber.join(first);
      assert.isTrue(Exit.isSuccess(firstExit));
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.43");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false);
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.44");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("restores manifests and releases the checkout lock after interruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-interrupted-build-" });
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const started = yield* Deferred.make<void>();
      const childStopped = yield* Deferred.make<{ lockExists: boolean; version: string }>();
      const build = yield* Effect.forkChild(
        buildDesktopBundles(root, "0.0.43", false).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(
                Effect.succeed({ ...mockProcess(0), exitCode: Effect.never }).pipe(
                  Effect.tap(() => Deferred.succeed(started, undefined)),
                ),
                () =>
                  Effect.gen(function* () {
                    const lockExists = yield* fs.exists(path.join(root, ".desktop-build.lock"));
                    const manifest = yield* decodePackageVersion(
                      yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
                    );
                    yield* Deferred.succeed(childStopped, {
                      lockExists,
                      version: manifest.version,
                    });
                  }).pipe(Effect.orDie),
              ),
            ),
          ),
          Effect.scoped,
        ),
      );
      yield* Deferred.await(started);
      const aligned = yield* decodePackageVersion(
        yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
      );
      assert.equal(aligned.version, "0.0.43");
      yield* Fiber.interrupt(build);
      assert.deepEqual(yield* Deferred.await(childStopped), {
        lockExists: true,
        version: "0.0.43",
      });
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
        ),
      );
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
    }),
  );

  it.effect(
    "builds web, server and desktop with the resolved version, restores changed manifests and preserves edits to matching ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-desktop-build-version-" });
        const packageJson = `{
          "name": "desktop-version-fixture",
          "version": "0.0.42",
          "scripts": { "build:desktop": "node build.cjs" }
        }`;
        yield* fs.writeFileString(path.join(root, "package.json"), packageJson);
        const version = "0.0.43-nightly.20260920.2018";
        const matchingPath = "packages/contracts/package.json";
        const originals = releasePackageFiles.map((relativePath, index) => ({
          relativePath,
          contents: `{ "version": "${relativePath === matchingPath ? version : `0.0.${index + 1}`}", "name": "${relativePath}" }\r\n`,
        }));
        const afterBuild = originals.map(({ relativePath, contents }) => ({
          relativePath,
          contents:
            relativePath === matchingPath
              ? `${JSON.stringify({ version, name: matchingPath, description: "edited during compilation" })}\n`
              : contents,
        }));
        for (const { relativePath, contents } of originals) {
          const filePath = path.join(root, relativePath);
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          `require("node:fs").writeFileSync("version.txt", [
            process.env.APP_VERSION,
            require("./apps/web/package.json").version,
            require("./apps/server/package.json").version,
            require("./apps/desktop/package.json").version
          ].join("\\n"));
          const manifest = require("./${matchingPath}");
          manifest.description = "edited during compilation";
          require("node:fs").writeFileSync("${matchingPath}", JSON.stringify(manifest) + "\\n");`,
        );
        yield* buildDesktopBundles(root, version, false);
        assert.equal(
          yield* fs.readFileString(path.join(root, "version.txt")),
          [version, version, version, version].join("\n"),
        );
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
        yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(1);");
        const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(failure, BuildCommandFailedError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        const invalidPath = releasePackageFiles[releasePackageFiles.length - 1]!;
        yield* fs.writeFileString(path.join(root, invalidPath), "invalid manifest");
        // A successful child would leave a marker if partial alignment accidentally starts it.
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          'require("node:fs").writeFileSync("unexpected-build.txt", "started");',
        );
        const alignmentFailure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(alignmentFailure, ReleasePackageManifestError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(
            yield* fs.readFileString(path.join(root, relativePath)),
            relativePath === invalidPath ? "invalid manifest" : contents,
          );
        }
        assert.isFalse(yield* fs.exists(path.join(root, "unexpected-build.txt")));
        assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
      }),
  );

  it.effect("reports a restore failure while still restoring the remaining manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-manifest-restore-failure-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        `{
          "name": "restore-fixture", "scripts": { "build:desktop": "node build.cjs" }
        }`,
      );
      yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(0);");
      const original = '{ "version": "0.0.42" }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const failedPath = path.join(root, releasePackageFiles[0]);
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: failedPath,
      });
      const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.43", false)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, contents, options) =>
            filePath === failedPath && contents === original
              ? Effect.fail(writeFailure)
              : fs.writeFileString(filePath, contents, options),
        }),
      );
      assert.instanceOf(failure, DesktopBuildManifestRestoreError);
      assert.notEqual(yield* fs.readFileString(failedPath), original);
      for (const relativePath of releasePackageFiles.slice(1)) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );
      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      const previewChannel = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.41-preview.20260912.1589",
        false,
        false,
        undefined,
        undefined,
      );

      assert.isNull(preview.publish);
      assert.isNull(previewChannel.publish);
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "goat-si",
          repo: "goat-releases",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
              GOAT_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat-releases",
            },
          }),
        ),
      ),
    ),
  );

  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1]?.replace(/\(patch_hash=[a-f0-9]+\)$/, "");
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = symlinksSupported
          ? path.join(root, "store/@cursor")
          : path.join(nodeModules, "@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
          yield* fs.symlink(
            path.join(cursorDirectory, "sdk"),
            path.join(nodeModules, "@cursor/sdk"),
          );
        }
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
          "sdk-win32-x64/bin/rg.exe",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
          assert.isTrue(
            WINDOWS_SERVER_ASAR_IGNORE_GLOBS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob),
            ),
          );
        }
      }),
    ),
  );

  it.effect("stages Windows sidecar externals and unpacks target natives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-x64/pty.node",
          "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        ];

        const decodeDependencies = Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
          ),
        );
        const installSpawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const { dependencies } = yield* decodeDependencies(
              yield* fs.readFileString(path.join(sourceDir, "package.json")),
            ).pipe(Effect.orDie);
            const installedFiles = Object.keys(dependencies).map(
              (name) => `node_modules/${name}/package.json`,
            );
            if (Object.hasOwn(dependencies, "node-pty")) installedFiles.push(...nativeFiles);
            if (Object.hasOwn(dependencies, "@trycua/cua-driver")) {
              installedFiles.push(
                "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
              );
            }
            for (const file of installedFiles) {
              const filePath = path.join(sourceDir, file);
              yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
              yield* fs.writeFileString(filePath, file.includes("linux") ? "\x7fELF" : "MZ");
            }
            return mockProcess(0);
          }),
        );
        const serverDistDir = path.join(tempDir, "dist");
        yield* fs.makeDirectory(serverDistDir);
        yield* fs.writeFileString(path.join(serverDistDir, "bin.mjs"), "console.log('server');");
        const asarPath = path.join(tempDir, "server.asar");
        yield* stageWindowsServerSidecar({
          stageRoot: tempDir,
          repoRoot: tempDir,
          serverDistDir,
          arch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          runtimeExternalDependencies: { "node-pty": "1.1.0", "@trycua/cua-driver": "0.34.1" },
          fffNodeVersion: "0.9.4",
          allowBuilds: {},
          patchedDependencies: {},
          overrides: {},
          asarPath,
          verbose: false,
          vp: "vp",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, installSpawner));
        const unpackedRoot = `${asarPath}.unpacked`;
        assert.deepStrictEqual(
          (yield* decodeDependencies(extractFile(asarPath, "package.json").toString()))
            .dependencies,
          { "node-pty": "1.1.0", "@ff-labs/fff-bin-win32-x64": "0.9.4" },
        );
        assert.isFalse(
          listPackage(asarPath, { isPack: false }).some((file) => file.includes("@trycua")),
        );

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isTrue(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
          ),
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64")),
        );
        assert.equal(
          extractFile(
            asarPath,
            path.join("node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node"),
          ).toString(),
          "\x7fELF",
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing Windows toolchain capabilities before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            const fails =
              childProcess.command === "rustc" ||
              childProcess.command === "powershell.exe" ||
              childProcess.command === "tar.exe" ||
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { npm_config_python: pythonPath } }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc", "tar"]);
        assert.equal(error.rustTarget, "x86_64-pc-windows-msvc");
        assert.include(error.message, "Visual Studio Build Tools components");
      }),
    ),
  );

  it.effect("does not require MSVC when reusing a prebuilt Windows resource monitor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const commands: string[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            commands.push(childProcess.command);
            return Effect.succeed(mockProcess(childProcess.command === "powershell.exe" ? 1 : 0));
          }),
        );

        yield* preflightWindowsDesktopBuild({
          arch: "x64",
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    npm_config_python: pythonPath,
                    GOAT_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
                  },
                }),
              ),
            ),
          ),
        );

        assert.notInclude(commands, "powershell.exe");
      }),
    ),
  );

  it.effect("rejects a PATH-discovered Python executable that is not Python 3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-python2-preflight-" });
        const pythonPath = path.join(tempDir, "python");
        yield* fs.writeFileString(pythonPath, "python2");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "python") {
              return Effect.succeed(mockProcess(0, `${pythonPath}\n`));
            }
            if (childProcess.command === pythonPath) {
              return Effect.succeed(mockProcess(1));
            }
            return Effect.succeed(mockProcess(0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { GOAT_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["python"]);
      }),
    ),
  );

  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const beforeBundle = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });
        yield* stageWindowsSshRuntimeFixture(fixture.packagedAppDir);
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        });
        assert.equal(result.fileCount, beforeBundle.fileCount + 6);
        yield* validatePackagedSshRuntimeArchives({
          stageDistDir: fixture.stageDistDir,
          version: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          requireAll: true,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "accepts an embedded archive with the Linux %s node-pty prebuild",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch,
          });
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });

          assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "rejects a node-pty prebuild for the wrong architecture in a Linux %s archive",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch === "x64" ? "arm64" : "x64",
          });
          const error = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          }).pipe(Effect.flip);

          assert.instanceOf(error, WindowsPackagedPayloadValidationError);
          assert.equal(error.reason, "wsl-runtime-invalid");
        }),
      ),
  );

  it.effect("rejects an embedded archive built for a different release version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: "9.9.9",
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("rejects a Windows package missing its expected WSL runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-missing");
      }),
    ),
  );

  it.effect("rejects an embedded archive without the Linux node-pty binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "missing-pty",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/build/Release/pty.node`,
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/prebuilds/linux-x64/pty.node`,
        ]);
      }),
    ),
  );

  it.effect("rejects an emitted WSL archive whose sidecar digest does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "bad-digest",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
        ),
      ),
    );
  });

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly options: {
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some(
            (command) =>
              command.command === path.join(fixture.packagedAppDir, fixture.appExecutableName),
          ),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath && command.options.env?.NODE_PATH === "",
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/goat-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/goat-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        yield* stageWindowsSshRuntimeFixture(fixture.packagedAppDir);
        const validate = () =>
          validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch: "x64",
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });
        const initial = yield* validate();
        assert.equal(WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT, 80);
        for (let count = initial.fileCount; count < 80; count++) {
          yield* fs.writeFileString(
            path.join(fixture.packagedAppDir, `padding-${count}`),
            "fixture",
          );
        }
        assert.equal((yield* validate()).fileCount, 80);
        yield* fs.writeFileString(
          path.join(fixture.packagedAppDir, "one-file-over-budget"),
          "fixture",
        );
        const error = yield* validate().pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.equal(error.fileCount, 81);
        assert.equal(error.fileLimit, 80);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "goat-deliberately-missing-package";\n',
        });
        const error = yield* verifyPackagedBundleIsSelfContained({
          asarPath: path.join(fixture.packagedAppDir, "resources", WINDOWS_SERVER_ASAR_RESOURCE),
          verbose: false,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "goat-deliberately-missing-package");
      }),
    ),
  );

  it.effect("leaves the bundle self-check of a cross-built payload to the verify job", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "goat-deliberately-missing-package";\n',
        });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      GOAT_APPLE_TEAM_ID: "abc1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      GOAT_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "si.goat.desktop",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      GOAT_APPLE_TEAM_ID: "ABC1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      GOAT_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.si.goat.desktop</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.match(entitlements, /<key>com\.apple\.security\.device\.camera<\/key>\s*<true\/>/u);
    assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/u);
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.t3tools.t3code", teamId: "ABC1234567" };
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["clerk.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.com\.t3tools\.t3code\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      GOAT_APPLE_TEAM_ID: "ABC1234567",
      GOAT_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "GOAT_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      GOAT_APPLE_TEAM_ID: "ABC1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      GOAT_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          GOAT_APPLE_TEAM_ID: "ABC1234567",
          GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          GOAT_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      GOAT_APPLE_TEAM_ID: "ABC1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      GOAT_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "GOAT_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("signs Windows builds with signtool on Windows and the jsign hook elsewhere", () =>
    Effect.gen(function* () {
      const signedWinConfig = (hostPlatform: string) =>
        createBuildConfig("win", "nsis", "1.2.3", true, false, undefined, undefined).pipe(
          Effect.map((config) => config.win as Record<string, unknown>),
          Effect.provideService(HostProcess.Platform, hostPlatform),
        );

      const onWindows = yield* signedWinConfig("win32");
      assert.equal((onWindows.azureSignOptions as Record<string, unknown>).publisherName, "T3");
      assert.notProperty(onWindows, "signtoolOptions");

      const onLinux = yield* signedWinConfig("linux");
      assert.notProperty(onLinux, "azureSignOptions");
      const signtoolOptions = onLinux.signtoolOptions as Record<string, unknown>;
      assert.match(signtoolOptions.sign as string, /scripts[\\/]lib[\\/]windows-jsign\.ts$/);
      assert.deepStrictEqual(signtoolOptions.signingHashAlgorithms, ["sha256"]);
      assert.deepStrictEqual(signtoolOptions.publisherName, ["T3"]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "T3",
              AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
            },
          }),
        ),
      ),
    ),
  );

  it("parses Windows bsdtar member listings with CRLF line endings", () => {
    assert.deepStrictEqual(
      parseWslRuntimeArchiveMembers(
        "./goat-1.2.3-linux-x64/goat\r\ngoat-1.2.3-linux-x64/client/\r\n",
      ),
      ["goat-1.2.3-linux-x64/goat", "goat-1.2.3-linux-x64/client"],
    );
  });

  it.effect("stages the Linux CLI archive verbatim with its SHA-256 sidecar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-wsl-runtime-stage-" });
        const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
          root,
          stem: "goat-1.2.3-linux-x64",
        });
        const stageAppDir = path.join(root, "app");
        const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
        const hashPath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from);

        yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });

        const [source, staged] = yield* Effect.all([
          fs.readFile(sourceArchivePath),
          fs.readFile(archivePath),
        ]);
        assert.deepStrictEqual(staged, source);
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
            sshRuntimeArchiveDir: Option.none(),
            requireAllSshRuntimes: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
        sshRuntimeArchiveDir: Option.none(),
        requireAllSshRuntimes: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GOAT_DESKTOP_SKIP_BUILD: "true",
                GOAT_DESKTOP_KEEP_STAGE: "true",
                GOAT_DESKTOP_SIGNED: "true",
                GOAT_DESKTOP_VERBOSE: "true",
                GOAT_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );

  it.effect("disables feeds for local builds and unrelated repositories", () =>
    Effect.gen(function* () {
      for (const env of [
        {
          GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
          GITHUB_REPOSITORY: "goat-si/goat",
          GOAT_DESKTOP_UPDATE_REPOSITORY: "",
        },
        {
          GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
          GITHUB_REPOSITORY: "goat-si/goat",
          GOAT_DESKTOP_UPDATE_REPOSITORY: "  ",
        },
        {},
        { GITHUB_REPOSITORY: "pingdotgg/t3code" },
        { GITHUB_REPOSITORY: "goat-si/goat" },
        { GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true", GITHUB_REPOSITORY: "goat-si/goat" },
        { GOAT_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat" },
        { GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true", GITHUB_REPOSITORY: "some/fork" },
        {
          GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
          GITHUB_REPOSITORY: "goat-si/goat",
          GOAT_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
        },
        {
          GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
          GOAT_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat/extra",
        },
        // The private source repository is never a feed: binaries live in goat-releases.
        {
          GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
          GOAT_DESKTOP_UPDATE_REPOSITORY: "goat-si/goat",
        },
      ]) {
        const config = yield* createBuildConfig(
          "mac",
          "dmg",
          "1.2.3",
          false,
          false,
          undefined,
          undefined,
        ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));
        assert.strictEqual(config.publish, null);
        assert.equal(config.appId, "si.goat.desktop");
        assert.equal(config.productName, "GOAT");
        assert.equal(config.artifactName, "GOAT-${version}-${arch}.${ext}");
      }
    }),
  );

  it.effect("names GOAT as the maintainer of the Linux packages", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const linux = config.linux as Record<string, unknown>;
      assert.equal(linux.maintainer, "GOAT <jun@lidgeai.com>");
    }),
  );

  it.effect("configures only an opted-in canonical nightly feed and keeps previews off", () =>
    Effect.gen(function* () {
      const feed = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20261011.1",
        false,
        false,
        undefined,
        undefined,
      );
      assert.equal(feed.appId, "si.goat.desktop.nightly");
      assert.deepStrictEqual(feed.publish, [
        {
          provider: "github",
          owner: "goat-si",
          repo: "goat-releases",
          releaseType: "prerelease",
          channel: "nightly",
        },
      ]);
      for (const version of ["1.2.3-pr.4.1", "1.2.3-preview.20261011.1"]) {
        const preview = yield* createBuildConfig(
          "mac",
          "dmg",
          version,
          false,
          true,
          3999,
          undefined,
        );
        assert.strictEqual(preview.publish, null);
      }
      const mock = yield* createBuildConfig("mac", "dmg", "1.2.3", false, true, 3999, undefined);
      assert.deepStrictEqual(mock.publish, [{ provider: "generic", url: "http://localhost:3999" }]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              GOAT_DESKTOP_UPDATE_REPOSITORY: " goat-si/goat-releases ",
              GITHUB_REPOSITORY: "some/fork",
              GOAT_DESKTOP_UPDATE_FEED_ENABLED: "true",
            },
          }),
        ),
      ),
    ),
  );

  it("requires provisioning only for explicitly opted-in signed macOS builds", () => {
    const local = { platform: "mac" as const, signed: true, macPasskeys: false, version: "1.2.3" };
    assert.isUndefined(resolveOptionalMacPasskeySigningConfiguration(local, {}));
    assert.isUndefined(
      resolveOptionalMacPasskeySigningConfiguration(
        { ...local, signed: false, macPasskeys: true },
        {},
      ),
    );
    assert.isUndefined(
      resolveOptionalMacPasskeySigningConfiguration(
        { ...local, platform: "linux", macPasskeys: true },
        {},
      ),
    );
    assert.throws(() =>
      resolveOptionalMacPasskeySigningConfiguration({ ...local, macPasskeys: true }, {}),
    );
    const entitled = resolveOptionalMacPasskeySigningConfiguration(
      { ...local, macPasskeys: true, version: "1.2.3-nightly.20261011.1" },
      {
        GOAT_APPLE_TEAM_ID: "ABC1234567",
        GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/goat.provisionprofile",
        GOAT_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
      },
    );
    assert.equal(entitled?.appId, "si.goat.desktop.nightly");
  });

  it.effect("keeps normal signing available without a passkey profile", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        true,
        false,
        undefined,
        undefined,
      );
      const mac = config.mac as Record<string, unknown>;
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.notProperty(mac, "provisioningProfile");
      assert.notProperty(mac, "entitlements");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "GOAT");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "GOAT (Nightly)");
  });

  it("limits Electron locales and excludes separately packaged resources", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    for (const resource of [
      ...DESKTOP_EXTRA_RESOURCES,
      ...WSL_RUNTIME_EXTRA_RESOURCES,
      ...LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
    ]) {
      assert.include(
        DESKTOP_FILE_EXCLUSIONS,
        `!${resource.from}`,
        `${resource.from} ships via extraResources and must be excluded from app.asar`,
      );
    }
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        true,
      );
      const winWithoutWslRuntime = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
      );

      assert.notProperty(mac, "asar");
      assert.notProperty(linux, "asar");
      // macOS keeps only the helper's driver; Linux still uses the native SDK.
      const cuaNativeUnpack = [
        "**/node_modules/@trycua/cua-driver-*/**/*.{node,so,dylib,dll}",
        "**/node_modules/@ubjs/node-*/**/*.node",
      ];
      assert.deepStrictEqual(mac.asarUnpack, ["**/node_modules/@ubjs/node-*/**/*.node"]);
      assert.deepStrictEqual(linux.asarUnpack, cuaNativeUnpack);
      assert.deepStrictEqual(win.asar, { smartUnpack: false });
      assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
      assert.deepStrictEqual(winWithoutWslRuntime.asar, win.asar);
      assert.deepStrictEqual(winWithoutWslRuntime.asarUnpack, win.asarUnpack);
      assert.deepStrictEqual(
        mac.extraResources,
        DESKTOP_EXTRA_RESOURCES.filter((resource) => resource.to !== "cua-driver"),
      );
      assert.deepStrictEqual(linux.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...LINUX_CAPTURE_EXTRA_RESOURCES,
        { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
      ]);
      assert.deepStrictEqual(win.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
        ...WSL_RUNTIME_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(winWithoutWslRuntime.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, {
        differentialPackage: true,
        include: "apps/desktop/resources/installer.nsh",
      });
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@cursor/sdk-*",
        "**/node_modules/@cursor/sdk-*/**",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
        "**/*.map",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "GOAT 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 640, height: 432 },
        contents: [
          { x: 166, y: 214, type: "file" },
          { x: 474, y: 214, type: "link", path: "/Applications" },
        ],
        iconSize: 120,
        iconTextSize: 12,
      });
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage", "deb"]);
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "GOAT", schemes: ["goat", "goat-dev", "t3code", "t3code-dev"] },
      ]);
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).protocols, [
        { name: "GOAT", schemes: ["goat", "goat-dev", "t3code", "t3code-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
      const macInfo = (mac.mac as { extendInfo: Record<string, unknown> }).extendInfo;
      assert.strictEqual(macInfo.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac, true);
      assert.deepStrictEqual(macInfo.CFBundleDocumentTypes, [
        {
          CFBundleTypeName: "Web page",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.html", "public.xhtml"],
        },
      ]);
      assert.deepStrictEqual(linux.toolsets, { appimage: "1.0.3" });
      assert.notProperty(mac, "toolsets");
      assert.notProperty(win, "toolsets");
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      for (const file of [
        "node_modules/@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
        "node_modules/@trycua/cua-driver-darwin-x64/cua_driver_node_runtime.node",
        "node_modules/@trycua/cua-driver-linux-x64-gnu/libcua_driver_sdk.so",
        "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
        "node_modules/@trycua/cua-driver/dist/embedded.js",
      ]) {
        const excluded = (config: Record<string, unknown>) =>
          (config.files as string[]).some((glob) => NodePath.matchesGlob(file, glob.slice(1)));
        assert.isTrue(excluded(mac), file);
        assert.isFalse(excluded(linux), file);
        assert.isFalse(excluded(win), file);
      }
      assert.deepStrictEqual(linux.files, [...DESKTOP_FILE_EXCLUSIONS, ...LINUX_FILE_EXCLUSIONS]);
      assert.deepStrictEqual(win.files, DESKTOP_FILE_EXCLUSIONS);
      assert.deepStrictEqual(winWithoutWslRuntime.files, win.files);
      assert.notProperty(mac.mac as Record<string, unknown>, "sign");
      assert.propertyVal(
        (mac.mac as Record<string, unknown>).extendInfo as Record<string, unknown>,
        "NSLocalNetworkUsageDescription",
        "GOAT connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      );
      for (const config of [linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      }
      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("prefers the repository's vp, then PATH, and says how to run without either", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-repo-vp-test-" });
        const pathDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-path-vp-test-" });
        const onHost = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
          resolveVp(repoRoot).pipe(
            Effect.provideService(HostProcess.Environment, env),
            Effect.provideService(HostProcess.Platform, platform),
          );

        // The shared resolver caches misses per PATH, so this step uses its own.
        const missing = yield* Effect.flip(onHost("darwin", { PATH: "" }));
        assert.instanceOf(missing, VpNotFoundError);
        assert.include(missing.message, "pnpm run dist:desktop:artifact");

        const pathVp = path.join(pathDir, "vp");
        yield* fs.writeFileString(pathVp, "#!/bin/sh\n");
        yield* fs.chmod(pathVp, 0o755);
        assert.equal(yield* onHost("darwin", { PATH: pathDir }), "vp");

        const binDir = path.join(repoRoot, "node_modules/.bin");
        yield* fs.makeDirectory(binDir, { recursive: true });
        yield* fs.writeFileString(path.join(binDir, "vp"), "");
        yield* fs.writeFileString(path.join(binDir, "vp.cmd"), "");
        assert.equal(yield* onHost("darwin", { PATH: pathDir }), path.join(binDir, "vp"));
        assert.equal(yield* onHost("win32", { PATH: "" }), path.join(binDir, "vp.cmd"));
      }),
    ),
  );

  it.effect.each(["both", "legacy-only"])(
    "stages a %s cached resource monitor under the new name without invoking Cargo",
    (mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repoRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "goat-resource-monitor-cache-test-",
          });
          const binaryPath = path.join(
            repoRoot,
            "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/goat-resource-monitor",
          );
          const stageResourcesDir = path.join(repoRoot, "stage");
          yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
          yield* fs.writeFileString(
            path.join(path.dirname(binaryPath), LEGACY_RESOURCE_MONITOR_BINARY_NAME),
            "legacy monitor",
          );
          if (mode === "both") yield* fs.writeFileString(binaryPath, "cached monitor");

          yield* stageResourceMonitor({
            repoRoot,
            stageResourcesDir,
            platform: "linux",
            arch: "x64",
            verbose: false,
          }).pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { GOAT_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          );

          assert.equal(
            yield* fs.readFileString(
              path.join(stageResourcesDir, "resource-monitor/goat-resource-monitor"),
            ),
            mode === "both" ? "cached monitor" : "legacy monitor",
          );
          assert.deepEqual(
            yield* fs.readDirectory(path.join(stageResourcesDir, "resource-monitor")),
            ["goat-resource-monitor"],
          );
        }),
      ),
  );

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "si.goat.desktop");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
      assert.deepStrictEqual(mac.protocols, [
        { name: "GOAT", schemes: ["goat", "goat-dev", "t3code", "t3code-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("maps resource monitor build targets and executable names", () => {
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "goat-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "goat-resource-monitor.exe");
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const input = {
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
        sshRuntimeArchiveDir: Option.none(),
        requireAllSshRuntimes: Option.none(),
      };
      const resolved = yield* resolveBuildOptions(input).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      const optedIn = yield* resolveBuildOptions(input).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GOAT_DESKTOP_MAC_PASSKEYS: "true",
                GOAT_DESKTOP_SIGNED: "true",
              },
            }),
          ),
        ),
      );
      assert.equal(optedIn.macPasskeys, true);
      assert.equal(optedIn.signed, true);
      assert.equal(resolved.macPasskeys, false);
      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );
});

it("refuses a preload that Electron's sandbox wrapper cannot parse", () => {
  // Effect's scheduler declared this at the top level of the 0.1.1 nightly preload.
  const effectScheduler = "const setImmediate = (f) => f();\nsetImmediate(() => {});";
  assert.include(sandboxedPreloadSyntaxError(effectScheduler) ?? "", "setImmediate");
  assert.strictEqual(
    sandboxedPreloadSyntaxError("(() => {\n" + effectScheduler + "\n})();"),
    undefined,
  );
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "local",
  "complete",
  "missing",
  "bad-sidecar",
  "missing-monitor",
  "wrong-stem",
  "missing-goat",
  "missing-client",
  "missing-pty",
  "loose-bin",
  "corrupt",
  "missing-source",
  "wrong-version",
  "oversized",
] as const)("stages and validates exact SSH payload bytes: %s", (mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-bundle-packaging-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "staged");
    const version = "1.2.3";
    yield* fs.makeDirectory(source, { recursive: true });
    const keys = mode === "complete" ? SSH_RUNTIME_PLATFORM_KEYS : [SSH_RUNTIME_PLATFORM_KEYS[0]];
    const before = new Map<string, Uint8Array>();
    for (const key of keys) {
      const stem = `goat-${version}-${key}`;
      const fixture = yield* makeLinuxCliArchiveFixture({
        root: path.join(root, key),
        stem: mode === "wrong-stem" ? "goat-9.9.9-linux-x64" : stem,
        extraMembers:
          mode === "missing-monitor"
            ? []
            : [
                `${stem}/resource-monitor/${key}/goat-resource-monitor`,
                ...(mode === "loose-bin" ? [`${stem}/bin.mjs`] : []),
              ],
        omitMembers:
          mode === "missing-goat"
            ? [`${stem}/goat`]
            : mode === "missing-client"
              ? [`${stem}/client/index.html`]
              : mode === "missing-pty"
                ? [`${stem}/node_modules/node-pty/build/Release/pty.node`]
                : [],
      });
      const name = `${stem}.tar.gz`;
      const bytes = yield* fs.readFile(fixture);
      yield* fs.writeFile(path.join(source, name), bytes);
      before.set(name, bytes);
      if (mode === "bad-sidecar")
        yield* fs.writeFileString(path.join(source, name + ".sha256"), "bad");
      if (mode === "corrupt") {
        const corrupt = new Uint8Array([1, 2, 3]);
        yield* fs.writeFile(path.join(source, name), corrupt);
        before.set(name, corrupt);
      }
      if (mode === "oversized") {
        yield* fs.truncate(path.join(source, name), 268435457);
        before.delete(name);
      }
    }
    if (mode === "missing-source") {
      yield* fs.remove(source, { recursive: true });
      before.clear();
    }
    const result = yield* Effect.exit(
      stageSshRuntimeArchives({
        sourceDirectory: source,
        destinationDirectory: destination,
        version: mode === "wrong-version" ? "9.9.9" : version,
        requireAll: mode === "complete" || mode === "missing",
      }),
    );
    const success = mode === "complete" || mode === "local";
    assert.equal(result._tag === "Success", success);
    for (const [name, bytes] of before)
      assert.deepEqual(yield* fs.readFile(path.join(source, name)), bytes);
    if (!success) {
      assert.isFalse(yield* fs.exists(destination));
      return;
    }
    const archives = yield* validateSshRuntimeArchives({
      directory: destination,
      version,
      requireAll: mode === "complete",
      requireSidecars: true,
    });
    assert.equal(archives.length, keys.length);
    for (const archive of archives) {
      assert.deepEqual(archive.bytes, before.get(archive.fileName));
      assert.equal(
        yield* fs.readFileString(path.join(destination, archive.fileName + ".sha256")),
        `${archive.sha256}  ${archive.fileName}\n`,
      );
    }
    const dist = path.join(root, "dist");
    const resources = path.join(
      dist,
      "mac-arm64",
      "GOAT.app",
      "Contents",
      "Resources",
      "ssh-runtime",
      "archives",
    );
    yield* fs.makeDirectory(path.dirname(resources), { recursive: true });
    yield* fs.copy(destination, resources);
    yield* validatePackagedSshRuntimeArchives({
      stageDistDir: dist,
      version,
      requireAll: mode === "complete",
    });
    yield* fs.writeFile(path.join(resources, archives[0]!.fileName), new Uint8Array([1]));
    assert.equal(
      (yield* Effect.exit(
        validatePackagedSshRuntimeArchives({
          stageDistDir: dist,
          version,
          requireAll: mode === "complete",
        }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([
  "ci",
  "strict",
  "local",
  "omitted",
  "missing",
  "override",
  "env-override",
  "skip-build-override",
  "preview-ci",
  "preview-with-bundle",
  "preview-strict",
  "ci-without-bundle",
] as const)("resolves SSH packaging inputs before staging: %s", (mode) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion:
          mode === "override" || mode === "skip-build-override"
            ? Option.some("9.9.9")
            : Option.none(),
        outputDir: Option.none(),
        skipBuild: mode === "skip-build-override" ? Option.some(true) : Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
        sshRuntimeArchiveDir:
          mode === "missing" ||
          mode === "omitted" ||
          mode === "preview-ci" ||
          mode === "preview-strict" ||
          mode === "ci-without-bundle"
            ? Option.none()
            : Option.some("  /fixture/archives  "),
        requireAllSshRuntimes: Option.some(
          mode === "strict" || mode === "missing" || mode === "preview-strict",
        ),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              CI:
                mode === "ci" || mode.startsWith("preview-") || mode === "ci-without-bundle"
                  ? "true"
                  : "false",
              GOAT_DESKTOP_SSH_RUNTIME_BUNDLE_OPTIONAL: mode.startsWith("preview-")
                ? "true"
                : "false",
              ...(mode === "env-override" ? { GOAT_DESKTOP_VERSION: "9.9.9" } : {}),
            }),
          ),
        ),
      ),
    );
    const failed =
      mode === "missing" ||
      mode === "skip-build-override" ||
      mode === "preview-strict" ||
      mode === "ci-without-bundle";
    assert.equal(result._tag === "Failure", failed);
    if (result._tag === "Success") {
      // An override is stamped into every release manifest for the build, so the
      // bundle, the server and the bundled runtime all carry it.
      if (mode === "override" || mode === "env-override") {
        assert.equal(result.value.version, "9.9.9");
      } else if (mode === "ci" || mode.startsWith("preview-")) {
        assert.equal(result.value.version, serverPackageJson.version);
      } else {
        assert.match(result.value.version, /^\d+\.\d+\.\d+-dev\.\d+\.g[0-9a-f]{7,9}$/);
      }
      assert.equal(
        result.value.requireAllSshRuntimes,
        mode === "ci" || mode === "strict" || mode === "preview-with-bundle",
      );
      assert.equal(
        result.value.sshRuntimeArchiveDir,
        mode === "omitted" || mode === "preview-ci" ? undefined : "/fixture/archives",
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["mac", "linux", "win"] as const)(
  "copies configured SSH resources and rejects damaged packaged %s bytes",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-resource-copy-" });
      const app = path.join(root, "app");
      const source = path.join(root, "source");
      const version = "1.2.3";
      for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
        const stem = `goat-${version}-${key}`;
        const archive = yield* makeLinuxCliArchiveFixture({
          root: path.join(root, key),
          stem,
          extraMembers: [`${stem}/resource-monitor/${key}/goat-resource-monitor`],
        });
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.copyFile(archive, path.join(source, stem + ".tar.gz"));
      }
      yield* stageSshRuntimeArchives({
        sourceDirectory: source,
        destinationDirectory: path.join(app, SSH_RUNTIME_RESOURCE_SOURCE_DIR),
        version,
        requireAll: true,
      });
      const config = yield* createBuildConfig(
        platform,
        platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "appimage",
        version,
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
      );
      const dist = path.join(root, "dist");
      const resources =
        platform === "mac"
          ? path.join(dist, "mac-arm64", "GOAT.app", "Contents", "Resources")
          : path.join(dist, `${platform}-unpacked`, "resources");
      const sets = config.extraResources as typeof SSH_RUNTIME_EXTRA_RESOURCES;
      const bundleSet = sets.find((set) => set.to === "ssh-runtime/archives");
      assert.isDefined(bundleSet);
      if (!bundleSet) return;
      const destination = path.join(resources, bundleSet.to);
      yield* fs.makeDirectory(destination, { recursive: true });
      for (const file of yield* fs.readDirectory(path.join(app, bundleSet.from))) {
        if (bundleSet.filter.some((pattern) => NodePath.matchesGlob(file, pattern))) {
          yield* fs.copyFile(path.join(app, bundleSet.from, file), path.join(destination, file));
        }
      }
      assert.equal((yield* fs.readDirectory(destination)).length, 6);
      yield* validatePackagedSshRuntimeArchives({ stageDistDir: dist, version, requireAll: true });
      const name = `goat-${version}-${SSH_RUNTIME_PLATFORM_KEYS[0]}.tar.gz`;
      const bytes = yield* fs.readFile(path.join(destination, name));
      const sidecar = yield* fs.readFileString(path.join(destination, name + ".sha256"));
      for (const damage of ["archive", "sidecar", "noncanonical", "bytes"] as const) {
        if (damage === "archive") yield* fs.remove(path.join(destination, name));
        if (damage === "sidecar") yield* fs.remove(path.join(destination, name + ".sha256"));
        if (damage === "noncanonical")
          yield* fs.writeFileString(
            path.join(destination, name + ".sha256"),
            sidecar.replace("  ", " *"),
          );
        if (damage === "bytes")
          yield* fs.writeFile(path.join(destination, name), new Uint8Array([1]));
        assert.equal(
          (yield* Effect.exit(
            validatePackagedSshRuntimeArchives({ stageDistDir: dist, version, requireAll: true }),
          ))._tag,
          "Failure",
        );
        yield* fs.writeFile(path.join(destination, name), bytes);
        yield* fs.writeFileString(path.join(destination, name + ".sha256"), sidecar);
        yield* validateSshRuntimeArchives({
          directory: path.join(app, SSH_RUNTIME_RESOURCE_SOURCE_DIR),
          version,
          requireAll: true,
          requireSidecars: true,
        });
      }
      const omitted = yield* createBuildConfig(
        platform,
        "dir",
        version,
        false,
        false,
        undefined,
        undefined,
      );
      assert.isFalse(
        (omitted.extraResources as Array<{ to: string }>).some(
          (set) => set.to === "ssh-runtime/archives",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each(SSH_RUNTIME_PLATFORM_KEYS)(
  "strict staging rejects missing %s before writing resources",
  (missing) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      yield* fs.makeDirectory(source);
      for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
        const stem = `goat-1.2.3-${key}`;
        const archive = yield* makeLinuxCliArchiveFixture({
          root: path.join(root, key),
          stem,
          extraMembers: [`${stem}/resource-monitor/${key}/goat-resource-monitor`],
        });
        if (key !== missing) yield* fs.copyFile(archive, path.join(source, stem + ".tar.gz"));
      }
      const before = yield* fs.readDirectory(source);
      assert.equal(
        (yield* Effect.exit(
          stageSshRuntimeArchives({
            sourceDirectory: source,
            destinationDirectory: destination,
            version: "1.2.3",
            requireAll: true,
          }),
        ))._tag,
        "Failure",
      );
      assert.isFalse(yield* fs.exists(destination));
      assert.deepEqual(yield* fs.readDirectory(source), before);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("gives a local build of the plain base an ordered dev version, never the bare base", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const resolve = (input: {
      explicitVersion?: string;
      ci?: boolean;
      skipBuild?: boolean;
      packageVersion?: string;
    }) =>
      Effect.exit(
        resolveDesktopBuildVersion({
          explicitVersion: input.explicitVersion,
          packageVersion: input.packageVersion ?? "0.1.0",
          ci: input.ci ?? false,
          skipBuild: input.skipBuild ?? false,
          repoRoot,
        }),
      );
    const local = yield* resolve({});
    assert.equal(local._tag, "Success");
    if (local._tag === "Success") assert.match(local.value, /^0\.1\.0-dev\.\d+\.g[0-9a-f]{7,9}$/);
    // CI release jobs stamp the manifests before they build.
    const ci = yield* resolve({ ci: true });
    assert.equal(ci._tag === "Success" && ci.value, "0.1.0");
    const stamped = yield* resolve({ packageVersion: "0.1.0-nightly.20261012.1", skipBuild: true });
    assert.equal(stamped._tag === "Success" && stamped.value, "0.1.0-nightly.20261012.1");
    // A prebuilt server cannot be restamped, so a different bundle version is refused.
    const skipped = yield* resolve({ explicitVersion: "0.1.0-dev.1.gabcdef1", skipBuild: true });
    assert.equal(skipped._tag, "Failure");
    assert.include(String(skipped), "update-release-package-versions.ts 0.1.0-dev.1.gabcdef1");
    const skippedLocal = yield* resolve({ skipBuild: true });
    assert.equal(skippedLocal._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("stamps every release manifest for the build and restores them afterwards", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-version-stamp-" });
    const original = (file: string) => `{\n  "name": "${file}",\n  "version": "0.1.0"\n}\n`;
    for (const file of releasePackageFiles) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fs.writeFileString(path.join(root, file), original(file));
    }
    const during = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* stampReleaseVersionForBuild(root, "0.1.0-dev.1792000000.gabcdef123");
        return yield* Effect.forEach(releasePackageFiles, (file) =>
          fs
            .readFileString(path.join(root, file))
            .pipe(Effect.map((text) => JSON.parse(text).version)),
        );
      }),
    );
    assert.deepEqual(new Set(during), new Set(["0.1.0-dev.1792000000.gabcdef123"]));
    for (const file of releasePackageFiles) {
      assert.equal(yield* fs.readFileString(path.join(root, file)), original(file));
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("reads the version from the server's --version output", () => {
  assert.equal(
    parseServerVersionOutput("goat v0.1.0-nightly.20261012.1\n"),
    "0.1.0-nightly.20261012.1",
  );
  assert.equal(parseServerVersionOutput("goat v0.1.0"), "0.1.0");
  assert.equal(parseServerVersionOutput("Error: boom"), undefined);
});
