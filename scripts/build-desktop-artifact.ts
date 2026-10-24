#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Node's typed junction API avoids Windows symlink privileges while keeping the probe isolated.

// Adopts legacy T3 env names before anything reads the environment.
import "@goat/contracts/adoptLegacyEnv";
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
// plist is CommonJS; Node cannot load its named exports from an ES module.
import Plist from "plist";

import {
  createPackageWithOptions,
  extractAll,
  getRawHeader,
  statFile,
  type DirectoryRecord,
} from "@electron/asar";

import { cliArchiveFileName, cliArchiveTarCommand, parseChecksums } from "@goat/shared/cliRelease";
import { fromYaml } from "@goat/shared/schemaYaml";
import * as HostProcess from "@goat/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@goat/shared/relayAuth";
import { isCommandAvailable, resolveSpawnCommand } from "@goat/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import gnomeCaptureBundle from "../apps/desktop/gnome-extension/bundle.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  ReleasePackageManifestError,
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions.ts";
import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";
import { stageDesktopComputerUseHelper } from "./lib/desktop-computer-use-helper.ts";

import { resolveBuildCommitTime } from "./lib/build-commit-time.ts";
import { resolveDesktopBuildIconAssets } from "./lib/desktop-icon-assets.ts";
export { resolveDesktopBuildIconAssets };
export type { DesktopBuildIconAssets } from "./lib/desktop-icon-assets.ts";
import {
  isPlainReleaseVersion,
  RELEASE_VERSION_STAMP_COMMAND,
  resolveDevBuildVersion,
} from "./lib/release-version.ts";
import { resolveWebAssetBrandForChannel, type WebAssetBrand } from "./lib/brand-assets.ts";
import { scanReleasePayload, writePayloadReport } from "./lib/release-verify.ts";
import {
  computerUseHelperEnvironment,
  computerUseHelperRefusal,
  signedComputerUseHelper,
  CuaDriverArtifactError,
  stageComputerUseHelper,
  stageCuaDriverExecutable,
  verifyEmbeddedComputerUseHelper,
  withComputerUseHelper,
} from "./desktop-artifact-computer-use.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import {
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
} from "./lib/cli-external-packages.ts";
import { loadRepoEnv } from "./lib/public-config.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
const DESKTOP_APP_ID = "si.goat.desktop";
const DESKTOP_UPDATE_REPOSITORY = "goat-si/goat-releases";
const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  packageExtensions: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        peerDependenciesMeta: Schema.Record(
          Schema.String,
          Schema.Struct({ optional: Schema.Boolean }),
        ),
      }),
    ),
  ),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

// electron-webauthn declares TypeScript as a peer only for its typings. pnpm
// auto-installs missing peers, which would ship a compiler inside the app.
const STAGE_PACKAGE_EXTENSIONS = {
  "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
  "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
} as const;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReleasePackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

export const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

export function resolveResourceMonitorRustTargets(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (platform === "mac") {
    if (arch === "universal") {
      return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    }
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    return [arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"];
  }
  return [arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"];
}

export function resourceMonitorExecutableName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "goat-resource-monitor.exe" : "goat-resource-monitor";
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly payloadReport?: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly computerUseHelper?: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
  readonly wslRuntime: Option.Option<string>;
  readonly sshRuntimeArchiveDir: Option.Option<string>;
  readonly requireAllSshRuntimes: Option.Option<boolean>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

const getDefaultArch = Effect.fn("getDefaultArch")(function* (platform: typeof BuildPlatform.Type) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  return yield* getDefaultBuildArch(platform, config);
});

export class MacPasskeySigningConfigurationResolutionError extends Schema.TaggedError<MacPasskeySigningConfigurationResolutionError>()(
  "MacPasskeySigningConfigurationResolutionError",
  {
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    cause: unknown,
  ): MacPasskeySigningConfigurationError | MacPasskeySigningConfigurationResolutionError {
    return isMacPasskeySigningConfigurationError(cause)
      ? cause
      : new MacPasskeySigningConfigurationResolutionError({ cause });
  }

  override get message(): string {
    return "Failed to resolve macOS passkey signing configuration.";
  }
}

export class KeyringNativePackageMissingError extends Schema.TaggedError<KeyringNativePackageMissingError>()(
  "KeyringNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Keyring native package is missing: ${this.packageName}`;
  }
}

export class ClerkPasskeyNativePackageMissingError extends Schema.TaggedError<ClerkPasskeyNativePackageMissingError>()(
  "ClerkPasskeyNativePackageMissingError",
  {
    packageName: Schema.String,
    binaryFileName: Schema.String,
    packageEntryPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk passkey native package is missing: ${this.packageName}`;
  }
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedError<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedError<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class DesktopBuildManifestRestoreError extends Schema.TaggedError<DesktopBuildManifestRestoreError>()(
  "DesktopBuildManifestRestoreError",
  { failures: Schema.Array(ReleasePackageManifestError) },
) {
  override get message(): string {
    return `Failed to restore release manifests: ${this.failures.map((failure) => failure.filePath).join(", ")}`;
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

export class VpNotFoundError extends Schema.TaggedError<VpNotFoundError>()("VpNotFoundError", {
  repoVpPath: Schema.String,
}) {
  override get message(): string {
    return `vp was not found at ${this.repoVpPath} or on PATH. Install dependencies with 'pnpm install', then run this script as 'pnpm run dist:desktop:artifact <flags>'.`;
  }
}

/**
 * The vp this script runs: the repository's own, else one on PATH. Running the
 * script as `node scripts/build-desktop-artifact.ts` leaves node_modules/.bin
 * off PATH, while filtered CI installs can skip the root package and rely on
 * the vp that setup-vp puts on PATH.
 */
export const resolveVp = Effect.fn("resolveVp")(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const repoVp = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    platform === "win32" ? "vp.cmd" : "vp",
  );
  if (yield* fs.exists(repoVp).pipe(Effect.orElseSucceed(() => false))) return repoVp;
  if (yield* isCommandAvailable("vp")) return "vp";
  return yield* new VpNotFoundError({ repoVpPath: repoVp });
});

export const LINUX_DESKTOP_BUILD_PREREQUISITES = [
  { id: "cargo", description: "Rust compiler and Cargo", packages: ["cargo", "rustc"] },
  { id: "rust-target", description: "Requested Rust standard library", packages: [] },
  { id: "cc", description: "C/C++ build toolchain", packages: ["build-essential"] },
  { id: "make", description: "Make", packages: ["build-essential"] },
  {
    id: "libsecret",
    description: "libsecret development headers and pkg-config",
    packages: ["libsecret-1-dev", "pkg-config"],
  },
  { id: "imagemagick", description: "ImageMagick", packages: ["imagemagick"] },
] as const;

export class LinuxDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<LinuxDesktopBuildPrerequisitesMissingError>()(
  "LinuxDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const missingRequirements = LINUX_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    );
    const details = missingRequirements
      .map((requirement) =>
        requirement.packages.length > 0
          ? `  - ${requirement.description} (${requirement.packages.join(", ")})`
          : `  - ${requirement.description}`,
      )
      .join("\n");
    const packages = [
      ...new Set(missingRequirements.flatMap((requirement) => requirement.packages)),
    ];
    return [
      "Linux desktop build prerequisites are missing:",
      details,
      "",
      ...(packages.length > 0
        ? ["On Ubuntu/Debian, install them with:", `  sudo apt-get install ${packages.join(" ")}`]
        : []),
      ...(this.missing.includes("rust-target")
        ? ["Add the requested Rust target with:", `  rustup target add ${this.rustTarget}`]
        : []),
      "",
      "For other distributions, see docs/operations/development.md#linux-appimage-prerequisites.",
      "Then rerun `vp run dist:desktop:linux`.",
    ].join("\n");
  }
}

const MAC_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested Rust target" },
  { id: "clang", description: "Xcode Command Line Tools (clang)" },
  { id: "make", description: "Xcode Command Line Tools (make)" },
  { id: "sips", description: "macOS image tool (sips)" },
  { id: "iconutil", description: "macOS icon tool (iconutil)" },
  { id: "lipo", description: "Xcode universal-binary tool (lipo)" },
] as const;

export class MacDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<MacDesktopBuildPrerequisitesMissingError>()(
  "MacDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTargets: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const details = MAC_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "macOS desktop build prerequisites are missing:",
      details,
      "",
      "Install Apple's build tools with:",
      "  xcode-select --install",
      "Install Rust from https://rustup.rs, then add the requested target(s):",
      `  rustup target add ${this.rustTargets.join(" ")}`,
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

const WINDOWS_DESKTOP_BUILD_PREREQUISITES = [
  { id: "rust", description: "Rust/Cargo and the requested MSVC Rust target" },
  { id: "python", description: "Python 3 for node-gyp" },
  {
    id: "msvc",
    description: "Visual Studio Build Tools with C++, Windows SDK, and Spectre libraries",
  },
  {
    id: "tar",
    description: "tar.exe to extract Cua Driver and inspect the bundled WSL runtime archive",
  },
] as const;

export class WindowsDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<WindowsDesktopBuildPrerequisitesMissingError>()(
  "WindowsDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
    rustTarget: Schema.String,
  },
) {
  override get message(): string {
    const details = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    )
      .map((requirement) => `  - ${requirement.description}`)
      .join("\n");
    return [
      "Windows desktop build prerequisites are missing:",
      details,
      "",
      "Install Rust from https://rustup.rs and add the requested target:",
      `  rustup target add ${this.rustTarget}`,
      "Install Python 3 and the Visual Studio Build Tools components listed in",
      "docs/operations/development.md#windows-installer-prerequisites.",
      "",
      "Then rerun the desktop artifact command.",
    ].join("\n");
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedError<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

const desktopIconPlatformNames = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class LinuxBrowserSecretHostError extends Schema.TaggedError<LinuxBrowserSecretHostError>()(
  "LinuxBrowserSecretHostError",
  { hostPlatform: Schema.String },
) {
  override get message(): string {
    return `Linux desktop builds must run on a Linux host: the browser secret helper links against libsecret and cannot be built on '${this.hostPlatform}'.`;
  }
}

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedError<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literals(["latest", "nightly"]),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedError<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;
const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedError<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);
type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;
const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the sidecar's selected runtime closure does not cover.
 */
const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

const BUNDLE_SELF_CHECK_TIMEOUT = Duration.seconds(120);
const WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT = Duration.seconds(30);

const WINDOWS_PRIMARY_FFF_PROBE_SOURCE = `
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { FileFinder } = await import(pathToFileURL(process.argv[1]).href);
const probeRoot = process.argv[2];
const result = FileFinder.create({
  basePath: probeRoot,
  frecencyDbPath: join(probeRoot, "frecency.mdb"),
  historyDbPath: join(probeRoot, "history.mdb"),
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
});
if (!result.ok) throw new Error(result.error);
result.value.destroy();
`;

export class ExternalizedBundleError extends Schema.TaggedError<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the runtime externals; if its dependencies are external again they will be absent from the sidecar, and the backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class BundleNotSelfContainedError extends Schema.TaggedError<BundleNotSelfContainedError>()(
  "BundleNotSelfContainedError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return `The packaged server bundle could not load from the isolated, extracted sidecar (exit ${this.exitCode}). Anything it imports that is neither a Node built-in nor in the selected runtime-external closure is unavailable to both backends. Output:
${this.output}`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedError<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and are staged in the sidecar.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedError<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedError<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class WslRuntimeArchiveMissingError extends Schema.TaggedError<WslRuntimeArchiveMissingError>()(
  "WslRuntimeArchiveMissingError",
  {
    archivePath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL runtime archive not found at ${this.archivePath}.`;
  }
}

