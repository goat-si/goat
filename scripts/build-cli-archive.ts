#!/usr/bin/env node
/**
 * The archive is the unit every runtime installer downloads, so nothing in it
 * may require Node, npm, or a compiler on the machine that unpacks it.
 */
// Adopts legacy T3 env names before anything reads the environment.
import "@goat/contracts/adoptLegacyEnv";
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@goat/shared/HostProcess";
import { ownRuntimeManifest, RUNTIME_MANIFEST_ARCHIVE_ENTRY } from "@goat/shared/runtimeManifest";
import { resolveBuildCommit, resolveBuildCommitTime } from "./lib/build-commit-time.ts";
import { fromYaml } from "@goat/shared/schemaYaml";
import { resolveSpawnCommand } from "@goat/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
} from "./build-desktop-artifact.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { signWithJsign } from "./lib/windows-jsign.ts";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { isMachO } from "./lib/release-verify.ts";
import { neutralizeBuildRoot } from "./lib/sea-build-path.ts";

/** Copies cached helper outputs while emitting only the current binary name. */
export const stageCliResourceMonitor = Effect.fn("stageCliResourceMonitor")(function* (
  sourceDir: string,
  destinationDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(sourceDir, destinationDir);
  for (const entry of yield* fs.readDirectory(destinationDir, { recursive: true })) {
    const name = path.basename(entry);
    if (
      name !== LEGACY_RESOURCE_MONITOR_BINARY_NAME &&
      name !== `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}.exe`
    )
      continue;
    const legacyPath = path.join(destinationDir, entry);
    const currentPath = path.join(
      path.dirname(legacyPath),
      `goat-resource-monitor${name.endsWith(".exe") ? ".exe" : ""}`,
    );
    if (yield* fs.exists(currentPath)) {
      yield* fs.remove(legacyPath);
    } else {
      yield* fs.rename(legacyPath, currentPath);
    }
  }
});

export const stageCliRuntimeManifest = Effect.fn("stageCliRuntimeManifest")(function* (
  contentDir: string,
  input: Parameters<typeof ownRuntimeManifest>[0],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(contentDir, RUNTIME_MANIFEST_ARCHIVE_ENTRY),
    `${yield* encodeJsonString(ownRuntimeManifest(input))}\n`,
  );
});

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64"]);
type BuildPlatform = typeof BuildPlatform.Type;
type BuildArch = typeof BuildArch.Type;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class CliArchiveCommandFailedError extends Schema.TaggedError<CliArchiveCommandFailedError>()(
  "CliArchiveCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class CliArchiveInputMissingError extends Schema.TaggedError<CliArchiveInputMissingError>()(
  "CliArchiveInputMissingError",
  { inputPath: Schema.String, hint: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.inputPath}. ${this.hint}`;
  }
}

export function cliArchivePlatformKey(platform: BuildPlatform, arch: BuildArch): string {
  const nodePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return `${nodePlatform}-${arch}`;
}

export function cliArchiveStem(version: string, platform: BuildPlatform, arch: BuildArch): string {
  return `goat-${version}-${cliArchivePlatformKey(platform, arch)}`;
}

export function cliArchiveFileName(version: string, platform: BuildPlatform, arch: BuildArch) {
  // gzip rather than xz: GNU tar needs an external xz binary for -J, which
  // minimal hosts lack, while every tar (and Node's zlib) handles gzip alone.
  return `${cliArchiveStem(version, platform, arch)}.${platform === "win" ? "zip" : "tar.gz"}`;
}

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.isStandardCommand(command)
      ? ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "inherit",
          stderr: "inherit",
        })
      : command,
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new CliArchiveCommandFailedError({ command: label, exitCode });
  }
});

const requireInput = Effect.fn("requireInput")(function* (inputPath: string, hint: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(inputPath))) {
    return yield* new CliArchiveInputMissingError({ inputPath, hint });
  }
});

/**
 * The tree is archived and unpacked on machines without pnpm, so the store
 * layout cannot be relied on to survive the trip.
 */
const stageRuntimeExternals = Effect.fn("stageRuntimeExternals")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const fffNodeVersion = serverDependencies["@ff-labs/fff-node"];
  if (fffNodeVersion === undefined) {
    return yield* new CliArchiveInputMissingError({
      inputPath: "apps/server/package.json#dependencies['@ff-labs/fff-node']",
      hint: "The archive stages fff's platform binary from this version.",
    });
  }
  const dependencies = {
    ...selectCliRuntimeExternalDependencies(serverDependencies),
    ...resolveFffNativeDependencies(input.platform, input.arch, fffNodeVersion),
  };
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  yield* fs.writeFileString(
    path.join(input.stageDir, "package.json"),
    `${yield* encodeJsonString({
      name: "goat-runtime",
      version: input.version,
      private: true,
      packageManager: rootPackageJson.packageManager,
      dependencies,
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(input.stageDir, "pnpm-workspace.yaml"),
    yield* encodeStageWorkspaceConfig({
      ...createStageWorkspaceConfig({
        platform: input.platform,
        arch: input.arch,
        ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
        patchedDependencies,
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
      }),
      nodeLinker: "hoisted",
    }),
  );
  if (Object.keys(patchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
  }

  const install = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(install.command, install.args, {
      cwd: input.stageDir,
      shell: install.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
    "vp install --prod (cli archive runtime externals)",
  );

  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  const prebuildsDir = path.join(input.stageDir, "node_modules/node-pty/prebuilds");
  const foreignPrebuilds = (yield* fs
    .readDirectory(prebuildsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))).filter(
    (entry) => entry !== platformKey,
  );
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
    ...foreignPrebuilds.map((entry) => `node_modules/node-pty/prebuilds/${entry}`),
  ]) {
    yield* fs.remove(path.join(input.stageDir, entry), { recursive: true, force: true });
  }
  // A hoisted install still leaves nested `node_modules/.bin` shim directories
  // inside packages that declare bins (msgpackr-extract's). They are symlinks
  // nothing runs, and the npm registry refuses a tarball that contains any
  // symlink, so strip every `.bin` directory below node_modules.
  yield* removeNestedBinDirectories(fs, path, path.join(input.stageDir, "node_modules"));
});

