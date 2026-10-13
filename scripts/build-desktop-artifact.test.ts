// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { extractFile } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  DesktopDmgBackgroundSourceMissingError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  LINUX_CAPTURE_EXTRA_RESOURCES,
  LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
  LINUX_FILE_EXCLUSIONS,
  MAC_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  LinuxDesktopBuildPrerequisitesMissingError,
  MacDesktopBuildPrerequisitesMissingError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightLinuxDesktopBuild,
  preflightMacDesktopBuild,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveOptionalMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveMergedStageDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resolveVp,
  VpNotFoundError,
  resolveWindowsServerAsarIgnoreGlobs,
  resourceMonitorExecutableName,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  stageLinuxCaptureHelper,
  stageWslRuntimeArchive,
  stageSshRuntimeArchives,
  validateSshRuntimeArchives,
  validatePackagedSshRuntimeArchives,
  SSH_RUNTIME_PLATFORM_KEYS,
  SSH_RUNTIME_EXTRA_RESOURCES,
  SSH_RUNTIME_RESOURCE_SOURCE_DIR,
  bundlesWslRuntime,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  stageBrowserSecret,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  stageCursorSdkPlatformPackages,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_EXTRA_RESOURCES,
  WslRuntimeArchiveMissingError,
  wslRuntimeArchiveStem,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import { symlinksSupported } from "@goat/shared/testing/symlinks";

// Keeps pnpm from auto-installing TypeScript, a types-only peer, into the app.
const stagePackageExtensions = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
};