export class WindowsServerSidecarPackError extends Schema.TaggedError<WindowsServerSidecarPackError>()(
  "WindowsServerSidecarPackError",
  {
    asarPath: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to pack the Windows server sidecar at ${this.asarPath}.`;
  }
}

export class WindowsPrimaryNativeProbeError extends Schema.TaggedError<WindowsPrimaryNativeProbeError>()(
  "WindowsPrimaryNativeProbeError",
  {
    executablePath: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `The packaged Windows primary could not load fff from server.asar (exit ${this.exitCode}). Output:\n${this.output}`;
  }
}

const WindowsPackagedPayloadValidationReason = Schema.Literals([
  "packaged-app-missing",
  "sidecar-missing",
  "sidecar-invalid",
  "unpacked-native-missing",
  "resource-monitor-missing",
  "wsl-runtime-missing",
  "wsl-runtime-invalid",
  "file-limit-exceeded",
]);

export class WindowsPackagedPayloadValidationError extends Schema.TaggedError<WindowsPackagedPayloadValidationError>()(
  "WindowsPackagedPayloadValidationError",
  {
    reason: WindowsPackagedPayloadValidationReason,
    packagedAppDir: Schema.String,
    missingFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    fileCount: Schema.optionalKey(Schema.Int),
    fileLimit: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "file-limit-exceeded") {
      return `Windows packaged payload contains ${String(this.fileCount)} files; expected at most ${String(this.fileLimit)}.`;
    }
    if (this.reason === "unpacked-native-missing") {
      return `Windows server sidecar is missing ${String(this.missingFiles?.length ?? 0)} unpacked native files.`;
    }
    if (this.reason === "resource-monitor-missing") {
      return "Windows packaged payload is missing the resource monitor executable.";
    }
    if (this.reason === "wsl-runtime-missing") {
      return "Windows packaged payload is missing the WSL runtime archive or SHA-256 sidecar.";
    }
    if (this.reason === "wsl-runtime-invalid") {
      return "Windows packaged payload contains an invalid WSL runtime archive.";
    }
    if (this.reason === "sidecar-invalid") {
      return "Windows packaged payload contains an invalid server.asar sidecar.";
    }
    if (this.reason === "sidecar-missing") {
      return "Windows packaged payload is missing resources/server.asar.";
    }
    return `Windows packaged application directory was not found at ${this.packagedAppDir}.`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedError<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

const resolvePythonForNodeGyp = Effect.fn("resolvePythonForNodeGyp")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const env = yield* Config.all({
    configuredPython: Config.String("npm_config_python").pipe(
      Config.orElse(() => Config.String("PYTHON")),
      Config.option,
    ),
    localAppData: Config.String("LOCALAPPDATA").pipe(Config.option),
  });
  const isPython3 = (candidate: string) =>
    spawnAndCollectOutput(
      ChildProcess.make(candidate, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)",
      ]),
    ).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );
  const configured = Option.getOrUndefined(env.configuredPython);
  if (configured && (yield* fs.exists(configured)) && (yield* isPython3(configured))) {
    return configured;
  }

  if (hostPlatform === "win32") {
    const localAppData = Option.getOrUndefined(env.localAppData);
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = path.join(localAppData, "Programs", "Python", version, "python.exe");
        if ((yield* fs.exists(candidate)) && (yield* isPython3(candidate))) {
          return candidate;
        }
      }
    }
  }

  const probe = yield* spawnAndCollectOutput(
    ChildProcess.make("python", ["-c", "import sys;print(sys.executable)"]),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (probe.exitCode !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !(yield* fs.exists(executable)) || !(yield* isPython3(executable))) {
    return undefined;
  }

  return executable;
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string;
  readonly outputDir: string;
  readonly payloadReport: string | undefined;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly computerUseHelper: boolean;
  readonly macPasskeys: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
  readonly wslRuntime: string | undefined;
  readonly sshRuntimeArchiveDir: string | undefined;
  readonly requireAllSshRuntimes: boolean;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly t3codeWebAuthn?: MacWebAuthnEntitlements;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // Cursor finds platform assets by walking up from argv[1]. Keep them outside
  // asar so spawning helpers and loading native addons both use real paths.
  "!**/node_modules/@cursor/sdk-*/**/*",
  "!apps/desktop/prod-resources/cursor-sdk",
  "!apps/desktop/prod-resources/cursor-sdk/**/*",
  // The resource monitor ships once at resources/resource-monitor, signed with the
  // app; a second copy inside app.asar would stay ad hoc signed.
  "!apps/desktop/prod-resources/resource-monitor",
  "!apps/desktop/prod-resources/resource-monitor/**/*",
  // GOAT always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/desktop/resources/browser-secret",
  "!apps/desktop/resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/browser-secret",
  "!apps/desktop/prod-resources/browser-secret/**/*",
  // Windows stages the server sidecar below prod-resources so electron-builder
  // can copy it using project-relative extraResources matchers. Keep those
  // staging inputs out of app.asar; they are emitted once at resources/.
  "!apps/desktop/prod-resources/windows-server",
  "!apps/desktop/prod-resources/windows-server/**/*",
  "!apps/desktop/prod-resources/ssh-runtime",
  "!apps/desktop/prod-resources/ssh-runtime/**/*",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
  "!apps/desktop/prod-resources/LICENSE-T3CODE.txt",
  "!apps/desktop/gnome-extension",
  "!apps/desktop/gnome-extension/**/*",
  "!apps/desktop/prod-resources/cua-driver",
  "!apps/desktop/prod-resources/cua-driver/**/*",
  "!apps/desktop/resources/cua-driver",
  "!apps/desktop/resources/cua-driver/**/*",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
export const MAC_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
// Linux builds node-pty from source, so every prebuild in the package is for
// another platform (58 MB of it Windows debug symbols).
export const LINUX_FILE_EXCLUSIONS = [
  ...MAC_FILE_EXCLUSIONS,
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
] as const;

// node-pty publishes both Darwin prebuilds in one package. Single-architecture
// apps only need the native target; universal apps need both.
export function resolveMacFileExclusions(arch?: typeof BuildArch.Type) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/node-pty/prebuilds/darwin-${unusedArch}/**/*`];
}
// Windows ships the server tree (bundle + node_modules) as a separate
// resources/server.asar sidecar instead of loose files: the NSIS installer then
// extracts a handful of large archives instead of thousands of small files,
// which dominates install (and update) time.
export const WINDOWS_SERVER_ASAR_RESOURCE = "server.asar";
// dlopen/spawn need real files, so native modules, shared libraries, and
// helper executables live in each archive's .unpacked sibling (the standard
// asar redirect convention). Everything else stays packed.
export const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";
export const WINDOWS_SERVER_ASAR_UNPACK_GLOBS = [
  "**/*.dll",
  "**/*.exe",
  "**/*.so",
  "**/*.so.*",
  "**/*.dylib",
] as const;
// Mirrors DESKTOP_FILE_EXCLUSIONS for the hand-packed sidecar: the Claude SDK
// platform packages are dead weight (see above), and node_modules/.bin shims
// are never spawned at runtime (and are symlinks on POSIX build hosts, which
// the asar extraction path deliberately does not support).
export const WINDOWS_SERVER_ASAR_IGNORE_GLOBS = [
  "**/node_modules/@cursor/sdk-*",
  "**/node_modules/@cursor/sdk-*/**",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
  "**/*.map",
] as const;

export function resolveWindowsServerAsarIgnoreGlobs(arch: typeof BuildArch.Type) {
  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  const unusedPrebuild = `**/node_modules/node-pty/prebuilds/win32-${unusedArch}`;
  const unusedConpty = `**/node_modules/node-pty/third_party/conpty/*/win10-${unusedArch}`;

  return [
    ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
    unusedPrebuild,
    `${unusedPrebuild}/**`,
    unusedConpty,
    `${unusedConpty}/**`,
  ];
}

export const WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT = 80;
export const WINDOWS_SERVER_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/windows-server";
export const WINDOWS_SERVER_EXTRA_RESOURCES = [
  {
    from: WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
    to: ".",
    filter: [WINDOWS_SERVER_ASAR_RESOURCE, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/**/*`],
  },
] as const;
export const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
export const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
export const WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_NAME,
} as const;
export const WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${WSL_RUNTIME_ARCHIVE_HASH_NAME}`,
  to: WSL_RUNTIME_ARCHIVE_HASH_NAME,
} as const;

export const bundlesWslRuntime = (input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly runtimeArchivePath: string | undefined;
}): boolean => input.platform === "win" && input.runtimeArchivePath !== undefined;

export const WSL_RUNTIME_EXTRA_RESOURCES = [
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
] as const;
export const DESKTOP_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/cua-driver", to: "cua-driver" },
  {
    from: "apps/desktop/prod-resources/cursor-sdk",
    to: "node_modules/@cursor",
  },
  {
    from: "apps/desktop/prod-resources/resource-monitor",
    to: "resource-monitor",
  },
  // Upstream T3 Code's MIT notice ships with every GOAT app (staged from LICENSE).
  {
    from: "apps/desktop/prod-resources/LICENSE-T3CODE.txt",
    to: "LICENSE-T3CODE.txt",
  },
] as const;
export const LINUX_CAPTURE_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/hyprland-capture",
    to: "hyprland-capture",
  },
  {
    from: "apps/desktop/prod-resources/kde-capture",
    to: "kde-capture",
  },
  {
    from: "apps/desktop/gnome-extension",
    to: "gnome-extension",
    filter: gnomeCaptureBundle.files,
  },
] as const;
export const LINUX_BROWSER_SECRET_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
] as const;

export interface MacPasskeySigningConfiguration {
  readonly appId: string;
  readonly teamId: string;
  readonly rpDomains: readonly string[];
  readonly provisioningProfilePath: string;
}

export const InvalidMacPasskeyRpDomainReason = Schema.Literals([
  "empty",
  "scheme-not-allowed",
  "parse-failed",
  "credentials-not-allowed",
  "port-not-allowed",
  "path-not-allowed",
  "query-not-allowed",
  "fragment-not-allowed",
  "hostname-mismatch",
]);
export type InvalidMacPasskeyRpDomainReason = typeof InvalidMacPasskeyRpDomainReason.Type;

export class InvalidMacPasskeyRpDomainError extends Schema.TaggedError<InvalidMacPasskeyRpDomainError>()(
  "InvalidMacPasskeyRpDomainError",
  {
    reason: InvalidMacPasskeyRpDomainReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Invalid passkey RP domain (${this.reason}).`;
  }
}

export class InvalidAppleTeamIdError extends Schema.TaggedError<InvalidAppleTeamIdError>()(
  "InvalidAppleTeamIdError",
  {
    teamId: Schema.String,
  },
) {
  override get message(): string {
    return `GOAT_APPLE_TEAM_ID '${this.teamId}' must be a 10-character Apple Developer Team ID.`;
  }
}

export class MissingMacPasskeyProvisioningProfileError extends Schema.TaggedError<MissingMacPasskeyProvisioningProfileError>()(
  "MissingMacPasskeyProvisioningProfileError",
  {},
) {
  override get message(): string {
    return "GOAT_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.";
  }
}

export class MissingMacPasskeyDomainConfigurationError extends Schema.TaggedError<MissingMacPasskeyDomainConfigurationError>()(
  "MissingMacPasskeyDomainConfigurationError",
  {},
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY or T3CODE_CLERK_PASSKEY_RP_DOMAINS is required for signed macOS passkey builds.";
  }
}

export class InvalidMacPasskeyPublishableKeyError extends Schema.TaggedError<InvalidMacPasskeyPublishableKeyError>()(
  "InvalidMacPasskeyPublishableKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.";
  }
}

export class MissingMacPasskeyRpDomainError extends Schema.TaggedError<MissingMacPasskeyRpDomainError>()(
  "MissingMacPasskeyRpDomainError",
  {},
) {
  override get message(): string {
    return "At least one Clerk passkey RP domain is required.";
  }
}

export const MacPasskeySigningConfigurationError = Schema.Union([
  InvalidMacPasskeyRpDomainError,
  InvalidAppleTeamIdError,
  MissingMacPasskeyProvisioningProfileError,
  MissingMacPasskeyDomainConfigurationError,
  InvalidMacPasskeyPublishableKeyError,
  MissingMacPasskeyRpDomainError,
]);
export type MacPasskeySigningConfigurationError = typeof MacPasskeySigningConfigurationError.Type;
export const isMacPasskeySigningConfigurationError = Schema.is(MacPasskeySigningConfigurationError);

function normalizePasskeyRpDomain(value: string): string {
  const normalized = value.trim().toLowerCase();
  const inputLength = value.length;
  if (normalized.length === 0) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "empty", inputLength });
  }
  if (/^[a-z][a-z\d+.-]*:\/\//u.test(normalized)) {
    throw new InvalidMacPasskeyRpDomainError({
      reason: "scheme-not-allowed",
      inputLength,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch (cause) {
    throw new InvalidMacPasskeyRpDomainError({ reason: "parse-failed", inputLength, cause });
  }

  let reason: InvalidMacPasskeyRpDomainReason | undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    reason = "credentials-not-allowed";
  } else if (parsed.port.length > 0) {
    reason = "port-not-allowed";
  } else if (parsed.pathname !== "/") {
    reason = "path-not-allowed";
  } else if (parsed.search.length > 0) {
    reason = "query-not-allowed";
  } else if (parsed.hash.length > 0) {
    reason = "fragment-not-allowed";
  } else if (parsed.host !== normalized) {
    reason = "hostname-mismatch";
  }
  if (reason) {
    throw new InvalidMacPasskeyRpDomainError({ reason, inputLength });
  }

  return parsed.hostname;
}

export function resolveMacPasskeySigningConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  appId = DESKTOP_APP_ID,
): MacPasskeySigningConfiguration {
  const teamId = env.GOAT_APPLE_TEAM_ID?.trim().toUpperCase() ?? "";
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new InvalidAppleTeamIdError({ teamId });
  }

  const provisioningProfilePath = env.GOAT_MACOS_PROVISIONING_PROFILE?.trim() ?? "";
  if (provisioningProfilePath.length === 0) {
    throw new MissingMacPasskeyProvisioningProfileError();
  }

  const configuredRpDomains = env.T3CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  let rpDomains: readonly string[];
  if (configuredRpDomains) {
    rpDomains = configuredRpDomains.split(",").map(normalizePasskeyRpDomain);
  } else {
    const publishableKey = env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim();
    if (!publishableKey) {
      throw new MissingMacPasskeyDomainConfigurationError();
    }
    let hostname: string;
    try {
      hostname = clerkFrontendApiHostnameFromPublishableKey(publishableKey);
    } catch (cause) {
      throw new InvalidMacPasskeyPublishableKeyError({ cause });
    }
    rpDomains = [normalizePasskeyRpDomain(hostname)];
  }

  const uniqueRpDomains = [...new Set(rpDomains)];
  if (uniqueRpDomains.length === 0) {
    throw new MissingMacPasskeyRpDomainError();
  }

  return {
    appId,
    teamId,
    rpDomains: uniqueRpDomains,
    provisioningProfilePath,
  };
}

export function resolveOptionalMacPasskeySigningConfiguration(
  input: {
    readonly platform: typeof BuildPlatform.Type;
    readonly signed: boolean;
    readonly macPasskeys: boolean;
    readonly version: string;
  },
  env: Readonly<Record<string, string | undefined>>,
): MacPasskeySigningConfiguration | undefined {
  if (input.platform !== "mac" || !input.signed || !input.macPasskeys) return undefined;
  return resolveMacPasskeySigningConfiguration(env, resolveDesktopAppId(input.version));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Passkey entitlements for the in-app browser. Each is granted only when the
 * provisioning profile authorizes it: macOS refuses to launch an app that
 * claims a restricted entitlement its embedded profile does not carry.
 */
export interface MacWebAuthnEntitlements {
  readonly touchIdKeychainAccessGroup: string | undefined;
  readonly browserPasskeys: boolean;
}

const BROWSER_PASSKEYS_ENTITLEMENT = "com.apple.developer.web-browser.public-key-credential";

const ProvisioningProfilePlist = Schema.Struct({
  Entitlements: Schema.Struct({
    "keychain-access-groups": Schema.optional(Schema.Array(Schema.String)),
    [BROWSER_PASSKEYS_ENTITLEMENT]: Schema.optional(Schema.Boolean),
  }),
});
const isProvisioningProfilePlist = Schema.is(ProvisioningProfilePlist);

const readProfileEntitlements = (provisioningProfile: string) => {
  const start = provisioningProfile.indexOf("<?xml");
  const end = provisioningProfile.indexOf("</plist>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    const profile: unknown = Plist.parse(provisioningProfile.slice(start, end + "</plist>".length));
    return isProvisioningProfilePlist(profile) ? profile.Entitlements : undefined;
  } catch {
    return undefined;
  }
};

export function resolveMacWebAuthnEntitlements(
  provisioningProfile: string,
  configuration: Pick<MacPasskeySigningConfiguration, "appId" | "teamId">,
): MacWebAuthnEntitlements {
  const entitlements = readProfileEntitlements(provisioningProfile);
  const keychainAccessGroup = `${configuration.teamId}.${configuration.appId}.webauthn`;
  const keychainGroupAuthorized = (entitlements?.["keychain-access-groups"] ?? []).some((group) =>
    group.endsWith("*")
      ? keychainAccessGroup.startsWith(group.slice(0, -1))
      : group === keychainAccessGroup,
  );
  return {
    touchIdKeychainAccessGroup: keychainGroupAuthorized ? keychainAccessGroup : undefined,
    browserPasskeys: entitlements?.[BROWSER_PASSKEYS_ENTITLEMENT] === true,
  };
}

export function renderMacPasskeyEntitlements(
  configuration: MacPasskeySigningConfiguration,
  webAuthn: MacWebAuthnEntitlements,
): string {
  const associatedDomains = configuration.rpDomains
    .map((domain) => `      <string>webcredentials:${escapeXml(domain)}</string>`)
    .join("\n");
  const keychainAccessGroups = webAuthn.touchIdKeychainAccessGroup
    ? `
    <key>keychain-access-groups</key>
    <array>
      <string>${escapeXml(webAuthn.touchIdKeychainAccessGroup)}</string>
    </array>`
    : "";
  const browserPasskeys = webAuthn.browserPasskeys
    ? `
    <key>${BROWSER_PASSKEYS_ENTITLEMENT}</key>
    <true/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.application-identifier</key>
    <string>${escapeXml(`${configuration.teamId}.${configuration.appId}`)}</string>
    <key>com.apple.developer.team-identifier</key>
    <string>${escapeXml(configuration.teamId)}</string>
    <key>com.apple.developer.associated-domains</key>
    <array>
${associatedDomains}
    </array>${keychainAccessGroups}${browserPasskeys}
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- The hardened runtime denies camera and microphone to the app and every
         child process, with no prompt, unless the app claims these. Terminals
         and coding agents inherit the app's TCC identity, so without these a
         command like ffmpeg or imagesnap gets silent access-denied. -->
    <key>com.apple.security.device.camera</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
  </dict>
</plist>
`;
}

export function resolveFffNativeDependencies(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

// macOS and Linux run both processes from one app.asar, so the stage installs
// the union of what each bundle leaves external and nothing else.
export function resolveMergedStageDependencies(input: {
  readonly platform: "mac" | "linux";
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: typeof BuildArch.Type;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliRuntimeExternalDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies(input.platform, input.arch, input.fffNodeVersion),
  };
}

/** Cursor's helper lookup falls through the archive to this real resources tree. */
export const stageCursorSdkPlatformPackages = Effect.fn("stageCursorSdkPlatformPackages")(
  function* (nodeModulesDir: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(destination, { recursive: true });
    const sdkDirectory = path.join(nodeModulesDir, "@cursor/sdk");
    if (!(yield* fs.exists(sdkDirectory))) return;
    const cursorDirectory = path.dirname(yield* fs.realPath(sdkDirectory));
    for (const name of yield* fs.readDirectory(cursorDirectory)) {
      if (!name.startsWith("sdk-")) continue;
      const source = yield* fs.realPath(path.join(cursorDirectory, name));
      yield* fs.copy(source, path.join(destination, name));
    }
  },
);

export interface ClerkPasskeyNativeArtifact {
  readonly packageName: string;
  readonly binaryFileName: string;
}

export function resolveClerkPasskeyNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-darwin-${architecture}`,
      binaryFileName: `electron-passkeys.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@clerk/electron-passkeys-win32-${architecture}-msvc`,
      binaryFileName: `electron-passkeys.win32-${architecture}-msvc.node`,
    }));
  }

  return [];
}