const removeNestedBinDirectories = Effect.fn("build-cli-archive.removeNestedBinDirectories")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const child = path.join(root, entry);
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true, force: true });
        continue;
      }
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        yield* removeNestedBinDirectories(fs, path, child);
      }
    }
  },
);

const stageWebClient = Effect.fn("stageWebClient")(function* (source: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(source, target);
  const maps = (yield* fs.readDirectory(target, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) {
    yield* fs.remove(path.join(target, entry), { force: true });
  }
});

const MacSigningConfig = Config.all({
  identity: Config.String("GOAT_CLI_MAC_SIGN_IDENTITY").pipe(Config.option),
  appleKeychainProfile: Config.String("APPLE_KEYCHAIN_PROFILE").pipe(Config.option),
  appleKeychain: Config.String("APPLE_KEYCHAIN").pipe(Config.option),
  appleApiKey: Config.String("APPLE_API_KEY").pipe(Config.option),
  appleApiKeyId: Config.String("APPLE_API_KEY_ID").pipe(Config.option),
  appleApiIssuer: Config.String("APPLE_API_ISSUER").pipe(Config.option),
  requireNotarization: Config.String("GOAT_REQUIRE_NOTARIZATION").pipe(Config.withDefault("0")),
});

/**
 * Apple Silicon refuses to run unsigned Mach-O binaries at all, so the
 * executable is always signed: ad hoc when no identity is configured, or with
 * the Developer ID plus notarization when it is. The hardened runtime that
 * notarization requires only loads signed libraries, so every native addon in
 * the archive is signed with the same identity.
 */
export const signMacArchiveContents = Effect.fn("signMacArchiveContents")(function* (input: {
  readonly repoRoot: string;
  readonly contentDir: string;
  readonly executablePath: string;
  readonly requireNotarization: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const signing = yield* MacSigningConfig;
  const identity = Option.getOrUndefined(signing.identity)?.trim() || "-";
  const {
    notarytoolAuthArgs,
    parseNotarytoolSubmitOutput,
    NotarytoolSubmitError,
    isNotarytoolSubmitError,
    CliNotarizationCredentialsMissingError,
  } = yield* Effect.promise(() => import("./lib/mac-notarization.ts"));
  const authArgs = notarytoolAuthArgs({
    appleKeychainProfile: Option.getOrUndefined(signing.appleKeychainProfile),
    appleKeychain: Option.getOrUndefined(signing.appleKeychain),
    appleApiKey: Option.getOrUndefined(signing.appleApiKey),
    appleApiKeyId: Option.getOrUndefined(signing.appleApiKeyId),
    appleApiIssuer: Option.getOrUndefined(signing.appleApiIssuer),
  });
  if (input.requireNotarization || signing.requireNotarization === "1") {
    if (identity === "-") {
      return yield* new CliNotarizationCredentialsMissingError({
        detail:
          "Required notarization needs a Developer ID in GOAT_CLI_MAC_SIGN_IDENTITY; ad hoc signing is not allowed.",
      });
    }
    if (!authArgs) {
      return yield* new CliNotarizationCredentialsMissingError({
        detail:
          "Required notarization needs APPLE_KEYCHAIN_PROFILE or the complete APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER set.",
      });
    }
  }

  const entitlements = path.join(input.repoRoot, "apps/server/resources/cli-entitlements.plist");
  const entries = yield* fs.readDirectory(input.contentDir, { recursive: true });
  const libraries = entries
    .filter(
      (entry) =>
        entry.endsWith(".node") ||
        entry.endsWith(".dylib") ||
        entry.endsWith("spawn-helper") ||
        entry.endsWith("goat-resource-monitor"),
    )
    .map((entry) => path.join(input.contentDir, entry));
  // Vendor executables such as the Cursor SDK's cursorsandbox and rg carry their
  // vendor's Developer ID. Every Mach-O in a GOAT archive carries GOAT's, which the
  // desktop app's signature verification requires, so they are re-signed too.
  for (const entry of entries) {
    const target = path.join(input.contentDir, entry);
    if (path.basename(entry).includes(".") || libraries.includes(target)) continue;
    if (target === input.executablePath) continue;
    const binary = yield* fs.readFile(target).pipe(
      Effect.map(isMachO),
      Effect.orElseSucceed(() => false),
    );
    if (binary) libraries.push(target);
  }

  for (const target of [...libraries, input.executablePath]) {
    yield* runCommand(
      ChildProcess.make("codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
        ...(target === input.executablePath ? ["--entitlements", entitlements] : []),
        target,
      ]),
      `codesign ${path.relative(input.contentDir, target)}`,
    );
  }
  if (identity === "-") {
    yield* Effect.log("[cli-archive] Signed ad hoc (no GOAT_CLI_MAC_SIGN_IDENTITY).");
    return;
  }

  if (!authArgs) {
    yield* Effect.logWarning(
      "[cli-archive] Developer ID signed but not notarized (missing profile or complete API credentials).",
    );
    return;
  }
  const Stream = yield* Effect.promise(() => import("effect/Stream"));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runNotarytool = Effect.fn("runNotarytool")(function* (args: ReadonlyArray<string>) {
    const child = yield* spawner.spawn(
      ChildProcess.make("xcrun", ["notarytool", ...args, ...authArgs], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(child.stdout)),
        Stream.mkString(Stream.decodeText(child.stderr)),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });
  // Submit every native dependency alongside the executable. The temporary zip
  // stays outside the shipped tree, and scoped cleanup also covers rejection.
  yield* Effect.gen(function* () {
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-notarize-" });
    const notarizeZip = path.join(tempDir, "goat.zip");
    yield* runCommand(
      ChildProcess.make("ditto", ["-c", "-k", "--keepParent", input.contentDir, notarizeZip]),
      "ditto (notarization zip)",
    );
    const submission = yield* runNotarytool([
      "submit",
      notarizeZip,
      "--wait",
      "--output-format",
      "json",
    ]);
    yield* Effect.try({
      try: () => parseNotarytoolSubmitOutput(submission.stdout),
      catch: (cause) =>
        isNotarytoolSubmitError(cause)
          ? cause
          : new NotarytoolSubmitError({ detail: "Could not parse notarytool submission output." }),
    }).pipe(
      Effect.filterOrFail(
        () => submission.exitCode === 0,
        (accepted) =>
          new NotarytoolSubmitError({
            ...accepted,
            detail: `notarytool submit exited with code ${submission.exitCode}.`,
          }),
      ),
      Effect.catchTags({
        NotarytoolSubmitError: (error) =>
          Effect.gen(function* () {
            const log = error.id
              ? yield* runNotarytool(["log", error.id]).pipe(
                  Effect.map((result) =>
                    [
                      result.stdout,
                      result.stderr,
                      ...(result.exitCode === 0
                        ? []
                        : [`notarytool log exited with code ${result.exitCode}.`]),
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  ),
                  Effect.catch((cause) =>
                    Effect.succeed(`Could not fetch notarization log: ${String(cause)}`),
                  ),
                )
              : undefined;
            return yield* new NotarytoolSubmitError({
              id: error.id,
              status: error.status,
              detail: error.detail,
              log: [submission.stderr, log].filter(Boolean).join("\n"),
            });
          }),
      }),
    );
  }).pipe(Effect.scoped);
  yield* Effect.log("[cli-archive] Notarized goat.");
});

const WindowsSigningConfig = Config.all({
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT").pipe(Config.option),
  accountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME").pipe(Config.option),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME").pipe(
    Config.option,
  ),
});

/**
 * Node's --build-sea injects the blob into a copy of node.exe by rebuilding its
 * resource section but, unlike its Mach-O path, leaves node's original
 * Authenticode data-directory entry in the PE header. The file grows, so the
 * entry now points into the middle of the new section at bytes that are not a
 * certificate table.
 */
const stripStaleAuthenticodeEntry = Effect.fn("stripStaleAuthenticodeEntry")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(executablePath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (view.getUint32(peOffset, true) !== 0x00004550) {
    return yield* new CliArchiveInputMissingError({
      inputPath: executablePath,
      hint: "Expected a PE executable to strip the stale signature entry from.",
    });
  }
  const optionalHeader = peOffset + 24;
  const magic = view.getUint16(optionalHeader, true);
  // Data directories start at +112 (PE32+) or +96 (PE32); the certificate
  // table is directory index 4, eight bytes (file offset, size).
  const securityEntry = optionalHeader + (magic === 0x20b ? 112 : 96) + 4 * 8;
  const offset = view.getUint32(securityEntry, true);
  const size = view.getUint32(securityEntry + 4, true);
  if (offset === 0 && size === 0) return;
  if (offset + size === bytes.byteLength) {
    // A certificate table that still ends at EOF is intact; leave it for
    // signtool to replace rather than second-guessing it here.
    return;
  }
  view.setUint32(securityEntry, 0, true);
  view.setUint32(securityEntry + 4, 0, true);
  yield* fs.writeFile(executablePath, bytes);
  yield* Effect.log(
    `[cli-archive] Cleared the stale Authenticode entry (offset ${String(offset)}, size ${String(size)}) left by --build-sea.`,
  );
});

const signWindowsExecutable = Effect.fn("signWindowsExecutable")(function* (
  executablePath: string,
) {
  const signing = yield* WindowsSigningConfig;
  const endpoint = Option.getOrUndefined(signing.endpoint);
  const accountName = Option.getOrUndefined(signing.accountName);
  const profile = Option.getOrUndefined(signing.certificateProfileName);
  if (!endpoint || !accountName || !profile) {
    yield* Effect.log("[cli-archive] Windows signing disabled (missing Azure Trusted Signing).");
    return;
  }
  yield* stripStaleAuthenticodeEntry(executablePath);
  if ((yield* HostProcess.Platform) !== "win32") {
    yield* signWithJsign(executablePath);
    yield* Effect.log("[cli-archive] Signed goat.exe (Azure Trusted Signing via jsign).");
    return;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Invoke-TrustedSigning",
    `-Endpoint ${quote(endpoint)}`,
    `-CodeSigningAccountName ${quote(accountName)}`,
    `-CertificateProfileName ${quote(profile)}`,
    "-FileDigest 'SHA256'",
    "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
    "-TimestampDigest 'SHA256'",
    `-Files ${quote(executablePath)}`,
  ].join(" ");
  yield* runCommand(
    ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script]),
    "Invoke-TrustedSigning goat.exe",
  );
  yield* Effect.log("[cli-archive] Signed goat.exe (Azure Trusted Signing).");
});

