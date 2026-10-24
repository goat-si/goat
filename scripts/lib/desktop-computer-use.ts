// @effect-diagnostics nodeBuiltinImport:off - Hashes the Cua Driver archive while it streams.
// The computer use payload of a desktop artifact: the Cua Driver GOAT runs in-process, and on
// macOS the "GOAT Computer Use.app" helper embedded in GOAT.app (ADR-0023).
import * as NodeCrypto from "node:crypto";

import {
  COMPUTER_USE_HELPER_NAME,
  computerUseHelperBundleId,
  cuaDriverRelease,
} from "@goat/shared/cuaDriverRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { buildComputerUseHelper } from "../build-computer-use-helper.ts";
import { runReleaseCommand } from "./release-verify.ts";
import { windowsSystemTar } from "./windows-tar.ts";

type DesktopPlatform = "mac" | "linux" | "win";
type DesktopArch = "arm64" | "x64" | "universal";

export class CuaDriverArtifactError extends Schema.TaggedError<CuaDriverArtifactError>()(
  "CuaDriverArtifactError",
  { message: Schema.String },
) {}

const run = Effect.fn("runComputerUseArtifactCommand")(function* (
  label: string,
  program: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* runReleaseCommand(program, args);
  if (result.exitCode !== 0)
    return yield* new CuaDriverArtifactError({
      message: `${label} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-800)}`,
    });
  return result;
});

export const stageCuaDriverExecutable = Effect.fn("stageCuaDriverExecutable")(function* (input: {
  readonly repoRoot: string;
  readonly stageRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: DesktopPlatform;
  readonly arch: DesktopArch;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const release = cuaDriverRelease(
    input.platform === "mac" ? "darwin" : input.platform === "win" ? "win32" : "linux",
    input.arch === "universal" ? "arm64" : input.arch,
  );
  if (!release) {
    return yield* new CuaDriverArtifactError({ message: "Unsupported Cua Driver build target." });
  }
  const cacheDir = path.join(input.repoRoot, "node_modules/.cache/goat/cua-driver");
  const archivePath = path.join(cacheDir, release.archiveName);
  const verified = Effect.fn("verifyCuaDriverArchive")(function* (file: string) {
    if (!(yield* fs.exists(file))) return false;
    if (Number((yield* fs.stat(file)).size) !== release.bytes) return false;
    const hash = NodeCrypto.createHash("sha256");
    yield* fs
      .stream(file)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
    return hash.digest("hex") === release.sha256;
  });
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  if (!(yield* verified(archivePath))) {
    yield* fs.remove(archivePath, { force: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({ directory: cacheDir });
        const downloadPath = path.join(temporary, release.archiveName);
        yield* run("download Cua Driver", "curl", [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "30",
          "--max-time",
          "600",
          "--retry",
          "3",
          "--output",
          downloadPath,
          release.url,
        ]);
        if (!(yield* verified(downloadPath))) {
          return yield* new CuaDriverArtifactError({
            message: `Cua Driver archive failed size/SHA-256 verification: ${release.archiveName}`,
          });
        }
        yield* fs.rename(downloadPath, archivePath);
      }),
    );
  }
  yield* fs.makeDirectory(input.stageRoot, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const extracted = yield* fs.makeTempDirectoryScoped({ directory: input.stageRoot });
      const hostPlatform = yield* HostProcess.Platform;
      if (release.format === "zip" && hostPlatform !== "win32")
        yield* run("extract Cua Driver", "unzip", ["-q", archivePath, "-d", extracted]);
      else
        yield* run("extract Cua Driver", hostPlatform === "win32" ? windowsSystemTar() : "tar", [
          "-xf",
          archivePath,
          "-C",
          extracted,
        ]);
      const requiredFiles = [
        release.executable,
        ...(input.platform === "win"
          ? ["cua-driver-uia.exe", "cua-cursor-theme.exe"]
          : input.platform === "linux"
            ? [
                "cua-cursor-theme",
                "wayland-helper/install.sh",
                "wayland-helper/winrects@cua/metadata.json",
                "wayland-helper/winrects@cua/extension.js",
              ]
            : []),
      ];
      for (const file of requiredFiles) {
        if ((yield* fs.stat(path.join(extracted, file))).type !== "File") {
          return yield* new CuaDriverArtifactError({
            message: `Cua Driver release is missing ${file}.`,
          });
        }
      }
      yield* fs.makeDirectory(input.stageResourcesDir, { recursive: true });
      const destination = path.join(input.stageResourcesDir, "cua-driver");
      yield* fs.remove(destination, { recursive: true, force: true });
      if (input.platform === "mac") {
        yield* fs.copyFile(path.join(extracted, release.executable), destination);
        yield* fs.chmod(destination, 0o755);
      } else {
        yield* fs.makeDirectory(destination, { recursive: true });
        // SDK libraries come from the app's npm dependencies, not this release.
        const entries =
          input.platform === "linux"
            ? [release.executable, "cua-cursor-theme", "wayland-helper"]
            : requiredFiles;
        for (const entry of entries) {
          yield* fs.copy(path.join(extracted, entry), path.join(destination, entry));
        }
        if (input.platform === "linux") {
          for (const executable of [release.executable, "cua-cursor-theme"]) {
            yield* fs.chmod(path.join(destination, executable), 0o755);
          }
        }
      }
    }),
  );
});

/** Where GOAT.app carries the helper, relative to Contents; DesktopCuaDriver looks there. */
export const COMPUTER_USE_HELPER_IN_APP = `Helpers/${COMPUTER_USE_HELPER_NAME}.app`;

export interface StagedComputerUseHelper {
  readonly bundle: string;
  readonly bundleId: string;
  /** Developer ID signed, so GOAT.app must carry the same team; otherwise ad-hoc. */
  readonly signed: boolean;
}