export function resolveKeyringNativeArtifacts(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): readonly ClerkPasskeyNativeArtifact[] {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-darwin-${architecture}`,
      binaryFileName: `keyring.darwin-${architecture}.node`,
    }));
  }

  if (platform === "win") {
    return architectures.map((architecture) => ({
      packageName: `@napi-rs/keyring-win32-${architecture}-msvc`,
      binaryFileName: `keyring.win32-${architecture}-msvc.node`,
    }));
  }

  return architectures.map((architecture) => ({
    packageName: `@napi-rs/keyring-linux-${architecture}-gnu`,
    binaryFileName: `keyring.linux-${architecture}-gnu.node`,
  }));
}

/**
 * Same nesting problem as the Clerk passkey binaries: pnpm keeps the platform
 * package under `@napi-rs/keyring`, electron-builder only retains collected
 * top-level dependencies, and the generated loader checks for a sibling
 * `keyring.<platform>.node` before falling back to the package. Staging the
 * binary beside `index.js` lets that first branch win.
 */
const stageKeyringNativeBinaries = Effect.fn("stageKeyringNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@napi-rs", "keyring", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveKeyringNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(`${artifact.packageName}/${artifact.binaryFileName}`),
      catch: (cause) =>
        new KeyringNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

// pnpm nests the architecture package under @clerk/electron-passkeys, while electron-builder only
// retains collected top-level dependencies. The SDK loader checks beside index.js first, so stage
// the binary there and let electron-builder's native-addon handling unpack it from the ASAR.
const stageClerkPasskeyNativeBinaries = Effect.fn("stageClerkPasskeyNativeBinaries")(function* (
  stageAppDir: string,
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageEntryPath = yield* fs.realPath(
    path.join(stageAppDir, "node_modules", "@clerk", "electron-passkeys", "index.js"),
  );
  const packageDir = path.dirname(packageEntryPath);
  const packageRequire = NodeModule.createRequire(packageEntryPath);

  for (const artifact of resolveClerkPasskeyNativeArtifacts(platform, arch)) {
    const sourcePath = yield* Effect.try({
      try: () => packageRequire.resolve(artifact.packageName),
      catch: (cause) =>
        new ClerkPasskeyNativePackageMissingError({
          packageName: artifact.packageName,
          binaryFileName: artifact.binaryFileName,
          packageEntryPath,
          platform,
          arch,
          cause,
        }),
    });
    yield* fs.copyFile(sourcePath, path.join(packageDir, artifact.binaryFileName));
  }
});

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];
  // Linux AppImages execute a Linux/glibc Node process that loads
  // Linux-native optional deps at runtime. Keep libc explicit so pnpm
  // includes those optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : {
          os: [hostOs],
          cpu: hostCpu,
        };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    packageExtensions: STAGE_PACKAGE_EXTENSIONS,
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) => {
      const name = getPatchedDependencyPackageName(patchKey);
      // The Cua SDK's transitive loader needs the ASAR path fix too.
      return (
        Object.hasOwn(dependencies, name) ||
        (name === "@ubjs/node" && Object.hasOwn(dependencies, "@trycua/cua-driver"))
      );
    }),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.String("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.String("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.String("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "GOAT_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("GOAT_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "GOAT_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("GOAT_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("GOAT_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  payloadReport: Config.String("GOAT_DESKTOP_PAYLOAD_REPORT").pipe(Config.option),
  skipBuild: Config.Boolean("GOAT_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("GOAT_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.Boolean("GOAT_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  computerUseHelper: Config.Boolean("GOAT_DESKTOP_COMPUTER_USE_HELPER").pipe(
    Config.withDefault(false),
  ),
  macPasskeys: Config.Boolean("GOAT_DESKTOP_MAC_PASSKEYS").pipe(Config.withDefault(false)),
  verbose: Config.Boolean("GOAT_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.Boolean("GOAT_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.String("GOAT_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  wslRuntime: Config.String("GOAT_DESKTOP_WSL_RUNTIME").pipe(Config.option),
  sshRuntimeArchiveDir: Config.String("GOAT_DESKTOP_SSH_RUNTIME_ARCHIVE_DIR").pipe(Config.option),
  requireAllSshRuntimes: Config.Boolean("GOAT_DESKTOP_REQUIRE_ALL_SSH_RUNTIMES").pipe(
    Config.withDefault(false),
  ),
  ci: Config.Boolean("CI").pipe(Config.withDefault(false)),
  // Standalone previews have no sibling archive producers. A supplied bundle
  // still requires all targets in CI, even when omission is explicitly allowed.
  sshRuntimeBundleOptional: Config.Boolean("GOAT_DESKTOP_SSH_RUNTIME_BUNDLE_OPTIONAL").pipe(
    Config.withDefault(false),
  ),
});

const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
const decodeMockUpdateServerPort = Schema.decodeUnknownEffect(MockUpdateServerPortSchema);

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);
  if (!Number.isFinite(parsed)) return "not-numeric";
  if (!Number.isInteger(parsed)) return "not-integer";
  if (parsed < 1 || parsed > 65535) return "out-of-range";
  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* decodeMockUpdateServerPort(port);
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcess.Platform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const defaultArch = yield* getDefaultArch(platform);
  const arch = mergeOptions(input.arch, env.arch, defaultArch);
  const supportedArchitectures = PLATFORM_CONFIG[platform].archChoices;
  if (!supportedArchitectures.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...supportedArchitectures],
    });
  }
  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const version = yield* resolveDesktopBuildVersion({
    explicitVersion: mergeOptions(input.buildVersion, env.version, undefined),
    packageVersion: serverPackageJson.version,
    ci: env.ci,
    skipBuild,
    repoRoot,
  });
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const computerUseHelper = resolveBooleanFlag(
    input.computerUseHelper ?? Option.none(),
    env.computerUseHelper,
  );
  const helperRefusal = computerUseHelper && computerUseHelperRefusal({ platform, signed });
  if (helperRefusal) return yield* new CuaDriverArtifactError({ message: helperRefusal });
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const configuredMockUpdateServerPort = Option.getOrUndefined(env.mockUpdateServerPort);
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (configuredMockUpdateServerPort === undefined
      ? undefined
      : yield* resolveMockUpdateServerPort(configuredMockUpdateServerPort).pipe(
          Effect.mapError((cause) =>
            InvalidMockUpdateServerPortError.fromConfigValue(configuredMockUpdateServerPort, cause),
          ),
        ));

  const wslRuntime =
    Option.getOrUndefined(input.wslRuntime) ?? Option.getOrUndefined(env.wslRuntime);

  const sshRuntimeArchiveDir =
    (
      Option.getOrUndefined(input.sshRuntimeArchiveDir) ??
      Option.getOrUndefined(env.sshRuntimeArchiveDir)
    )?.trim() || undefined;
  const requireAllSshRuntimes =
    (env.ci && (!env.sshRuntimeBundleOptional || sshRuntimeArchiveDir !== undefined)) ||
    resolveBooleanFlag(input.requireAllSshRuntimes, env.requireAllSshRuntimes);
  if (requireAllSshRuntimes && sshRuntimeArchiveDir === undefined) {
    return yield* new SshRuntimeArchiveValidationError({
      message:
        "CI/release desktop packaging requires --ssh-runtime-archive-dir with darwin-arm64, linux-x64 and linux-arm64 archives.",
    });
  }

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    payloadReport:
      Option.getOrUndefined(input.payloadReport ?? Option.none()) ??
      Option.getOrUndefined(env.payloadReport),
    skipBuild,
    keepStage,
    signed,
    computerUseHelper,
    macPasskeys: env.macPasskeys,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
    wslRuntime,
    sshRuntimeArchiveDir,
    requireAllSshRuntimes,
  } satisfies ResolvedBuildOptions;
});

export class DesktopBuildVersionError extends Schema.TaggedError<DesktopBuildVersionError>()(
  "DesktopBuildVersionError",
  { message: Schema.String },
) {}

/**
 * The one version this build stamps into the desktop bundle, the server it packages and any
 * bundled runtime (docs/internals/release-channels.md#version-rule). An explicit --build-version wins.
 * CI release jobs stamp the manifests before building, so they package the manifest version.
 * A local build of a plain x.y.z becomes `<base>-dev.<commit time>.g<sha>`: only the published
 * stable may report the bare base, or SSH remotes go looking for a release that does not exist.
 */
export const resolveDesktopBuildVersion = Effect.fn("resolveDesktopBuildVersion")(
  function* (input: {
    readonly explicitVersion: string | undefined;
    readonly packageVersion: string;
    readonly ci: boolean;
    readonly skipBuild: boolean;
    readonly repoRoot: string;
  }) {
    let version = input.explicitVersion?.trim() || undefined;
    if (version === undefined) {
      if (input.ci || !isPlainReleaseVersion(input.packageVersion)) {
        version = input.packageVersion;
      } else {
        version = resolveDevBuildVersion({
          baseVersion: input.packageVersion,
          commitTime: resolveBuildCommitTime(input.repoRoot),
          commitSha: yield* resolveGitCommitHash(input.repoRoot),
        });
        if (version === undefined) {
          return yield* new DesktopBuildVersionError({
            message: `A local build of ${input.packageVersion} needs git commit metadata to get its dev version, and must not claim the published stable ${input.packageVersion}. Pass --build-version <version>.`,
          });
        }
      }
    }
    if (input.skipBuild && version !== input.packageVersion) {
      return yield* new DesktopBuildVersionError({
        message: `--skip-build packages the server already built from apps/server/package.json (${input.packageVersion}), so the desktop bundle cannot be ${version}. Run \`${RELEASE_VERSION_STAMP_COMMAND} ${version}\` before building the JS bundle, or drop --skip-build so this build stamps it.`,
      });
    }
    return version;
  },
);

/** The version in `goat --version` output (`goat v0.1.0-nightly.20261012.1`). */
export const parseServerVersionOutput = (output: string): string | undefined =>
  /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(output.trim())?.[1];

/**
 * Keeps every release manifest at `version` for the duration of the scope, so the server,
 * web and desktop bundles built inside it report the version the desktop bundle carries.
 * The original manifests are restored when the scope closes.
 */
export const stampReleaseVersionForBuild = Effect.fn("stampReleaseVersionForBuild")(function* (
  repoRoot: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.acquireRelease(
    Effect.forEach(releasePackageFiles, (file) =>
      fs
        .readFileString(path.join(repoRoot, file))
        .pipe(Effect.map((text) => [file, text] as const)),
    ),
    (originals) =>
      Effect.forEach(
        originals,
        ([file, text]) => fs.writeFileString(path.join(repoRoot, file), text),
        { discard: true },
      ).pipe(Effect.orDie),
  );
  yield* updateReleasePackageVersions(version, { rootDir: repoRoot });
  yield* Effect.log(
    `[desktop-artifact] Stamped ${version} into the release manifests for this build.`,
  );
});

/**
 * Runs the built server's `--version` and fails unless it reports the desktop bundle's
 * version. This is the packaging check for #339: a desktop-only version override used to ship
 * a server reporting the bare base, so every SSH remote asked for a release that did not exist.
 */