// A minimal stand-in for the Linux CLI release archive: one top-level
// directory named after the archive stem holding the executable, the web
// client, and the runtime externals with node-pty built from source.
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

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

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
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? // The old hand-rolled runtime: apps/server/dist + node_modules at the
          // archive root, no single stem directory, no `t3` executable.
          yield* makeLinuxCliArchiveFixture({
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
      extraMembers: [`${stem}/resource-monitor/${key}/t3-resource-monitor`],
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

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
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
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
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
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "GOAT");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "GOAT (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
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
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
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
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "goat-si",
        repo: "goat-releases",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "goat-si",
        repo: "goat-releases",
        releaseType: "prerelease",
        channel: "nightly",
      });
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

      assert.strictEqual(preview.publish, null);
      assert.strictEqual(previewChannel.publish, null);
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

  it("stages only the desktop main-process externals", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@clerk/electron": "catalog:",
          "@clerk/electron-passkeys": "catalog:",
          "@crowecawcaw/xa11y": "0.13.0",
          "@effect/platform-node": "catalog:",
          "@napi-rs/keyring": "^1.3.0",
          "@goat/contracts": "workspace:*",
          "@goat/shared": "workspace:*",
          "dbus-next": "0.10.2",
          effect: "catalog:",
          electron: "41.5.0",
          "electron-updater": "^6.6.2",
          "ffi-rs": "1.3.2",
          "playwright-core": "1.60.0",
        },
        {
          "@clerk/electron": "0.0.37",
          "@clerk/electron-passkeys": "0.0.3",
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@clerk/electron-passkeys": "0.0.3",
        "@crowecawcaw/xa11y": "0.13.0",
        "@napi-rs/keyring": "^1.3.0",
        "ffi-rs": "1.3.2",
        "playwright-core": "1.60.0",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
      packageExtensions: stagePackageExtensions,
    });
    // Windows stages only win32 natives; WSL runs the separately built Linux
    // CLI archive rather than anything installed here.
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["arm64"],
      },
      packageExtensions: stagePackageExtensions,
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
      packageExtensions: stagePackageExtensions,
    });
  });

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1];
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        packageExtensions: stagePackageExtensions,
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
        packageExtensions: stagePackageExtensions,
      },
    );
  });

  it("limits Electron locales and excludes separately packaged resources", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    // Every platform staging input is emitted once at resources/, so adding one
    // without its exclusion silently packs a second copy into app.asar. The
    // snapshot below cannot catch that on its own: adding a resource and
    // forgetting the exclusion leaves the exclusion list untouched, so it still
    // matches. Assert the invariant first, where the failure names the culprit.
    for (const resource of [
      ...WSL_RUNTIME_EXTRA_RESOURCES,
      ...LINUX_BROWSER_SECRET_EXTRA_RESOURCES,
    ]) {
      assert.include(
        DESKTOP_FILE_EXCLUSIONS,
        `!${resource.from}`,
        `${resource.from} ships via extraResources and must be excluded from app.asar`,
      );
    }

    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@cursor/sdk-*/**/*",
      "!apps/desktop/prod-resources/cursor-sdk",
      "!apps/desktop/prod-resources/cursor-sdk/**/*",
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!**/*.map",
      "!**/*.d.cts",
      "!apps/desktop/resources/browser-secret",
      "!apps/desktop/resources/browser-secret/**/*",
      "!apps/desktop/prod-resources/browser-secret",
      "!apps/desktop/prod-resources/browser-secret/**/*",
      "!apps/desktop/prod-resources/windows-server",
      "!apps/desktop/prod-resources/windows-server/**/*",
      "!apps/desktop/prod-resources/ssh-runtime",
      "!apps/desktop/prod-resources/ssh-runtime/**/*",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
      "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      "!apps/desktop/prod-resources/LICENSE-T3CODE.txt",
      "!apps/desktop/gnome-extension",
      "!apps/desktop/gnome-extension/**/*",
    ]);
    assert.equal(WINDOWS_SERVER_RESOURCE_SOURCE_DIR, "apps/desktop/prod-resources/windows-server");
    assert.deepStrictEqual(WINDOWS_SERVER_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/windows-server",
        to: ".",
        filter: ["server.asar", "server.asar.unpacked/**/*"],
      },
    ]);
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

      // Windows unpacks native files explicitly so their JavaScript and metadata
      // stay archived. Other platforms retain electron-builder's defaults.
      assert.notProperty(mac, "asar");
      assert.notProperty(linux, "asar");
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asar, { smartUnpack: false });
      assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
      assert.deepStrictEqual(winWithoutWslRuntime.asar, win.asar);
      assert.deepStrictEqual(winWithoutWslRuntime.asarUnpack, win.asarUnpack);
      assert.deepStrictEqual(mac.extraResources, DESKTOP_EXTRA_RESOURCES);
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
      // No Linux CLI archive means staging never writes the runtime, so
      // listing it here would fail the build on a missing source file.
      assert.deepStrictEqual(winWithoutWslRuntime.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, { differentialPackage: true });
      // The Claude SDK platform packages and .bin shims never ship.
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
      // A Linux AppImage build also emits the .deb from the same run.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage", "deb"]);
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/goat;... for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "GOAT", schemes: ["goat", "goat-dev", "t3code", "t3code-dev"] },
      ]);
      // macOS also offers itself as a web browser, so it can be chosen as the default.
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).protocols, [
        { name: "GOAT", schemes: ["goat", "goat-dev", "t3code", "t3code-dev"] },
        { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
      ]);
      // macOS lists a default browser only when it also opens web pages as documents.
      const macInfo = (mac.mac as { extendInfo: Record<string, unknown> }).extendInfo;
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

  it("excludes foreign node-pty prebuilds from macOS and Linux packages", () => {
    assert.deepStrictEqual(MAC_FILE_EXCLUSIONS, [
      "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
      "!**/node_modules/node-pty/third_party/conpty/**/*",
    ]);
    assert.deepStrictEqual(LINUX_FILE_EXCLUSIONS, [
      ...MAC_FILE_EXCLUSIONS,
      "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
    ]);
  });

  it("unpacks native binaries while keeping their JavaScript and metadata archived", () => {
    for (const file of [
      "node_modules/@napi-rs/keyring/keyring.win32-x64-msvc.node",
      "node_modules/@clerk/electron-passkeys/electron-passkeys.win32-x64-msvc.node",
      "node_modules/@ff-labs/fff-bin-win32-x64/fff_c.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/native/addon.so",
      "node_modules/native/addon.so.1",
      "node_modules/native/addon.dylib",
    ]) {
      assert.isTrue(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} must be available as a real file`,
      );
    }

    for (const file of [
      "node_modules/@napi-rs/keyring/index.js",
      "node_modules/@napi-rs/keyring/keytar.js",
      "node_modules/@clerk/electron-passkeys/index.js",
    ]) {
      assert.isFalse(
        NodePath.matchesGlob(file, WINDOWS_NATIVE_ASAR_UNPACK_GLOB),
        `${file} should remain inside the archive`,
      );
    }
  });

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

  it("excludes node-pty binaries for the other Windows architecture", () => {
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("x64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-arm64",
      "**/node_modules/node-pty/prebuilds/win32-arm64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**",
    ]);
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("arm64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-x64",
      "**/node_modules/node-pty/prebuilds/win32-x64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64/**",
    ]);
  });

  it.effect("unpacks target Windows natives while excluding the other architecture", () =>
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

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, nativeFile.includes("linux") ? "\x7fELF" : "MZ");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

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
        // Signed builds sign every unpacked .node, so the ELF prebuild stays packed.
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

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-resource-monitor-cache-test-",
        });
        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
        );
        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

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
            path.join(stageResourcesDir, "resource-monitor/t3-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("reports every missing Linux desktop build prerequisite with an install command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            commands.push(childProcess);
            const fails =
              childProcess.command === "cargo" ||
              childProcess.command === "rustc" ||
              childProcess.command === "pkg-config";
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );

        const error = yield* preflightLinuxDesktopBuild("arm64").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, LinuxDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["cargo", "rust-target", "libsecret"]);
        assert.include(error.message, "Rust compiler and Cargo (cargo, rustc)");
        assert.include(error.message, "Requested Rust standard library");
        assert.include(
          error.message,
          "sudo apt-get install cargo rustc libsecret-1-dev pkg-config",
        );
        assert.include(error.message, "rustup target add aarch64-unknown-linux-gnu");
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === "rustc" && command.args.includes("aarch64-unknown-linux-gnu"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing macOS tools and Rust targets before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            const fails =
              childProcess.command === "rustc" ||
              (childProcess.command === "xcrun" && childProcess.args.includes("iconutil"));
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightMacDesktopBuild("universal").pipe(
          Effect.provide(spawner),
          Effect.flip,
        );

        assert.instanceOf(error, MacDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "iconutil"]);
        assert.deepStrictEqual(error.rustTargets, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
        assert.include(error.message, "xcode-select --install");
        assert.include(error.message, "rustup target add aarch64-apple-darwin x86_64-apple-darwin");
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
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
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
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc"]);
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
          bundlesWslRuntime: true,
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
          bundlesWslRuntime: false,
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

  it.effect("builds and stages native capture helpers for each Linux architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-kde-stage-test-" });
        const protocols = path.join(repoRoot, "native/hyprland-snap-shot/protocols");
        yield* fs.makeDirectory(protocols, { recursive: true });
        yield* fs.writeFileString(path.join(protocols, "capture.xml"), "BSD protocol notice");
        for (const backend of ["kde", "hyprland"] as const) {
          for (const [arch, target] of [
            ["x64", "x86_64-unknown-linux-gnu"],
            ["arm64", "aarch64-unknown-linux-gnu"],
          ] as const) {
            const binary = path.join(
              repoRoot,
              `native/${backend}-snap-shot/target`,
              target,
              `release/t3-${backend}-snap-shot`,
            );
            const stageResourcesDir = path.join(repoRoot, "stage", backend, arch);
            const spawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) =>
                Effect.gen(function* () {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") return mockProcess(1);
                  assert.equal(command.command, "cargo");
                  assert.deepEqual(command.args, [
                    "build",
                    "--locked",
                    "--release",
                    "--manifest-path",
                    path.join(repoRoot, `native/${backend}-snap-shot/Cargo.toml`),
                    "--target",
                    target,
                  ]);
                  yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
                  yield* fs.writeFileString(binary, `helper-${arch}`);
                  return mockProcess(0);
                }),
              ),
            );
            yield* stageLinuxCaptureHelper({
              backend,
              repoRoot,
              stageResourcesDir,
              arch,
              verbose: false,
            }).pipe(Effect.provide(spawner));
            const installed = path.join(
              stageResourcesDir,
              `${backend}-capture/t3-${backend}-snap-shot`,
            );
            assert.equal(yield* fs.readFileString(installed), `helper-${arch}`);
            assert.equal((yield* fs.stat(installed)).mode & 0o777, 0o755);
            if (backend === "hyprland")
              assert.equal(
                yield* fs.readFileString(
                  path.join(stageResourcesDir, "hyprland-capture/protocols/capture.xml"),
                ),
                "BSD protocol notice",
              );
          }
        }
      }),
    ),
  );

  // The fixture's t3code.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
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

  it.effect("accepts an embedded Linux CLI release archive with a matching digest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        });

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
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

  it.effect("rejects a loose server tree that is not a Linux CLI release archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "loose-server-tree",
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

  it.effect("builds the Linux browser secret helper for a concrete architecture", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      // `universal` is a mac-only arch the option type still admits. The helper
      // script only knows x64 and arm64, so the request maps to x64, the same
      // concrete target the Linux resource monitor resolves it to.
      yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "universal",
        verbose: false,
      });
      const helper = commands.find((command) =>
        command.args.some((arg) => arg.endsWith("build-browser-secret.mjs")),
      );
      assert.isDefined(helper);
      const path = yield* Path.Path;
      assert.deepStrictEqual(helper.args.slice(-4), [
        "--arch",
        "x64",
        "--output",
        path.join("/stage/resources", "browser-secret", "t3-browser-secret"),
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "linux"),
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
      // The helper links against the host's libsecret and its build script is
      // a no-op elsewhere, so a Linux artifact built on macOS would ship
      // without it and report the keyring as unavailable on every import.
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
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.isFalse(
          commands.some((command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1"),
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
          "resources/resource-monitor/t3-resource-monitor.exe",
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
          "resource-monitor/t3-resource-monitor.exe",
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
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("rasterizes staged DMG backgrounds at standard and Retina sizes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-dmg-background-",
        });
        const dmgDir = path.join(stageResourcesDir, "dmg");
        yield* fs.makeDirectory(dmgDir, { recursive: true });
        const sourcePath = path.join(dmgDir, "dmg-background-nightly.svg");
        yield* fs.writeFileString(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];

        yield* stageDesktopDmgBackground(stageResourcesDir, "nightly", false).pipe(
          Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])),
        );

        assert.deepStrictEqual(
          commands.map((command) => [command.command, ...command.args]),
          [
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "432",
              "640",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly.png"),
            ],
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "864",
              "1280",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly@2x.png"),
            ],
          ],
        );
      }),
    ),
  );

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, "latest", false).pipe(
          Effect.flip,
        );

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      GOAT_APPLE_TEAM_ID: "abc1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
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
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
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
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.t3tools.t3code", teamId: "ABC1234567" };
    // Profiles are CMS envelopes around a plain XML plist.
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
    // Only real values inside the Entitlements dict count: not comments, not
    // explicit false, not keys elsewhere in the profile.
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
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
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
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
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
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      GOAT_APPLE_TEAM_ID: "ABC1234567",
      GOAT_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("preserves known passkey signing configuration errors at the build boundary", () => {
    const decodingCause = new Error("publishable-key-decode-failed");
    const knownError = new InvalidMacPasskeyPublishableKeyError({ cause: decodingCause });
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(knownError);

    assert.strictEqual(error, knownError);
    assert.instanceOf(error, InvalidMacPasskeyPublishableKeyError);
    assert.strictEqual(error.cause, decodingCause);
    assert.isTrue(isMacPasskeySigningConfigurationError(error));
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

  it.effect("uses the nightly DMG background for nightly macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20260815.1",
        false,
        false,
        undefined,
        undefined,
      );

      assert.equal(
        (config.dmg as Record<string, unknown>).background,
        "dmg/dmg-background-nightly.png",
      );
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("configures Windows executable metadata and native signing extensions", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.deepStrictEqual(win.signExts, [".node", ".dll"]);
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages the resource monitor as an external executable resource", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/cursor-sdk",
        to: "node_modules/@cursor",
      },
      {
        from: "apps/desktop/prod-resources/resource-monitor",
        to: "resource-monitor",
      },
      {
        from: "apps/desktop/prod-resources/LICENSE-T3CODE.txt",
        to: "LICENSE-T3CODE.txt",
      },
    ]);
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
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });

  it("ships the Linux CLI release archive as the WSL runtime", () => {
    assert.equal(WSL_RUNTIME_ARCHIVE_NAME, "wsl-runtime.tar.gz");
    assert.equal(WSL_RUNTIME_ARCHIVE_HASH_NAME, "wsl-runtime.tar.gz.sha256");
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz",
      to: "wsl-runtime.tar.gz",
    });
    assert.deepStrictEqual(WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE, {
      from: "apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
      to: "wsl-runtime.tar.gz.sha256",
    });
    // Both the staging and the packaging config hang off this one decision:
    // Windows only, and only when CI handed the build a Linux CLI archive.
    const runtimeArchivePath = "/tmp/goat-1.2.3-linux-x64.tar.gz";
    assert.isTrue(bundlesWslRuntime({ platform: "win", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "win", runtimeArchivePath: undefined }));
    assert.isFalse(bundlesWslRuntime({ platform: "linux", runtimeArchivePath }));
    assert.isFalse(bundlesWslRuntime({ platform: "mac", runtimeArchivePath }));
    assert.equal(wslRuntimeArchiveStem("1.2.3", "x64"), "goat-1.2.3-linux-x64");
  });

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
        // The digest both gates installation inside the distro and names the
        // extracted runtime's cache directory.
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  it.effect("fails when the Linux CLI archive handed to the build does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-wsl-runtime-missing-" });
        const error = yield* stageWslRuntimeArchive({
          sourceArchivePath: path.join(root, "goat-1.2.3-linux-x64.tar.gz"),
          archivePath: path.join(root, WSL_RUNTIME_ARCHIVE_NAME),
          hashPath: path.join(root, WSL_RUNTIME_ARCHIVE_HASH_NAME),
        }).pipe(Effect.flip);

        assert.instanceOf(error, WslRuntimeArchiveMissingError);
      }),
    ),
  );

  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
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
});

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the sidecar externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
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

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});

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
                `${stem}/resource-monitor/${key}/t3-resource-monitor`,
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
        buildVersion: mode === "override" ? Option.some("9.9.9") : Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
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
      mode === "override" ||
      mode === "env-override" ||
      mode === "preview-strict" ||
      mode === "ci-without-bundle";
    assert.equal(result._tag === "Failure", failed);
    if (result._tag === "Success") {
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
          extraMembers: [`${stem}/resource-monitor/${key}/t3-resource-monitor`],
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
          extraMembers: [`${stem}/resource-monitor/${key}/t3-resource-monitor`],
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