/**
 * Builds the helper for GOAT.app's channel. A signed build signs it with the Developer ID that
 * signs GOAT.app (GOAT_CLI_MAC_SIGN_IDENTITY, else the keychain's), and the helper then serves
 * only that app. An unsigned build gets an ad-hoc helper that serves any parent, because an
 * ad-hoc GOAT.app has no team for it to check.
 */
export const stageComputerUseHelper = Effect.fn("stageComputerUseHelper")(function* (input: {
  readonly repoRoot: string;
  readonly stageRoot: string;
  readonly platform: DesktopPlatform;
  readonly appId: string;
  readonly signed: boolean;
}) {
  if (input.platform !== "mac")
    return yield* new CuaDriverArtifactError({
      message: "--computer-use-helper embeds the macOS helper and applies to mac builds only.",
    });
  const path = yield* Path.Path;
  const identity = yield* Config.String("GOAT_CLI_MAC_SIGN_IDENTITY").pipe(Config.option);
  const built = yield* buildComputerUseHelper({
    repoRoot: input.repoRoot,
    output: path.join(input.stageRoot, "computer-use-helper"),
    channel: input.appId.endsWith(".nightly") ? "nightly" : "stable",
    identity: input.signed ? Option.getOrUndefined(identity) : "-",
    notaryProfile: undefined,
  });
  if (built.bundleId !== computerUseHelperBundleId(input.appId))
    return yield* new CuaDriverArtifactError({
      message: `The helper is ${built.bundleId}, but GOAT.app is ${input.appId}.`,
    });
  return { bundle: built.bundle, bundleId: built.bundleId, signed: input.signed };
});

/**
 * Adds the helper to GOAT.app's Contents and keeps electron-builder's signer off it, so GOAT.app
 * is sealed over the helper's own signature (inner binaries, then the helper, then GOAT.app).
 * Unsigned builds are signed ad-hoc so the nested seal still verifies.
 */
export function withComputerUseHelper(
  config: Record<string, unknown>,
  helper: StagedComputerUseHelper | undefined,
): Record<string, unknown> {
  if (!helper) return config;
  const mac = typeof config.mac === "object" && config.mac !== null ? config.mac : {};
  return {
    ...config,
    mac: {
      ...mac,
      extraFiles: [{ from: helper.bundle, to: COMPUTER_USE_HELPER_IN_APP }],
      signIgnore: [`/Contents/${COMPUTER_USE_HELPER_IN_APP.replaceAll(".", "\\.")}(/|$)`],
      ...(helper.signed ? {} : { identity: "-" }),
    },
  };
}

const codeSignature = Effect.fn("readCodeSignature")(function* (target: string) {
  // codesign -d writes its report to stderr.
  const { stderr } = yield* run("codesign -d", "codesign", ["-d", "--verbose=4", target]);
  const field = (name: string) => new RegExp(`^${name}=(.+)$`, "mu").exec(stderr)?.[1]?.trim();
  return { cdhash: field("CDHash"), team: field("TeamIdentifier") };
});

/**
 * What is wrong with a helper as GOAT.app carries it; empty when it is the one that was built.
 * The code directory hash covers the helper's Info.plist, executable and resources, so an equal
 * hash also proves electron-builder did not re-sign it with GOAT.app's entitlements.
 */
export function embeddedHelperProblems(input: {
  readonly helper: StagedComputerUseHelper;
  readonly built: { readonly cdhash: string | undefined };
  readonly embedded: { readonly cdhash: string | undefined; readonly team: string | undefined };
  readonly app: { readonly team: string | undefined };
}): string[] {
  const problems: string[] = [];
  if (!input.embedded.cdhash || input.embedded.cdhash !== input.built.cdhash)
    problems.push(
      "The embedded helper is not the helper that was built and signed; it was re-signed.",
    );
  if (input.helper.signed && (!input.app.team || input.app.team === "not set"))
    problems.push("GOAT.app has no Developer ID team.");
  else if (input.helper.signed && input.embedded.team !== input.app.team)
    problems.push(
      `The helper is signed by team ${input.embedded.team ?? "none"} and GOAT.app by ${input.app.team}; the helper would refuse its parent.`,
    );
  return problems;
}

/** Checks every GOAT.app electron-builder produced carries the helper as it was signed. */
export const verifyEmbeddedComputerUseHelper = Effect.fn("verifyEmbeddedComputerUseHelper")(
  function* (distDir: string, helper: StagedComputerUseHelper) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const built = yield* codeSignature(helper.bundle);
    const apps: string[] = [];
    for (const entry of yield* fs.readDirectory(distDir))
      if (entry === "mac" || entry.startsWith("mac-"))
        for (const app of yield* fs.readDirectory(path.join(distDir, entry)))
          if (app.endsWith(".app")) apps.push(path.join(distDir, entry, app));
    if (apps.length === 0)
      return yield* new CuaDriverArtifactError({ message: `No GOAT.app under ${distDir}.` });
    for (const app of apps) {
      const embedded = path.join(app, "Contents", COMPUTER_USE_HELPER_IN_APP);
      yield* run("codesign --verify GOAT.app", "codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        app,
      ]);
      const problems = embeddedHelperProblems({
        helper,
        built,
        embedded: yield* codeSignature(embedded),
        app: yield* codeSignature(app),
      });
      if (problems.length > 0)
        return yield* new CuaDriverArtifactError({ message: `${app}: ${problems.join(" ")}` });
      yield* Effect.log(`[desktop-artifact] ${COMPUTER_USE_HELPER_NAME} embedded in ${app}.`);
    }
  },
);