const verifyBuiltServerVersion = Effect.fn("verifyBuiltServerVersion")(function* (input: {
  readonly serverDist: string;
  readonly expectedVersion: string;
}) {
  const path = yield* Path.Path;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make(process.execPath, [path.join(input.serverDist, "bin.mjs"), "--version"], {
      cwd: path.dirname(input.serverDist),
    }),
  ).pipe(
    Effect.timeout(BUNDLE_SELF_CHECK_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new DesktopBuildVersionError({
          message: `Could not run the built server to read its version: ${String(cause)}`,
        }),
    ),
  );
  const reported = result.exitCode === 0 ? parseServerVersionOutput(result.stdout) : undefined;
  if (reported !== input.expectedVersion) {
    return yield* new DesktopBuildVersionError({
      message: `The built server reports ${reported ?? `no version (exit ${String(result.exitCode)}: ${`${result.stderr}${result.stdout}`.trim().slice(-400)})`} but this desktop bundle is ${input.expectedVersion}. Both must carry one version (docs/internals/release-channels.md#version-rule): run \`${RELEASE_VERSION_STAMP_COMMAND} ${input.expectedVersion}\` before building the JS bundle.`,
    });
  }
  yield* Effect.log(`[desktop-artifact] Built server reports ${reported}, matching the bundle.`);
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

export class DesktopBuildAlreadyRunningError extends Schema.TaggedError<DesktopBuildAlreadyRunningError>()(
  "DesktopBuildAlreadyRunningError",
  { lockPath: Schema.String },
) {
  override get message(): string {
    return `Another desktop build owns '${this.lockPath}'. Wait for it to finish. If a build was killed, confirm no desktop build is running, inspect and restore any changed release manifests, then remove this lock.`;
  }
}

const withDesktopBuildLock = Effect.fn("withDesktopBuildLock")(function* <A, E, R>(
  repoRoot: string,
  build: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(repoRoot, ".desktop-build.lock");
  return yield* Effect.acquireUseRelease(
    fs
      .makeDirectory(lockPath)
      .pipe(
        Effect.mapError((error) =>
          error.reason._tag === "AlreadyExists"
            ? new DesktopBuildAlreadyRunningError({ lockPath })
            : error,
        ),
      ),
    // Stop packaging children and finish stage cleanup before another build can enter.
    () => build.pipe(Effect.scoped),
    (_, exit) =>
      fs
        .remove(lockPath, { recursive: true })
        .pipe(
          Effect.catch((error) =>
            Exit.isFailure(exit) ? Effect.logError(error) : Effect.fail(error),
          ),
        ),
  );
});

// The artifact entry point holds the checkout lock through staging/packaging,
// so it calls this implementation without reacquiring its own lock.
const buildDesktopBundlesUnlocked = Effect.fn("buildDesktopBundlesUnlocked")(function* (
  repoRoot: string,
  appVersion: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vp = yield* resolveVp(repoRoot);
  const spawnCommand = yield* resolveSpawnCommand(vp, ["run", "build:desktop"]);
  yield* Effect.acquireUseRelease(
    Effect.forEach(releasePackageFiles, (relativePath) =>
      Effect.gen(function* () {
        const filePath = path.join(repoRoot, relativePath);
        const contents = yield* fs.readFileString(filePath);
        const needsRestore = yield* decodeReleasePackageManifest(contents).pipe(
          Effect.map((manifest) => manifest.version !== appVersion),
          // Let alignment report invalid manifests after any preceding writes.
          Effect.orElseSucceed(() => false),
        );
        return { filePath, contents, needsRestore };
      }),
    ),
    () =>
      Effect.gen(function* () {
        yield* updateReleasePackageVersions(appVersion, { rootDir: repoRoot });
        // The compiler must stop reading the aligned manifests before restoration.
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: repoRoot,
            shell: spawnCommand.shell,
            env: { APP_VERSION: appVersion },
            extendEnv: true,
          }),
          { label: "vp run build:desktop", verbose },
        ).pipe(Effect.scoped);
      }),
    (originals, exit) =>
      Effect.gen(function* () {
        const [, failures] = yield* Effect.partition(
          originals.filter(({ needsRestore }) => needsRestore),
          ({ filePath, contents }) =>
            fs
              .writeFileString(filePath, contents)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ReleasePackageManifestError({ operation: "write", filePath, cause }),
                ),
              ),
        );
        if (failures.length === 0) return;
        const error = new DesktopBuildManifestRestoreError({ failures });
        if (Exit.isFailure(exit)) {
          // Cleanup must not hide the original build or alignment failure.
          yield* Effect.logError(error);
        } else {
          return yield* error;
        }
      }),
  );
});

export const buildDesktopBundles = Effect.fn("buildDesktopBundles")(
  (repoRoot: string, appVersion: string, verbose: boolean) =>
    withDesktopBuildLock(repoRoot, buildDesktopBundlesUnlocked(repoRoot, appVersion, verbose)),
);

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

const rustTargetIsInstalled = Effect.fn("rustTargetIsInstalled")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("rustc", ["--print", "target-libdir", "--target", target]),
  ).pipe(Effect.orElseSucceed(() => null));
  if (result === null || result.exitCode !== 0) return false;

  const targetLibDir = result.stdout.trim();
  if (targetLibDir === "") return false;
  const entries = yield* fs.readDirectory(targetLibDir).pipe(Effect.orElseSucceed(() => []));
  return entries.some((entry) => entry.startsWith("libstd-") && entry.endsWith(".rlib"));
});

export const preflightLinuxDesktopBuild = Effect.fn("preflightLinuxDesktopBuild")(function* (
  arch: typeof BuildArch.Type = "x64",
) {
  const reuseResourceMonitor = yield* Config.Boolean("GOAT_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const reuseCaptureHelpers = yield* Config.Boolean(
    "GOAT_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS",
  ).pipe(Config.withDefault(false));
  const needsRust = !reuseResourceMonitor || !reuseCaptureHelpers;
  const rustTarget = resolveResourceMonitorRustTargets("linux", arch)[0]!;

  const checks = yield* Effect.all(
    {
      cargo: needsRust
        ? desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo")
        : Effect.succeed(true),
      "rust-target": needsRust ? rustTargetIsInstalled(rustTarget) : Effect.succeed(true),
      cc: desktopBuildProbeSucceeds(ChildProcess.make("cc", ["--version"]), "cc"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      libsecret: desktopBuildProbeSucceeds(
        ChildProcess.make("pkg-config", ["--exists", "libsecret-1"]),
        "libsecret",
      ),
      imagemagick: Effect.all([
        desktopBuildProbeSucceeds(ChildProcess.make("magick", ["-version"]), "magick"),
        desktopBuildProbeSucceeds(ChildProcess.make("convert", ["-version"]), "convert"),
      ]).pipe(Effect.map(([magick, convert]) => magick || convert)),
    },
    { concurrency: "unbounded" },
  );
  const missing = LINUX_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);

  if (missing.length > 0) {
    return yield* new LinuxDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
  }
});

export const preflightMacDesktopBuild = Effect.fn("preflightMacDesktopBuild")(function* (
  arch: typeof BuildArch.Type,
) {
  const rustTargets = resolveResourceMonitorRustTargets("mac", arch);
  const reuseResourceMonitor = yield* Config.Boolean("GOAT_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const checks = yield* Effect.all(
    {
      rust: reuseResourceMonitor
        ? Effect.succeed(true)
        : Effect.all([
            desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
            Effect.forEach(rustTargets, rustTargetIsInstalled).pipe(
              Effect.map((results) => results.every(Boolean)),
            ),
          ]).pipe(Effect.map(([cargo, targets]) => cargo && targets)),
      clang: desktopBuildProbeSucceeds(ChildProcess.make("clang", ["--version"]), "clang"),
      make: desktopBuildProbeSucceeds(ChildProcess.make("make", ["--version"]), "make"),
      sips: desktopBuildProbeSucceeds(ChildProcess.make("sips", ["--help"]), "sips"),
      iconutil: desktopBuildProbeSucceeds(
        ChildProcess.make("xcrun", ["--find", "iconutil"]),
        "iconutil",
      ),
      lipo:
        arch === "universal"
          ? desktopBuildProbeSucceeds(ChildProcess.make("lipo", ["-version"]), "lipo")
          : Effect.succeed(true),
    },
    { concurrency: "unbounded" },
  );
  const missing = MAC_DESKTOP_BUILD_PREREQUISITES.filter(
    (requirement) => !checks[requirement.id],
  ).map((requirement) => requirement.id);
  if (missing.length > 0) {
    return yield* new MacDesktopBuildPrerequisitesMissingError({ missing, rustTargets });
  }
});

function windowsVswherePrerequisiteScript(arch: typeof BuildArch.Type): string {
  const toolComponents =
    arch === "arm64"
      ? ["Microsoft.VisualStudio.Component.VC.Tools.ARM64"]
      : ["Microsoft.VisualStudio.Component.VC.Tools.x86.x64"];
  const spectreArch = arch === "arm64" ? "arm64" : "x64";
  return [
    "$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
    "if (!(Test-Path $vswhere)) { exit 1 }",
    `$install = & $vswhere -latest -products * -requires ${toolComponents.join(" ")} -property installationPath`,
    "if (!$install) { exit 1 }",
    "$kitsRoot = Get-ItemPropertyValue 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue",
    "if (!$kitsRoot -or !(Test-Path (Join-Path $kitsRoot 'Lib'))) { exit 1 }",
    "$msvcToolset = Get-ChildItem (Join-Path $install 'VC\\Tools\\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1",
    "if (!$msvcToolset) { exit 1 }",
    `if (!(Test-Path (Join-Path $msvcToolset.FullName 'lib\\spectre\\${spectreArch}'))) { exit 1 }`,
  ].join("; ");
}

export const preflightWindowsDesktopBuild = Effect.fn("preflightWindowsDesktopBuild")(
  function* (input: { readonly arch: typeof BuildArch.Type }) {
    const rustTarget = resolveResourceMonitorRustTargets("win", input.arch)[0]!;
    const reuseResourceMonitor = yield* Config.Boolean("GOAT_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
      Config.withDefault(false),
    );
    const python = yield* resolvePythonForNodeGyp();
    const checks = yield* Effect.all(
      {
        rust: reuseResourceMonitor
          ? Effect.succeed(true)
          : Effect.all([
              desktopBuildProbeSucceeds(ChildProcess.make("cargo", ["--version"]), "cargo"),
              rustTargetIsInstalled(rustTarget),
            ]).pipe(Effect.map(([cargo, target]) => cargo && target)),
        python: Effect.succeed(python !== undefined),
        msvc: reuseResourceMonitor
          ? Effect.succeed(true)
          : desktopBuildProbeSucceeds(
              ChildProcess.make("powershell.exe", [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                windowsVswherePrerequisiteScript(input.arch),
              ]),
              "Visual Studio Build Tools",
            ),
        tar: desktopBuildProbeSucceeds(ChildProcess.make("tar.exe", ["--version"]), "tar"),
      },
      { concurrency: "unbounded" },
    );
    const missing = WINDOWS_DESKTOP_BUILD_PREREQUISITES.filter(
      (requirement) => !checks[requirement.id],
    ).map((requirement) => requirement.id);
    if (missing.length > 0) {
      return yield* new WindowsDesktopBuildPrerequisitesMissingError({ missing, rustTarget });
    }
  },
);

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;
  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);
    if (yield* exists(candidate)) return candidate;
  }
  return null;
});

const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (packageDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;
  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");
  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  if (source === "") return false;
  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (manifest === null) return false;
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const copyDirectoryPreservingSymlinks = Effect.fn("copyDirectoryPreservingSymlinks")(
  function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Effect's Node implementation delegates directory copies to fs.cp, whose
    // default rewrites links into absolute source-tree references. Recreate every
    // in-tree directory link as a junction rooted in the isolated copy so the
    // probe cannot resolve through staging and Windows needs no symlink privilege.
    yield* fs.copy(source, destination);

    const restoreRelativeSymlinks = Effect.fn("build-desktop-artifact.restoreRelativeSymlinks")(
      function* (
        sourceDirectory: string,
        destinationDirectory: string,
      ): Effect.fn.Return<void, PlatformError | BundleNotSelfContainedError> {
        for (const entry of yield* fs.readDirectory(sourceDirectory)) {
          const sourceEntry = path.join(sourceDirectory, entry);
          const destinationEntry = path.join(destinationDirectory, entry);
          const linkTarget = yield* fs.readLink(sourceEntry).pipe(Effect.option);
          if (Option.isSome(linkTarget)) {
            const absoluteSourceTarget = path.isAbsolute(linkTarget.value)
              ? linkTarget.value
              : path.resolve(path.dirname(sourceEntry), linkTarget.value);
            const sourceRelativeTarget = path.relative(source, absoluteSourceTarget);
            if (
              sourceRelativeTarget === ".." ||
              sourceRelativeTarget.startsWith(`..${path.sep}`) ||
              path.isAbsolute(sourceRelativeTarget)
            ) {
              return yield* new BundleNotSelfContainedError({
                exitCode: -1,
                output: `Refusing to copy symlink ${sourceEntry}: its target ${absoluteSourceTarget} escapes the packaged tree.`,
              });
            }
            const target = path.join(destination, sourceRelativeTarget);
            yield* fs.remove(destinationEntry, { recursive: true, force: true });
            yield* Effect.tryPromise({
              try: () => NodeFSP.symlink(target, destinationEntry, "junction"),
              catch: (cause) =>
                new BundleNotSelfContainedError({
                  exitCode: -1,
                  output: `Could not isolate ${sourceEntry}: ${String(cause)}`,
                }),
            });
          } else {
            const info = yield* fs.stat(sourceEntry);
            if (info.type === "Directory") {
              yield* restoreRelativeSymlinks(sourceEntry, destinationEntry);
            }
          }
        }
      },
    );

    yield* restoreRelativeSymlinks(source, destination);
  },
);

// Preloaded with --require, in argv and NODE_OPTIONS, before the server entry. A CommonJS preload
// also runs in every worker, including one evaluated from a string, and NODE_OPTIONS carries it
// into child Node processes. registerHooks covers import and require; dlopen is wrapped because
// an addon loaded by path never passes through resolve.
const BUNDLE_SELF_CHECK_RESOLVE_HOOK = `const { realpathSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");

const tree = process.env.GOAT_BUNDLE_SELF_CHECK_TREE;
// The hook lives beside the tree and is required again through argv after NODE_OPTIONS.
const self = pathToFileURL(__filename).href;
const outside = (url) => url.startsWith("file:") && !url.startsWith(tree) && url !== self;
// Fail the way a clean machine would, so optional-dependency probes still read it as missing.
const escaped = (what, url, code) =>
  Object.assign(new Error(what + " resolved outside the packaged tree to " + url), { code });

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (outside(resolved.url)) {
      const code = context.conditions.includes("require") ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND";
      throw escaped(specifier, resolved.url, code);
    }
    return resolved;
  },
});

const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...rest) {
  let url;
  try {
    url = pathToFileURL(realpathSync(filename)).href;
  } catch {
    // A missing file fails in dlopen itself with its usual error.
  }
  if (url !== undefined && outside(url)) throw escaped(filename, url, "ERR_DLOPEN_FAILED");
  return dlopen.call(this, module, filename, ...rest);
};
`;