const buildCliArchive = Effect.fn("buildCliArchive")(function* (input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly resourceMonitorDir: Option.Option<string>;
  readonly requireNotarization: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const executableName = input.platform === "win" ? "goat.exe" : "goat";
  // tsdown suffixes cross-built executables with their target (goat-darwin-x64);
  // a host build is plain goat. Prefer the exact target when both exist.
  const targetKey = `${input.platform === "mac" ? "darwin" : input.platform}-${input.arch}`;
  const targetExecutable = path.join(
    serverDir,
    "dist-exe",
    `goat-${targetKey}${input.platform === "win" ? ".exe" : ""}`,
  );
  // The unsuffixed host build is only a valid stand-in when it was built for
  // this platform and architecture; otherwise a missing target must fail.
  const hostPlatform = yield* HostProcess.Platform;
  const hostKey = `${hostPlatform === "win32" ? "win" : hostPlatform}-${yield* HostProcess.Architecture}`;
  const builtExecutable = (yield* fs.exists(targetExecutable))
    ? targetExecutable
    : targetKey === hostKey
      ? path.join(serverDir, "dist-exe", executableName)
      : targetExecutable;
  const webClient = path.join(serverDir, "dist/client");
  const resourceMonitorDir = Option.getOrElse(input.resourceMonitorDir, () =>
    path.join(serverDir, "dist/resource-monitor"),
  );

  yield* requireInput(
    builtExecutable,
    `Run \`node apps/server/scripts/cli.ts build-exe --target ${targetKey}\` first.`,
  );
  yield* requireInput(
    path.join(webClient, "index.html"),
    "Run `vp run --filter goat build` first.",
  );
  yield* requireInput(
    resourceMonitorDir,
    "Build the resource monitor or pass --resource-monitor-dir.",
  );

  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  const stageRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-archive-" });
  const contentDir = path.join(stageRoot, stem);
  yield* fs.makeDirectory(contentDir, { recursive: true });

  yield* Effect.log(`[cli-archive] Staging ${stem}...`);
  // Neutralize the checkout path Node's SEA blob records before the binary is signed.
  yield* fs.writeFile(
    path.join(contentDir, executableName),
    neutralizeBuildRoot(yield* fs.readFile(builtExecutable), repoRoot),
  );
  yield* fs.chmod(path.join(contentDir, executableName), 0o755);
  const rawCommitTime = resolveBuildCommitTime(repoRoot);
  yield* stageCliRuntimeManifest(contentDir, {
    version: input.version,
    commit: resolveBuildCommit(repoRoot),
    commitTime: /^[1-9][0-9]{0,15}$/.test(rawCommitTime) ? Number(rawCommitTime) : undefined,
  });
  // Upstream T3 Code's MIT notice travels with every GOAT archive.
  yield* fs.copyFile(path.join(repoRoot, "LICENSE"), path.join(contentDir, "LICENSE-T3CODE.txt"));
  yield* stageWebClient(webClient, path.join(contentDir, "client"));
  yield* stageCliResourceMonitor(resourceMonitorDir, path.join(contentDir, "resource-monitor"));
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: contentDir,
    platform: input.platform,
    arch: input.arch,
    version: input.version,
  });

  const executablePath = path.join(contentDir, executableName);
  if (input.platform === "mac") {
    yield* signMacArchiveContents({
      repoRoot,
      contentDir,
      executablePath,
      requireNotarization: input.requireNotarization,
    });
  } else if (input.platform === "win") {
    yield* signWindowsExecutable(executablePath);
  }
  if (input.platform !== "win") {
    yield* fs.chmod(executablePath, 0o755);
  }

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const archivePath = path.join(
    input.outputDir,
    cliArchiveFileName(input.version, input.platform, input.arch),
  );
  yield* fs.remove(archivePath, { force: true });
  if (input.platform === "win" && hostPlatform !== "win32") {
    yield* runCommand(
      ChildProcess.make("zip", ["-q", "-r", "-X", path.resolve(archivePath), stem], {
        cwd: stageRoot,
      }),
      "zip",
    );
  } else if (input.platform === "win") {
    // Windows ships bsdtar, which writes zip natively. Name it by path: under
    // the Git Bash shell CI uses, a bare `tar` is GNU tar, which neither
    // writes zip nor accepts a drive-letter path.
    yield* runCommand(
      ChildProcess.make(windowsSystemTar(), ["-a", "-c", "-f", archivePath, "-C", stageRoot, stem]),
      "tar (zip)",
    );
  } else {
    // On Linux, pnpm hard-links identical files out of its store and node-gyp
    // hard-links build outputs, and GNU tar records those as link entries.
    // The npm registry rejects a tarball containing any, and the npm platform
    // packages are re-packed from this archive's contents, so store every
    // file as a file. macOS's bsdtar has no such flag; pnpm clones there.
    // Key on the host's tar, since a Mac can cross-build a Linux archive.
    yield* runCommand(
      ChildProcess.make("tar", [
        ...(hostPlatform === "linux" ? ["--hard-dereference"] : []),
        "-czf",
        archivePath,
        "-C",
        stageRoot,
        stem,
      ]),
      "tar (gzip)",
    );
  }
  const stat = yield* fs.stat(archivePath);
  yield* Effect.log(`[cli-archive] Wrote ${archivePath} (${String(stat.size)} bytes).`);
  return archivePath;
});

const command = Command.make(
  "build-cli-archive",
  {
    platform: Flag.Literals("platform", BuildPlatform.literals),
    arch: Flag.Literals("arch", BuildArch.literals),
    version: Flag.String("version").pipe(
      Flag.withDescription("Release version for the archive name."),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("release-cli")),
    requireNotarization: Flag.Boolean("require-notarization").pipe(
      Flag.withDescription("Require Developer ID signing and accepted macOS notarization."),
      Flag.withDefault(false),
    ),
    resourceMonitorDir: Flag.String("resource-monitor-dir").pipe(
      Flag.withDescription(
        "Directory laid out like dist/resource-monitor (defaults to apps/server/dist/resource-monitor).",
      ),
      Flag.optional,
    ),
  },
  (input) => buildCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Package the goat single-executable into a per-platform archive."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