export const verifyPackagedBundleIsSelfContained = Effect.fn("verifyPackagedBundleIsSelfContained")(
  function* (input: { readonly asarPath: string; readonly verbose: boolean }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const probeRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "goat-bundle-selfcheck-",
    });
    const extractedApp = path.join(probeRoot, "extracted");
    const probeApp = path.join(probeRoot, "app");
    yield* Effect.try({
      try: () => extractAll(input.asarPath, extractedApp),
      catch: (cause) =>
        new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Could not extract ${input.asarPath} for the bundle self-containment check: ${String(cause)}`,
        }),
    });
    yield* copyDirectoryPreservingSymlinks(extractedApp, probeApp);

    // Node looks for node_modules in every ancestor directory, so a dependency missing from the
    // packaged tree could resolve from whatever the machine has installed above the probe and
    // pass this check. The hook fails any resolution that leaves the tree instead.
    const treeUrl = NodeURL.pathToFileURL(`${yield* fs.realPath(probeApp)}${path.sep}`).href;
    const hookPath = path.join(probeRoot, "contain-resolution.cjs");
    yield* fs.writeFileString(hookPath, BUNDLE_SELF_CHECK_RESOLVE_HOOK);

    const entryPoint = path.join(probeApp, "apps/server/dist/bin.mjs");
    if (!(yield* fs.exists(entryPoint).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `Expected the server entry at ${entryPoint}.`,
      });
    }

    yield* runCommand(
      ChildProcess.make(
        process.execPath,
        // --no-global-search-paths because clearing NODE_PATH is not enough:
        // CommonJS resolution still falls back to $HOME/.node_modules,
        // $HOME/.node_libraries and the install prefix, so a globally installed
        // copy of a missing dependency would quietly satisfy this check.
        ["--no-global-search-paths", "--require", hookPath, entryPoint, "--version"],
        {
          cwd: probeApp,
          stdout: "pipe",
          stderr: "pipe",
          // Replaces any inherited NODE_OPTIONS, which could preload code from outside the tree.
          env: {
            ...process.env,
            NODE_PATH: "",
            // Quoted so a path with spaces or backslashes survives NODE_OPTIONS parsing.
            NODE_OPTIONS: `--require="${hookPath.replace(/["\\]/g, "\\$&")}"`,
            GOAT_BUNDLE_SELF_CHECK_TREE: treeUrl,
          },
        },
      ),
      {
        label: "server sidecar self-containment check (node bin.mjs --version)",
        verbose: input.verbose,
      },
    ).pipe(
      Effect.timeout(BUNDLE_SELF_CHECK_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: -1,
              output: `The packaged bundle did not print its version within ${Duration.toSeconds(BUNDLE_SELF_CHECK_TIMEOUT)}s; it is hanging rather than failing to resolve.`,
            }),
          ),
        BuildCommandFailedError: (error) =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: error.exitCode,
              output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
            }),
          ),
      }),
    );
  },
);

export const stageLinuxCaptureHelper = Effect.fn("stageLinuxCaptureHelper")(function* (input: {
  readonly backend: "kde" | "hyprland";
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [rustTarget] = resolveResourceMonitorRustTargets("linux", input.arch);
  // Release CI restores these binaries from a cache keyed on the crate sources and
  // skips the Rust toolchain on a hit, so the build must be skippable too.
  const reuseHelpers = yield* Config.Boolean("GOAT_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS").pipe(
    Config.withDefault(false),
  );
  const binaryPath = path.join(
    input.repoRoot,
    `native/${input.backend}-snap-shot/target`,
    rustTarget!,
    `release/t3-${input.backend}-snap-shot`,
  );
  if (!reuseHelpers) {
    const spawnCommand = yield* resolveSpawnCommand("cargo", [
      "build",
      "--locked",
      "--release",
      "--manifest-path",
      path.join(input.repoRoot, `native/${input.backend}-snap-shot/Cargo.toml`),
      "--target",
      rustTarget!,
    ]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.repoRoot,
        shell: spawnCommand.shell,
      }),
      {
        label: `cargo build ${input.backend} capture helper (${rustTarget})`,
        verbose: input.verbose,
      },
    );
  } else if (!(yield* fs.exists(binaryPath))) {
    return yield* new ResourceMonitorBuildOutputMissingError({
      binaryPath,
      rustTarget: rustTarget!,
      platform: "linux",
      arch: input.arch,
    });
  }
  const destination = path.join(input.stageResourcesDir, `${input.backend}-capture`);
  yield* fs.makeDirectory(destination, { recursive: true });
  const executable = path.join(destination, `t3-${input.backend}-snap-shot`);
  yield* fs.copyFile(binaryPath, executable);
  yield* fs.chmod(executable, 0o755);
  if (input.backend === "hyprland") {
    // The official protocol XML includes the BSD notices required with binary distribution.
    yield* fs.copy(
      path.join(input.repoRoot, "native/hyprland-snap-shot/protocols"),
      path.join(destination, "protocols"),
    );
  }
});

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const executableName = resourceMonitorExecutableName(input.platform);
  const rustTargets = resolveResourceMonitorRustTargets(input.platform, input.arch);
  const reuseResourceMonitor = yield* Config.Boolean("GOAT_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        manifestPath,
        "--target",
        rustTarget,
      ]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    let binaryPath = path.join(
      input.repoRoot,
      "native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    );
    const legacyBinaryPath = path.join(
      path.dirname(binaryPath),
      `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${input.platform === "win" ? ".exe" : ""}`,
    );
    if (!(yield* fs.exists(binaryPath)) && (yield* fs.exists(legacyBinaryPath))) {
      binaryPath = legacyBinaryPath;
    }
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: input.platform,
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  if (input.platform !== "win") {
    yield* fs.chmod(destinationPath, 0o755);
  }
});

export const stageBrowserSecret = Effect.fn("stageBrowserSecret")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  if (input.platform !== "linux") return;
  // The helper links against the host's libsecret, so it can only be built on
  // Linux; the build script is a no-op elsewhere. A Linux artifact from another
  // host would ship without it and every v11 cookie import would report the
  // keyring as unavailable, so refuse rather than package that silently.
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform !== "linux") {
    return yield* new LinuxBrowserSecretHostError({ hostPlatform });
  }
  const path = yield* Path.Path;
  yield* runCommand(
    ChildProcess.make(
      "node",
      [
        path.join(input.repoRoot, "apps/desktop/scripts/build-browser-secret.mjs"),
        "--arch",
        input.arch === "arm64" ? "arm64" : "x64",
        "--output",
        path.join(input.stageResourcesDir, "browser-secret", "goat-browser-secret"),
      ],
      { cwd: input.repoRoot },
    ),
    { label: "build Linux browser secret helper", verbose: input.verbose },
  );
});

const generateMacIconSet = Effect.fn("build-desktop-artifact.generateMacIconSet")(function* (
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const iconsetDir = path.join(tmpRoot, "icon.iconset");
  yield* fs.makeDirectory(iconsetDir, { recursive: true });

  const iconSizes = [16, 32, 128, 256, 512] as const;
  for (const size of iconSizes) {
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      { label: `sips icon ${size}x${size}`, verbose },
    );

    const retinaSize = size * 2;
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      { label: `sips icon ${size}x${size}@2x`, verbose },
    );
  }

  yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
    label: "iconutil icns",
    verbose,
  });
});

const stageMacIcons = Effect.fn("build-desktop-artifact.stageMacIcons")(function* (
  stageResourcesDir: string,
  sourcePng: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourcePng))) {
    return yield* new DesktopIconSourceMissingError({
      platform: "mac",
      sourcePath: sourcePng,
    });
  }

  const tmpRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "t3code-icon-build-",
  });

  const iconPngPath = path.join(stageResourcesDir, "icon.png");
  const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

  yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
    label: "sips mac icon",
    verbose,
  });

  yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
});

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  channel: "latest" | "nightly",
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", `dmg-background-${channel}.svg`);
  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel, sourcePath });
  }

  for (const output of [
    { suffix: "", width: 640, height: 432 },
    { suffix: "@2x", width: 1280, height: 864 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-${channel}${output.suffix}.png`,
    );
    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips ${channel} DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

const stageLinuxIcons = Effect.fn("build-desktop-artifact.stageLinuxIcons")(function* (
  stageResourcesDir: string,
  sourcePng: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourcePng))) {
    return yield* new DesktopIconSourceMissingError({
      platform: "linux",
      sourcePath: sourcePng,
    });
  }

  const iconPath = path.join(stageResourcesDir, "icon.png");
  yield* fs.copyFile(sourcePng, iconPath);

  const iconsDir = path.join(stageResourcesDir, "icons");
  yield* fs.makeDirectory(iconsDir, { recursive: true });
  for (const iconSize of LINUX_ICON_SIZES) {
    yield* stageLinuxIconSize(
      sourcePng,
      path.join(iconsDir, `${iconSize}x${iconSize}.png`),
      iconSize,
      verbose,
    );
  }
});

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

const stageWindowsIcons = Effect.fn("build-desktop-artifact.stageWindowsIcons")(function* (
  stageResourcesDir: string,
  sourceIco: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourceIco))) {
    return yield* new DesktopIconSourceMissingError({
      platform: "win",
      sourcePath: sourceIco,
    });
  }

  const iconPath = path.join(stageResourcesDir, "icon.ico");
  yield* fs.copyFile(sourceIco, iconPath);
});

const validateBundledClientAssets = Effect.fn("build-desktop-artifact.validateBundledClientAssets")(
  function* (clientDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  },
);

/** The sandboxed preload bundles in apps/desktop/dist-electron (see apps/desktop/vite.config.ts). */
export const SANDBOXED_PRELOADS = [
  "preload.cjs",
  "preview-pick-preload.cjs",
  "preview-pip-preload.cjs",
  "mac-permission-preload.cjs",
] as const;

// The parameters Electron's sandbox wraps around a preload's source.
const SANDBOXED_PRELOAD_PARAMETERS = [
  "require",
  "process",
  "Buffer",
  "global",
  "setImmediate",
  "clearImmediate",
  "exports",
  "module",
] as const;

/** Why Electron's sandbox would refuse this preload source, or undefined when it parses. */
export function sandboxedPreloadSyntaxError(source: string): string | undefined {
  try {
    // Parses only: the function is never called.
    Function(...SANDBOXED_PRELOAD_PARAMETERS, source);
    return undefined;
  } catch (error) {
    return error instanceof SyntaxError ? error.message : undefined;
  }
}

export class SandboxedPreloadInvalidError extends Schema.TaggedError<SandboxedPreloadInvalidError>()(
  "SandboxedPreloadInvalidError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      "Electron's sandbox cannot load these preload bundles:",
      ...this.problems.map((problem) => "  - " + problem),
    ].join("\n");
  }
}

const validateSandboxedPreloads = Effect.fn("build-desktop-artifact.validateSandboxedPreloads")(
  function* (desktopDist: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const problems: string[] = [];
    for (const name of SANDBOXED_PRELOADS) {
      const problem = sandboxedPreloadSyntaxError(
        yield* fs.readFileString(path.join(desktopDist, name)),
      );
      if (problem !== undefined) problems.push(name + ": " + problem);
    }
    if (problems.length > 0) return yield* new SandboxedPreloadInvalidError({ problems });
  },
);

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    selectDesktopRuntimeExternalDependencies(dependencies),
    catalog,
    "apps/desktop",
  );
}

export const resolveGitHubPublishConfig = Effect.fn("resolveGitHubPublishConfig")(function* (
  updateChannel: "latest" | "nightly",
) {
  const env = yield* Config.all({
    updateRepository: Config.String("GOAT_DESKTOP_UPDATE_REPOSITORY").pipe(Config.option),
    enabled: Config.Boolean("GOAT_DESKTOP_UPDATE_FEED_ENABLED").pipe(Config.withDefault(false)),
  });
  if (!env.enabled) return undefined;
  const rawRepo = Option.getOrUndefined(env.updateRepository)?.trim();
  if (rawRepo !== DESKTOP_UPDATE_REPOSITORY) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
});

import { resolveDesktopUpdateChannel } from "./lib/desktop-release-channel.ts";
export { resolveDesktopUpdateChannel };

export function isDesktopPreviewVersion(version: string): boolean {
  return /-pr\./.test(version) || /-preview\.\d{8}\.\d+$/.test(version);
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveWebAssetBrandForChannel(resolveDesktopUpdateChannel(version));
}

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly" ? "GOAT (Nightly)" : "GOAT";
}

export function resolveDesktopAppId(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? `${DESKTOP_APP_ID}.nightly`
    : DESKTOP_APP_ID;
}

export const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  version: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: number | undefined,
  macPasskeySigning:
    | {
        readonly entitlementsPath: string;
        readonly provisioningProfilePath: string;
      }
    | undefined,
  wslRuntimeBundled = false,
  arch?: typeof BuildArch.Type,
  sshRuntimeBundled = false,
  computerUseHelperPath?: string,
) {
  const buildConfig: Record<string, unknown> = {
    appId: resolveDesktopAppId(version),
    productName: resolveDesktopProductName(version),
    artifactName: "GOAT-${version}-${arch}.${ext}",
    // Disable electron-builder's ambient GitHub inference for unpublished builds.
    publish: null,
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [
      ...DESKTOP_FILE_EXCLUSIONS,
      ...(platform === "mac"
        ? resolveMacFileExclusions(arch)
        : platform === "linux"
          ? LINUX_FILE_EXCLUSIONS
          : []),
    ],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    // Smart unpack extracts entire native packages, including JavaScript and
    // metadata. Windows keeps those files archived so native dependencies do
    // not inflate the loose-file count and slow NSIS installation.
    ...(platform === "win"
      ? { asar: { smartUnpack: false }, asarUnpack: [WINDOWS_NATIVE_ASAR_UNPACK_GLOB] }
      : {
          asarUnpack: [
            "**/node_modules/@trycua/cua-driver-*/**/*.{node,so,dylib,dll}",
            "**/node_modules/@ubjs/node-*/**/*.node",
          ],
        }),
    extraResources: [
      ...DESKTOP_EXTRA_RESOURCES,
      ...(computerUseHelperPath
        ? [{ from: computerUseHelperPath, to: "../Helpers/GOAT Computer Use.app" }]
        : []),
      ...(sshRuntimeBundled ? SSH_RUNTIME_EXTRA_RESOURCES : []),
      ...(platform === "linux" ? LINUX_CAPTURE_EXTRA_RESOURCES : []),
      ...(platform === "linux" ? LINUX_BROWSER_SECRET_EXTRA_RESOURCES : []),
      ...(platform === "win" ? WINDOWS_SERVER_EXTRA_RESOURCES : []),
      ...(platform === "win" && wslRuntimeBundled ? WSL_RUNTIME_EXTRA_RESOURCES : []),
    ],
  };
  const updateChannel = resolveDesktopUpdateChannel(version);
  // A missing `publish` makes electron-builder infer a GitHub feed from
  // GH_TOKEN/GITHUB_TOKEN. The staged app has no repository to resolve it
  // against, so writing update manifests then crashes on a null config.
  buildConfig.publish = null;
  if (!isDesktopPreviewVersion(version)) {
    if (mockUpdates) {
      buildConfig.publish = [
        {
          provider: "generic",
          url: resolveMockUpdateServerUrl(mockUpdateServerPort),
        },
      ];
    } else {
      const publishConfig = yield* resolveGitHubPublishConfig(updateChannel);
      if (publishConfig) buildConfig.publish = [publishConfig];
    }
  }

  if (platform === "mac") {
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      extendInfo: {
        // macOS 26 offers Messages/Mail codes in every text field unless opted out.
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        NSLocalNetworkUsageDescription:
          "GOAT connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
        NSScreenCaptureUsageDescription:
          "GOAT captures the active window when you use the window capture shortcut.",
        NSCameraUsageDescription:
          "GOAT lets commands run by terminals and coding agents use the camera.",
        NSMicrophoneUsageDescription:
          "GOAT lets commands run by terminals and coding agents use the microphone.",
        // macOS lists an app under Default web browser only when it opens web
        // pages as documents as well as http and https links (see protocols).
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: "Web page",
            CFBundleTypeRole: "Viewer",
            LSHandlerRank: "Alternate",
            LSItemContentTypes: ["public.html", "public.xhtml"],
          },
        ],
      },
      protocols: [
        {
          name: "GOAT",
          schemes: ["goat", "goat-dev", "t3code", "t3code-dev"],
        },
        {
          name: "Web site URL",
          schemes: ["http", "https"],
          role: "Viewer",
        },
      ],
      ...(signed ? { sign: path.join(repoRoot, "scripts/sign-macos.ts") } : {}),
      ...(macPasskeySigning
        ? {
            entitlements: macPasskeySigning.entitlementsPath,
            provisioningProfile: macPasskeySigning.provisioningProfilePath,
          }
        : {}),
    };
  }

  if (platform === "mac" && target === "dmg") {
    buildConfig.dmg = {
      // Give the themed installer its own Finder volume name. Finder caches
      // DMG window backgrounds by volume name, so reusing a generic name can
      // make a newly built background look unchanged during testing.
      title: `${resolveDesktopProductName(version)} ${version} Installer`,
      background: `dmg/dmg-background-${updateChannel}.png`,
      window: {
        width: 640,
        // The DMG backend derives bounds from the image, including Finder's
        // 32px title bar. Keep the last 32px of the artwork free of content.
        height: 432,
      },
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
      iconSize: 120,
      iconTextSize: 12,
    };
  }

  if (platform === "linux") {
    // electron-builder 26 defaults to its legacy AppImage runtime, which
    // dynamically loads the system libfuse2 library. Pin the static runtime so
    // the AppImage also launches on distributions that only provide FUSE 3.
    buildConfig.toolsets = { appimage: "1.0.3" };
    const path = yield* Path.Path;
    const repoRoot = yield* RepoRoot;
    buildConfig.linux = {
      target: target === "AppImage" ? [target, "deb"] : [target],
      executableName: "t3code",
      icon: "icons",
      category: "Development",
      synopsis: "Desktop GUI for coding agents",
      maintainer: "T3 Tools <hello@t3.codes>",
      protocols: [
        {
          name: "GOAT",
          schemes: ["goat", "goat-dev", "t3code", "t3code-dev"],
        },
      ],
      desktop: {
        entry: {
          StartupWMClass: "t3code",
        },
      },
    };
    buildConfig.deb = {
      // FPM runs outside the staged app directory, so source paths must be absolute.
      fpm: [
        `${path.join(repoRoot, "apps/desktop/resources/linux/si.goat.desktop.metainfo.xml")}=/usr/share/metainfo/si.goat.desktop.metainfo.xml`,
        `${path.join(repoRoot, "LICENSE")}=/usr/share/doc/t3code/copyright`,
      ],
      // Debian 13 and Ubuntu 24.04 renamed some for 64-bit time; the old name
      // is the fallback for older releases.
      depends: [
        "libasound2t64 | libasound2",
        "libatspi2.0-0t64 | libatspi2.0-0",
        "libgbm1",
        "libgtk-3-0t64 | libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libsecret-1-0",
        "libuuid1",
        "libxss1",
        "libxtst6",
        "xdg-utils",
      ],
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    buildConfig.nsis = {
      differentialPackage: true,
      include: "apps/desktop/resources/installer.nsh",
    };
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
      // Smart App Control validates unpacked native addons independently from
      // the signed desktop executable. Extend release signing to every native
      // Windows library that Electron or the server sidecar loads at runtime.
      signExts: [".node", ".dll"],
      // Resource editing applies the product metadata and icon independently
      // of code signing. Disabling it for local unsigned builds leaves the
      // packaged executable with Electron's stock icon.
      signAndEditExecutable: true,
    };
    if (signed && (yield* HostProcess.Platform) === "win32") {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    } else if (signed) {
      const path = yield* Path.Path;
      const { publisherName } = yield* AzureTrustedSigningOptionsConfig;
      winConfig.signtoolOptions = {
        sign: yield* path.fromFileUrl(new URL("./lib/windows-jsign.ts", import.meta.url)),
        signingHashAlgorithms: ["sha256"],
        publisherName: [publisherName],
      };
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, iconAssets.macIconPng, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  }
});

// The desktop app verifies the digest inside the distro before extracting, and
// the digest also names the extracted runtime's cache directory, so it must be
// computed from the exact bytes that ship.
export const stageWslRuntimeArchive = Effect.fn("stageWslRuntimeArchive")(function* (input: {
  readonly sourceArchivePath: string;
  readonly archivePath: string;
  readonly hashPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceExists = yield* fs
    .exists(input.sourceArchivePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!sourceExists) {
    return yield* new WslRuntimeArchiveMissingError({ archivePath: input.sourceArchivePath });
  }
  yield* fs.makeDirectory(path.dirname(input.archivePath), { recursive: true });
  yield* fs.copyFile(input.sourceArchivePath, input.archivePath);
  const hash = NodeCrypto.createHash("sha256");
  yield* fs
    .stream(input.archivePath)
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  const digest = hash.digest("hex");
  yield* fs.writeFileString(input.hashPath, `${digest}\n`);
  yield* Effect.log(
    `[desktop-artifact] Staged WSL runtime archive at ${input.archivePath} (${digest}).`,
  );
});

// Mirrors cliArchiveStem in scripts/build-cli-archive.ts (which imports from
// this module, so it cannot be imported here). WSL runs the same CPU arch as
// the Windows host.
export const wslRuntimeArchiveStem = (version: string, arch: typeof BuildArch.Type): string =>
  `goat-${version}-linux-${arch}`;

export const parseWslRuntimeArchiveMembers = (listing: string): ReadonlyArray<string> =>
  listing
    .split(/\r?\n/)
    .map((member) => member.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((member) => member.length > 0);

export class SshRuntimeArchiveValidationError extends Schema.TaggedError<SshRuntimeArchiveValidationError>()(
  "SshRuntimeArchiveValidationError",
  { message: Schema.String },
) {}

export const SSH_RUNTIME_PLATFORM_KEYS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;
export const SSH_RUNTIME_RESOURCE_SOURCE_DIR = "apps/desktop/prod-resources/ssh-runtime/archives";
export const SSH_RUNTIME_EXTRA_RESOURCES = [
  {
    from: SSH_RUNTIME_RESOURCE_SOURCE_DIR,
    to: "ssh-runtime/archives",
    filter: ["*.tar.gz", "*.tar.gz.sha256"],
  },
] as const;

export const validateSshRuntimeArchives = Effect.fn("validateSshRuntimeArchives")(
  function* (input: {
    readonly directory: string;
    readonly version: string;
    readonly requireAll: boolean;
    readonly requireSidecars?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const archives: Array<{ fileName: string; bytes: Uint8Array; sha256: string }> = [];
    for (const key of SSH_RUNTIME_PLATFORM_KEYS) {
      const fileName = cliArchiveFileName(input.version, key);
      const archivePath = path.join(input.directory, fileName);
      if (!(yield* fs.exists(archivePath))) {
        if (input.requireAll)
          return yield* Effect.fail(
            new SshRuntimeArchiveValidationError({
              message: `Missing SSH runtime archive ${archivePath}`,
            }),
          );
        continue;
      }
      const stat = yield* fs.stat(archivePath);
      if (stat.type !== "File" || stat.size > 256n * 1024n * 1024n) {
        return yield* Effect.fail(
          new SshRuntimeArchiveValidationError({
            message: `Invalid SSH runtime archive ${archivePath}`,
          }),
        );
      }
      const bytes = yield* fs.readFile(archivePath);
      if (BigInt(bytes.byteLength) !== stat.size || bytes.byteLength > 256 * 1024 * 1024) {
        return yield* Effect.fail(
          new SshRuntimeArchiveValidationError({
            message: `SSH runtime archive changed while reading ${archivePath}`,
          }),
        );
      }
      const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const sidecar = `${archivePath}.sha256`;
      const hasSidecar = yield* fs.exists(sidecar);
      if (input.requireSidecars && !hasSidecar) {
        return yield* Effect.fail(
          new SshRuntimeArchiveValidationError({
            message: `Missing SSH runtime checksum ${sidecar}`,
          }),
        );
      }
      if (hasSidecar) {
        const checksum = yield* fs.readFileString(sidecar);
        if (
          parseChecksums(checksum).get(fileName) !== sha256 ||
          (input.requireSidecars && checksum !== `${sha256}  ${fileName}\n`)
        ) {
          return yield* Effect.fail(
            new SshRuntimeArchiveValidationError({
              message: `Invalid or noncanonical SSH runtime checksum ${sidecar}`,
            }),
          );
        }
      }
      const tarCommand = cliArchiveTarCommand(yield* HostProcess.Platform, process.env);
      const listing = yield* spawnAndCollectOutput(
        ChildProcess.make(tarCommand, ["-tzf", archivePath], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      if (listing.exitCode !== 0) {
        return yield* Effect.fail(
          new SshRuntimeArchiveValidationError({
            message: `Cannot list ${archivePath}: ${listing.stderr.trim()}`,
          }),
        );
      }
      const members = parseWslRuntimeArchiveMembers(listing.stdout);
      const stem = fileName.slice(0, -".tar.gz".length);
      const required = [
        `${stem}/goat`,
        `${stem}/client/index.html`,
        `${stem}/resource-monitor/${key}/goat-resource-monitor`,
      ];
      const pty = [
        `${stem}/node_modules/node-pty/build/Release/pty.node`,
        `${stem}/node_modules/node-pty/prebuilds/${key}/pty.node`,
      ];
      if (
        members.length === 0 ||
        members.some(
          (member) =>
            member.split("/").some((segment) => segment === "..") ||
            (member !== stem && !member.startsWith(`${stem}/`)) ||
            member.endsWith("/bin.mjs"),
        ) ||
        required.some((member) => !members.includes(member)) ||
        !pty.some((member) => members.includes(member))
      ) {
        return yield* Effect.fail(
          new SshRuntimeArchiveValidationError({
            message: `Incomplete or wrong-version SSH runtime archive ${archivePath}`,
          }),
        );
      }
      archives.push({ fileName, bytes, sha256 });
    }
    if (archives.length === 0)
      return yield* Effect.fail(
        new SshRuntimeArchiveValidationError({
          message: `No SSH runtime archives for ${input.version} in ${input.directory}`,
        }),
      );
    return archives;
  },
);

export const stageSshRuntimeArchives = Effect.fn("stageSshRuntimeArchives")(function* (input: {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly version: string;
  readonly requireAll: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Validate the entire input before creating any destination resources.
  const archives = yield* validateSshRuntimeArchives({
    directory: input.sourceDirectory,
    version: input.version,
    requireAll: input.requireAll,
  });
  yield* fs.makeDirectory(input.destinationDirectory, { recursive: true });
  for (const archive of archives) {
    // Write the bytes we hashed, not a second read/copy of a mutable source.
    yield* fs.writeFile(path.join(input.destinationDirectory, archive.fileName), archive.bytes);
    yield* fs.writeFileString(
      path.join(input.destinationDirectory, `${archive.fileName}.sha256`),
      `${archive.sha256}  ${archive.fileName}\n`,
    );
  }
  yield* Effect.logInfo(
    `Staged SSH runtime archives: ${archives.length} archives, ${archives.reduce((total, archive) => total + archive.bytes.byteLength, 0)} bytes (plus canonical SHA-256 sidecars).`,
  );
  yield* validateSshRuntimeArchives({
    directory: input.destinationDirectory,
    version: input.version,
    requireAll: input.requireAll,
    requireSidecars: true,
  });
});

export const packWindowsServerAsar = Effect.fn("packWindowsServerAsar")(function* (input: {
  readonly sourceDir: string;
  readonly asarPath: string;
  readonly arch: typeof BuildArch.Type;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Native addons are unpacked only when they are Windows PE ("MZ") binaries.
  // Signed builds Authenticode-sign every unpacked .node file, which fails on
  // the darwin and linux prebuilds some packages (node-pty) ship alongside
  // their win32 ones. The Windows primary never loads those, so they stay packed.
  const unpackGlobs: string[] = [...WINDOWS_SERVER_ASAR_UNPACK_GLOBS];
  for (const entry of yield* fs.readDirectory(input.sourceDir, { recursive: true })) {
    if (!entry.endsWith(".node")) continue;
    const addonPath = path.join(input.sourceDir, entry);
    if ((yield* fs.stat(addonPath)).type !== "File") continue;
    const bytes = yield* fs.readFile(addonPath);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) continue;
    const posixPath = entry.split(path.sep).join("/");
    // Backslash escapes are path separators to minimatch on Windows.
    if (/[\\*?[\]{}(),]/.test(posixPath)) {
      return yield* new WindowsServerSidecarPackError({
        asarPath: input.asarPath,
        cause: new Error(`native addon path contains glob syntax: ${posixPath}`),
      });
    }
    unpackGlobs.push(`**/${posixPath}`);
  }
  yield* Effect.tryPromise({
    try: () =>
      createPackageWithOptions(input.sourceDir, input.asarPath, {
        dot: true,
        unpack: `{${unpackGlobs.join(",")}}`,
        // glob 13 (via @electron/asar 4) matches `ignore` relative to `cwd`,
        // not against the absolute paths it crawls, so anchor it at the source.
        globOptions: {
          cwd: input.sourceDir,
          ignore: resolveWindowsServerAsarIgnoreGlobs(input.arch),
        },
      }),
    catch: (cause) => new WindowsServerSidecarPackError({ asarPath: input.asarPath, cause }),
  });
  const unpackedDirPath = `${input.asarPath}.unpacked`;
  if (!(yield* fs.exists(unpackedDirPath))) {
    return yield* new WindowsServerSidecarPackError({
      asarPath: input.asarPath,
      cause: new Error(`expected native binaries at ${unpackedDirPath}, but none were unpacked`),
    });
  }
});

export const stageWindowsServerSidecar = Effect.fn("stageWindowsServerSidecar")(function* (input: {
  readonly stageRoot: string;
  readonly repoRoot: string;
  readonly serverDistDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly appVersion: string;
  readonly runtimeExternalDependencies: Record<string, string>;
  readonly fffNodeVersion: string;
  readonly allowBuilds: Record<string, boolean>;
  readonly patchedDependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly asarPath: string;
  readonly verbose: boolean;
  /** The vp to run; see resolveVp. */
  readonly vp: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const serverStageDir = path.join(input.stageRoot, "server");
  yield* fs.makeDirectory(path.join(serverStageDir, "apps/server"), { recursive: true });
  yield* fs.copy(input.serverDistDir, path.join(serverStageDir, "apps/server/dist"));

  const sidecarDependencies = {
    // The desktop host owns Cua; this server reaches it through telemetry IPC.
    ...Object.fromEntries(
      Object.entries(input.runtimeExternalDependencies).filter(
        ([name]) => name !== "@trycua/cua-driver",
      ),
    ),
    ...resolveFffNativeDependencies("win", input.arch, input.fffNodeVersion),
  };
  const sidecarPatchedDependencies = createStagePatchedDependencies(
    input.patchedDependencies,
    sidecarDependencies,
  );
  const sidecarPackageJson = {
    name: "t3code-server",
    version: input.appVersion,
    private: true,
    packageManager: rootPackageJson.packageManager,
    dependencies: sidecarDependencies,
  };
  const sidecarPackageJsonString = yield* encodeJsonString(sidecarPackageJson);
  yield* fs.writeFileString(
    path.join(serverStageDir, "package.json"),
    `${sidecarPackageJsonString}\n`,
  );
  const sidecarWorkspaceConfig = {
    ...createStageWorkspaceConfig({
      platform: "win",
      arch: input.arch,
      allowBuilds: input.allowBuilds,
      patchedDependencies: sidecarPatchedDependencies,
      overrides: input.overrides,
    }),
    // The tree gets packed into server.asar, which cannot carry pnpm's
    // symlink/junction layout, so install a physical, hoisted node_modules.
    nodeLinker: "hoisted" as const,
  };
  const sidecarWorkspaceConfigString = yield* encodeStageWorkspaceConfig(sidecarWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(serverStageDir, "pnpm-workspace.yaml"),
    sidecarWorkspaceConfigString,
  );
  if (Object.keys(sidecarPatchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(serverStageDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing server sidecar runtime externals...");
  const installCommand = yield* resolveSpawnCommand(input.vp, [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: serverStageDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod (server sidecar)", verbose: input.verbose },
  );

  yield* Effect.log("[desktop-artifact] Packing server.asar...");
  yield* fs.makeDirectory(path.dirname(input.asarPath), { recursive: true });
  yield* packWindowsServerAsar({
    sourceDir: serverStageDir,
    asarPath: input.asarPath,
    arch: input.arch,
  });
  const packedStat = yield* fs.stat(input.asarPath);
  yield* Effect.log(
    `[desktop-artifact] Packed server.asar (${String(packedStat.size)} bytes) + unpacked natives.`,
  );
});

function collectUnpackedAsarFiles(
  directory: DirectoryRecord,
  parentPath = "",
  output: string[] = [],
): readonly string[] {
  for (const [name, entry] of Object.entries(directory.files)) {
    const entryPath = parentPath.length === 0 ? name : `${parentPath}/${name}`;
    if ("files" in entry) {
      collectUnpackedAsarFiles(entry, entryPath, output);
    } else if (entry.unpacked) {
      output.push(entryPath);
    }
  }
  return output;
}

const countPayloadFiles = Effect.fn("desktopArtifact.countPayloadFiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pendingDirectories = [root];
  let count = 0;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) break;
    const entries = yield* fs.readDirectory(directory);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const stat = yield* fs.stat(entryPath);
      if (stat.type === "Directory") {
        pendingDirectories.push(entryPath);
      } else if (stat.type === "File") {
        count += 1;
      }
    }
  }

  return count;
});

export const verifyWindowsPrimaryFffNativeLoad = Effect.fn(
  "desktopArtifact.verifyWindowsPrimaryFffNativeLoad",
)(function* (input: {
  readonly packagedAppDir: string;
  readonly asarPath: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executablePath = path.join(input.packagedAppDir, input.appExecutableName);
  const executableStat = yield* fs.stat(executablePath).pipe(Effect.orElseSucceed(() => null));
  if (executableStat?.type !== "File") {
    return yield* new WindowsPrimaryNativeProbeError({
      executablePath,
      exitCode: -1,
      output: "The unpacked application does not contain its expected primary executable.",
    });
  }
  if (hostPlatform !== "win32" || hostArchitecture !== input.targetArch) return;

  const probeRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "goat-windows-primary-native-probe-",
  });
  const fffEntryPath = path.join(input.asarPath, "node_modules/@ff-labs/fff-node/dist/index.js");
  const probeEnv = { ...process.env };
  delete probeEnv.ELECTRON_NO_ASAR;
  delete probeEnv.NODE_OPTIONS;

  yield* runCommand(
    ChildProcess.make(
      executablePath,
      [
        "--no-global-search-paths",
        "--input-type=module",
        "--eval",
        WINDOWS_PRIMARY_FFF_PROBE_SOURCE,
        fffEntryPath,
        probeRoot,
      ],
      {
        cwd: input.packagedAppDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...probeEnv,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_PATH: "",
        },
      },
    ),
    {
      label: "Windows primary fff native-load probe",
      verbose: input.verbose,
    },
  ).pipe(
    Effect.timeout(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: -1,
            output: `The native-load probe did not finish within ${Duration.toSeconds(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT)}s.`,
          }),
        ),
      BuildCommandFailedError: (error) =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: error.exitCode,
            output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
          }),
        ),
    }),
  );
});

export const validatePackagedSshRuntimeArchives = Effect.fn("validatePackagedSshRuntimeArchives")(
  function* (input: {
    readonly stageDistDir: string;
    readonly version: string;
    readonly requireAll: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resourceDirectories: string[] = [];
    // electron-builder keeps an unpacked app next to installers. Visit only
    // the output root and one platform directory, never a dependency tree.
    for (const entry of yield* fs.readDirectory(input.stageDistDir)) {
      const directory = path.join(input.stageDistDir, entry);
      if ((yield* fs.stat(directory)).type !== "Directory") continue;
      if (entry.endsWith("-unpacked")) resourceDirectories.push(path.join(directory, "resources"));
      if (entry.endsWith(".app"))
        resourceDirectories.push(path.join(directory, "Contents", "Resources"));
      if (entry === "mac" || entry.startsWith("mac-")) {
        for (const app of yield* fs.readDirectory(directory)) {
          if (app.endsWith(".app"))
            resourceDirectories.push(path.join(directory, app, "Contents", "Resources"));
        }
      }
    }
    if (resourceDirectories.length === 0) {
      return yield* Effect.fail(
        new SshRuntimeArchiveValidationError({
          message: `No packaged app resources found in ${input.stageDistDir}`,
        }),
      );
    }
    for (const resources of resourceDirectories) {
      yield* validateSshRuntimeArchives({
        directory: path.join(resources, "ssh-runtime", "archives"),
        version: input.version,
        requireAll: input.requireAll,
        requireSidecars: true,
      });
    }
  },
);

/**
 * The fff probe needs a host of the target's platform and architecture; the
 * bundle self-check needs a Windows host. A cross build defers both to
 * scripts/verify-windows-desktop-artifact.ts.
 */
export const verifyWindowsPackagedRuntime = Effect.fn(
  "desktopArtifact.verifyWindowsPackagedRuntime",
)(function* (input: {
  readonly packagedAppDir: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const path = yield* Path.Path;
  const asarPath = path.join(input.packagedAppDir, "resources", WINDOWS_SERVER_ASAR_RESOURCE);
  yield* verifyWindowsPrimaryFffNativeLoad({ ...input, asarPath });
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform !== "win32") {
    yield* Effect.log(
      `[desktop-artifact] Skipped the bundle self-check on a ${hostPlatform} host.`,
    );
    return;
  }
  yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: input.verbose });
});

export const validateWindowsPackagedPayload = Effect.fn(
  "desktopArtifact.validateWindowsPackagedPayload",
)(function* (input: {
  readonly stageDistDir: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly appVersion: string;
  readonly expectWslRuntime?: boolean;
  readonly fileLimit?: number;
  readonly verbose?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileLimit = input.fileLimit ?? WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT;
  const isFile = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((stat) => stat.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  const stageEntries = yield* fs.readDirectory(input.stageDistDir);
  let packagedAppDir: string | undefined;

  for (const entry of stageEntries) {
    if (!entry.endsWith("-unpacked")) continue;
    const candidate = path.join(input.stageDistDir, entry);
    const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));
    if (stat?.type === "Directory") {
      packagedAppDir = candidate;
      break;
    }
  }

  if (packagedAppDir === undefined) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "packaged-app-missing",
      packagedAppDir: path.join(input.stageDistDir, "win-unpacked"),
    });
  }

  const resourcesDir = path.join(packagedAppDir, "resources");
  const asarPath = path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE);
  if (!(yield* fs.exists(asarPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-missing",
      packagedAppDir,
      missingFiles: [WINDOWS_SERVER_ASAR_RESOURCE],
    });
  }

  const unpackedFiles = yield* Effect.try({
    try: () => {
      // @electron/asar resolves entry names using the host path separator.
      // POSIX separators work on Linux/macOS but fail on Windows even when the
      // entry is present in the archive.
      statFile(asarPath, path.join("apps", "server", "dist", "bin.mjs"));
      return [...collectUnpackedAsarFiles(getRawHeader(asarPath).header)].sort();
    },
    catch: (cause) =>
      new WindowsPackagedPayloadValidationError({
        reason: "sidecar-invalid",
        packagedAppDir,
        cause,
      }),
  });
  if (unpackedFiles.length === 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-invalid",
      packagedAppDir,
      cause: new Error("server.asar does not declare any unpacked native files"),
    });
  }

  const missingFiles: string[] = [];
  for (const unpackedFile of unpackedFiles) {
    const unpackedPath = path.join(
      resourcesDir,
      `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`,
      ...unpackedFile.split("/"),
    );
    if (!(yield* isFile(unpackedPath))) {
      missingFiles.push(`${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/${unpackedFile}`);
    }
  }
  if (missingFiles.length > 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "unpacked-native-missing",
      packagedAppDir,
      missingFiles,
    });
  }

  const resourceMonitorPath = path.join(
    resourcesDir,
    "resource-monitor",
    resourceMonitorExecutableName("win"),
  );
  if (!(yield* isFile(resourceMonitorPath))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "resource-monitor-missing",
      packagedAppDir,
      missingFiles: ["resource-monitor/goat-resource-monitor.exe"],
    });
  }

  const wslArchivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
  const wslArchiveHashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
  const [hasWslArchive, hasWslArchiveHash] = yield* Effect.all([
    isFile(wslArchivePath),
    isFile(wslArchiveHashPath),
  ]);
  if (input.expectWslRuntime === true && (!hasWslArchive || !hasWslArchiveHash)) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "wsl-runtime-missing",
      packagedAppDir,
      missingFiles: [
        ...(hasWslArchive ? [] : [WSL_RUNTIME_ARCHIVE_NAME]),
        ...(hasWslArchiveHash ? [] : [WSL_RUNTIME_ARCHIVE_HASH_NAME]),
      ],
    });
  }
  if (hasWslArchive !== hasWslArchiveHash) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "wsl-runtime-missing",
      packagedAppDir,
      missingFiles: [hasWslArchive ? WSL_RUNTIME_ARCHIVE_HASH_NAME : WSL_RUNTIME_ARCHIVE_NAME],
    });
  }
  if (hasWslArchive && hasWslArchiveHash) {
    const invalidWslRuntime = (cause: unknown) =>
      new WindowsPackagedPayloadValidationError({
        reason: "wsl-runtime-invalid",
        packagedAppDir,
        cause,
      });
    const recordedHash = yield* fs
      .readFileString(wslArchiveHashPath)
      .pipe(Effect.mapError(invalidWslRuntime));
    const expectedHash = recordedHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      return yield* invalidWslRuntime(new Error("invalid WSL runtime SHA-256 sidecar"));
    }
    const archiveHash = NodeCrypto.createHash("sha256");
    yield* fs.stream(wslArchivePath).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => archiveHash.update(chunk))),
      Effect.mapError(invalidWslRuntime),
    );
    const actualHash = archiveHash.digest("hex");
    if (actualHash !== expectedHash) {
      return yield* invalidWslRuntime(
        new Error(`WSL runtime SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`),
      );
    }

    const hostPlatform = yield* HostProcess.Platform;
    const listing = yield* spawnAndCollectOutput(
      ChildProcess.make(
        hostPlatform === "win32" ? windowsSystemTar() : "tar",
        ["-tzf", WSL_RUNTIME_ARCHIVE_NAME],
        {
          cwd: resourcesDir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    ).pipe(Effect.mapError(invalidWslRuntime));
    if (listing.exitCode !== 0) {
      return yield* invalidWslRuntime(
        new Error(`tar could not list WSL runtime archive: ${listing.stderr.trim()}`),
      );
    }
    const members = parseWslRuntimeArchiveMembers(listing.stdout);
    // A release archive unpacks to one directory named after its stem; the
    // desktop app's WSL install script relies on that layout to find `goat`.
    const stem = wslRuntimeArchiveStem(input.appVersion, input.targetArch);
    const topLevel = new Set(members.map((member) => member.split("/")[0]));
    if (topLevel.size !== 1 || !topLevel.has(stem)) {
      return yield* invalidWslRuntime(
        new Error(
          `WSL runtime archive must contain a single top-level directory ${stem}, found ${[...topLevel].join(", ") || "nothing"}`,
        ),
      );
    }
    const requiredMembers = [`${stem}/goat`, `${stem}/client`, `${stem}/node_modules`];
    const missingMembers = requiredMembers.filter((member) => !members.includes(member));
    const ptyCandidates = [
      `${stem}/node_modules/node-pty/build/Release/pty.node`,
      `${stem}/node_modules/node-pty/prebuilds/linux-${input.targetArch}/pty.node`,
    ];
    if (!ptyCandidates.some((member) => members.includes(member))) {
      missingMembers.push(...ptyCandidates);
    }
    if (missingMembers.length > 0) {
      return yield* new WindowsPackagedPayloadValidationError({
        reason: "wsl-runtime-invalid",
        packagedAppDir,
        missingFiles: missingMembers,
        cause: new Error("WSL runtime archive is not a Linux CLI release archive"),
      });
    }
    const bundleEntry = members.find((member) => member.endsWith("/bin.mjs"));
    if (bundleEntry !== undefined) {
      return yield* invalidWslRuntime(
        new Error(`WSL runtime archive contains a server bundle entry ${bundleEntry}`),
      );
    }
  }

  const fileCount = yield* countPayloadFiles(packagedAppDir);
  if (fileCount > fileLimit) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "file-limit-exceeded",
      packagedAppDir,
      fileCount,
      fileLimit,
    });
  }

  yield* verifyWindowsPackagedRuntime({
    packagedAppDir,
    appExecutableName: input.appExecutableName,
    targetArch: input.targetArch,
    verbose: input.verbose ?? false,
  });

  yield* Effect.log(
    `[desktop-artifact] Validated Windows payload (${String(fileCount)} files, ${String(unpackedFiles.length)} sidecar natives).`,
  );
  return { packagedAppDir, fileCount, unpackedFiles } as const;
});

const buildDesktopArtifactUnlocked = Effect.fn("buildDesktopArtifactUnlocked")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  const vp = yield* resolveVp(repoRoot);
  if (hostPlatform === "linux" && options.platform === "linux") {
    yield* preflightLinuxDesktopBuild(options.arch);
  }
  if (hostPlatform === "darwin" && options.platform === "mac") {
    yield* preflightMacDesktopBuild(options.arch);
  }
  if (hostPlatform === "win32" && options.platform === "win") {
    yield* preflightWindowsDesktopBuild({
      arch: options.arch,
    });
  }
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });
  const resolvedServerRuntimeExternalDependencies = selectCliRuntimeExternalDependencies(
    resolvedServerDependencies,
  );
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version;
  const iconAssets = resolveDesktopBuildIconAssets(appVersion);
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `goat-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* buildDesktopBundlesUnlocked(repoRoot, appVersion, options.verbose);
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }
  yield* verifyBuiltServerVersion({
    serverDist: distDirs.serverDist,
    expectedVersion: appVersion,
  });

  // An inlined native loader resolves its prebuilds relative to the bundle and
  // quietly falls back to a slower pure-JS path, so this fails the build rather
  // than shipping a silent regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );
    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();
    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;
      for (const name of scan.inlined) inlined.add(name);
      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }
    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }
    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }
    const nativeInlined: string[] = [];
    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);
      if (packageDir === null) continue;
      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }
    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = resolveDesktopWebAssetBrand(appVersion);
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));
  yield* validateSandboxedPreloads(distDirs.desktopDist);

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  if (options.platform !== "win") {
    yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });
  }

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  if (options.platform === "linux") {
    const extensionDir = path.join(stageAppDir, "apps/desktop/gnome-extension");
    yield* fs.makeDirectory(extensionDir, { recursive: true });
    for (const file of gnomeCaptureBundle.files) {
      yield* fs.copyFile(
        path.join(repoRoot, "apps/desktop/gnome-extension", file),
        path.join(extensionDir, file),
      );
    }
  }
  if (options.platform === "mac" && options.target === "dmg") {
    yield* stageDesktopDmgBackground(
      stageResourcesDir,
      resolveDesktopUpdateChannel(appVersion),
      options.verbose,
    );
  }
  if (options.platform !== "win") {
    yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  }
  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });
  if (options.platform === "linux") {
    for (const backend of ["kde", "hyprland"] as const)
      yield* stageLinuxCaptureHelper({
        backend,
        repoRoot,
        stageResourcesDir,
        arch: options.arch,
        verbose: options.verbose,
      });
  }
  yield* stageBrowserSecret({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });
  yield* stageCuaDriverExecutable({
    repoRoot,
    stageRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
  });
  // Signed mac builds always carry the Developer ID helper (#1351); --computer-use-helper adds
  // an ad-hoc one to an unsigned build.
  const computerUseHelper = options.computerUseHelper
    ? yield* stageComputerUseHelper({
        repoRoot,
        stageRoot,
        platform: options.platform,
        appId: resolveDesktopAppId(appVersion),
        signed: options.signed,
      })
    : signedComputerUseHelper(
        yield* stageDesktopComputerUseHelper({
          repoRoot,
          output: path.join(stageRoot, "computer-use-helper"),
          channel: resolveDesktopUpdateChannel(appVersion),
          signed: options.platform === "mac" && options.signed,
        }),
        resolveDesktopAppId(appVersion),
      );

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  const stageProdResourcesDir = path.join(stageAppDir, "apps/desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);
  yield* fs.copyFile(
    path.join(repoRoot, "LICENSE"),
    path.join(stageProdResourcesDir, "LICENSE-T3CODE.txt"),
  );

  const configuredMacPasskeySigning = yield* Effect.try({
    try: () =>
      resolveOptionalMacPasskeySigningConfiguration(
        { ...options, version: appVersion },
        loadRepoEnv({ repoRoot }),
      ),
    catch: MacPasskeySigningConfigurationResolutionError.fromCause,
  });
  const macPasskeySigning = configuredMacPasskeySigning
    ? {
        ...configuredMacPasskeySigning,
        provisioningProfilePath: path.resolve(
          repoRoot,
          configuredMacPasskeySigning.provisioningProfilePath,
        ),
      }
    : undefined;
  const macEntitlementsPath = macPasskeySigning
    ? path.join(stageAppDir, "entitlements.mac.plist")
    : undefined;
  let macWebAuthn: MacWebAuthnEntitlements | undefined;
  if (macPasskeySigning && macEntitlementsPath) {
    if (!(yield* fs.exists(macPasskeySigning.provisioningProfilePath))) {
      return yield* new MacProvisioningProfileNotFoundError({
        provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
      });
    }
    macWebAuthn = resolveMacWebAuthnEntitlements(
      yield* fs.readFileString(macPasskeySigning.provisioningProfilePath),
      macPasskeySigning,
    );
    yield* Effect.log(
      `[desktop-artifact] In-app browser passkeys: Touch ID ${macWebAuthn.touchIdKeychainAccessGroup ? "enabled" : "disabled"}, browser passkeys ${macWebAuthn.browserPasskeys ? "enabled" : "disabled"}.`,
    );
    yield* fs.writeFileString(
      macEntitlementsPath,
      renderMacPasskeyEntitlements(macPasskeySigning, macWebAuthn),
    );
  }

  const stageDependencies =
    options.platform === "win"
      ? { ...resolvedDesktopRuntimeDependencies }
      : resolveMergedStageDependencies({
          platform: options.platform,
          serverDependencies: resolvedServerDependencies,
          desktopDependencies: resolvedDesktopRuntimeDependencies,
          arch: options.arch,
          fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
        });
  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const windowsServerAsarPath =
    options.platform === "win"
      ? path.join(stageAppDir, WINDOWS_SERVER_RESOURCE_SOURCE_DIR, WINDOWS_SERVER_ASAR_RESOURCE)
      : undefined;
  const stagePackageJson: StagePackageJson = {
    name: "t3code",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    // Read by apps/desktop/src/preview/Passkeys.ts; must match the signed entitlements.
    ...(macWebAuthn ? { t3codeWebAuthn: macWebAuthn } : {}),
    private: true,
    packageManager: rootPackageJson.packageManager,
    description:
      "GOAT is an open-source desktop app for coding agents. Work with your existing agent subscriptions, review code changes, and run commands in your projects. Connect from desktop, web, or mobile to continue working remotely.",
    license: "MIT",
    // Required by the .deb control file. Public: the source repository is private (D-10).
    homepage: `https://github.com/${DESKTOP_UPDATE_REPOSITORY}`,
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/boot.cjs",
    build: withComputerUseHelper(
      yield* createBuildConfig(
        options.platform,
        options.target,
        appVersion,
        options.signed,
        options.mockUpdates,
        options.mockUpdateServerPort,
        macPasskeySigning && macEntitlementsPath
          ? {
              entitlementsPath: macEntitlementsPath,
              provisioningProfilePath: macPasskeySigning.provisioningProfilePath,
            }
          : undefined,
        bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime }),
        options.arch,
        options.sshRuntimeArchiveDir !== undefined,
        computerUseHelper?.bundle,
      ),
      computerUseHelper,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  const stageWorkspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });
  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand(vp, [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );
  yield* stageClerkPasskeyNativeBinaries(stageAppDir, options.platform, options.arch);
  yield* stageKeyringNativeBinaries(stageAppDir, options.platform, options.arch);

  if (options.platform === "win" && windowsServerAsarPath) {
    yield* stageWindowsServerSidecar({
      stageRoot,
      repoRoot,
      serverDistDir: distDirs.serverDist,
      arch: options.arch,
      appVersion,
      runtimeExternalDependencies: resolvedServerRuntimeExternalDependencies,
      fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
      allowBuilds: workspaceAllowBuilds,
      patchedDependencies: workspacePatchedDependencies,
      overrides: resolvedOverrides,
      asarPath: windowsServerAsarPath,
      verbose: options.verbose,
      vp,
    });
  }
  yield* stageCursorSdkPlatformPackages(
    path.join(
      options.platform === "win" ? path.join(stageRoot, "server") : stageAppDir,
      "node_modules",
    ),
    path.join(stageProdResourcesDir, "cursor-sdk"),
  );
  if (
    options.wslRuntime !== undefined &&
    bundlesWslRuntime({ platform: options.platform, runtimeArchivePath: options.wslRuntime })
  ) {
    yield* stageWslRuntimeArchive({
      sourceArchivePath: options.wslRuntime,
      archivePath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from),
      hashPath: path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from),
    });
  }

  if (options.sshRuntimeArchiveDir !== undefined) {
    yield* stageSshRuntimeArchives({
      sourceDirectory: path.resolve(repoRoot, options.sshRuntimeArchiveDir),
      destinationDirectory: path.join(stageAppDir, SSH_RUNTIME_RESOURCE_SOURCE_DIR),
      version: appVersion,
      requireAll: options.requireAllSshRuntimes,
    });
  }

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  let buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...computerUseHelperEnvironment(computerUseHelper),
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (options.platform === "linux") {
    // fpm compresses the .deb with the system xz through tar. Threaded mode
    // takes seconds on a many-core runner instead of about two minutes.
    buildEnv.XZ_DEFAULTS = "-T0";
  }
  if (options.platform === "win") {
    // Windows signs only through Azure Trusted Signing. Off Windows,
    // electron-builder's signtool manager would read CSC_LINK (the macOS
    // certificate) as a Windows certificate.
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  const { resolveMacNotarizationEnv, DesktopNotarizationCredentialsMissingError } =
    yield* Effect.promise(() => import("./lib/mac-notarization.ts"));
  const notarization = resolveMacNotarizationEnv(buildEnv, {
    signed: options.signed,
    platform: options.platform,
    requireNotarization:
      (yield* Config.String("GOAT_REQUIRE_NOTARIZATION").pipe(Config.withDefault("0"))) === "1",
  });
  if (notarization.problem) {
    return yield* new DesktopNotarizationCredentialsMissingError({ detail: notarization.problem });
  }
  buildEnv = notarization.env;

  if (hostPlatform === "win32") {
    const python = yield* resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }
  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      ...(options.platform === "mac" ? ["electron-osx-sign*", "electron-notarize*"] : []),
    ];
    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@goat/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand(vp, builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @goat/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  if (computerUseHelper) yield* verifyEmbeddedComputerUseHelper(stageDistDir, computerUseHelper);

  if (options.platform === "win") {
    yield* validateWindowsPackagedPayload({
      stageDistDir,
      appExecutableName: `${resolveDesktopProductName(appVersion)}.exe`,
      targetArch: options.arch,
      appVersion,
      expectWslRuntime: bundlesWslRuntime({
        platform: options.platform,
        runtimeArchivePath: options.wslRuntime,
      }),
      verbose: options.verbose,
    });
  }

  if (options.sshRuntimeArchiveDir !== undefined) {
    yield* validatePackagedSshRuntimeArchives({
      stageDistDir,
      version: appVersion,
      requireAll: options.requireAllSshRuntimes,
    });
  }

  if (options.payloadReport !== undefined) {
    const problems = yield* scanReleasePayload(stageDistDir);
    yield* writePayloadReport(
      stageDistDir,
      options.payloadReport,
      `desktop-${options.platform}-${options.arch}`,
      appVersion,
      problems,
    );
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  return yield* withDesktopBuildLock(repoRoot, buildDesktopArtifactUnlocked(options));
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: GOAT_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: GOAT_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: GOAT_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription(
      "Compiled bundle and desktop package version (env: GOAT_DESKTOP_VERSION).",
    ),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: GOAT_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: GOAT_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: GOAT_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.Boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: GOAT_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  computerUseHelper: Flag.Boolean("computer-use-helper").pipe(
    Flag.withDescription(
      "Embed an ad-hoc GOAT Computer Use.app in an unsigned macOS build; signed builds always carry the Developer ID helper (env: GOAT_DESKTOP_COMPUTER_USE_HELPER).",
    ),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: GOAT_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.Boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: GOAT_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.Int("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: GOAT_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  payloadReport: Flag.String("payload-report").pipe(
    Flag.withDescription("Payload verification report (env: GOAT_DESKTOP_PAYLOAD_REPORT)."),
    Flag.optional,
  ),
  sshRuntimeArchiveDir: Flag.String("ssh-runtime-archive-dir").pipe(
    Flag.withDescription("Directory of exact-version SSH CLI archives to bundle read-only."),
    Flag.optional,
  ),
  requireAllSshRuntimes: Flag.Boolean("require-all-ssh-runtimes").pipe(
    Flag.withDescription(
      "Require darwin-arm64, linux-x64 and linux-arm64 (CI requires them unless bundle omission is explicitly allowed).",
    ),
    Flag.optional,
  ),
  wslRuntime: Flag.String("wsl-runtime").pipe(
    Flag.withDescription(
      "Path to the Linux CLI release archive (goat-<version>-linux-x64.tar.gz) to embed as the WSL runtime of a Windows build (env: GOAT_DESKTOP_WSL_RUNTIME).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for GOAT."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
