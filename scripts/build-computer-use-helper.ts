#!/usr/bin/env node
// Builds and signs "GOAT Computer Use.app", the macOS helper that owns computer use's TCC
// identity and runs the pinned Cua Driver as its direct child. See
// apps/desktop/native/computer-use-helper/main.swift for what the helper does at runtime.
//
//   node scripts/build-computer-use-helper.ts --channel dev
//   GOAT_CUA_HELPER_PATH="$PWD/apps/desktop/.computer-use-helper/GOAT Computer Use.app" vp run dev
//
// Signing goes inside out (driver binaries, then the helper); GOAT.app is signed last by
// whoever embeds the helper. A Developer ID identity in the keychain is used when present.
// Without one only dev builds are allowed, ad-hoc signed: their cdhash changes per build, so
// macOS asks for Accessibility and Screen Recording again after each rebuild.
import "@goat/contracts/adoptLegacyEnv";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  COMPUTER_USE_HELPER_NAME,
  computerUseHelperBundleId,
  cuaDriverRelease,
} from "@goat/shared/cuaDriverRelease";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import {
  hashBytes,
  ReleaseVerificationError,
  requireReleaseCommand,
  runReleaseCommand,
  type ReleaseCommandRunner,
} from "./lib/release-verify.ts";

export type HelperChannel = "stable" | "nightly" | "dev";

const CHANNEL_APP_IDS: Record<HelperChannel, string> = {
  stable: "si.goat.desktop",
  nightly: "si.goat.desktop.nightly",
  dev: "si.goat.desktop.dev",
};

export const helperBundleIdForChannel = (channel: HelperChannel) =>
  computerUseHelperBundleId(CHANNEL_APP_IDS[channel]);

/**
 * The identity to sign with: an explicit one, else the first Developer ID Application in
 * `security find-identity` output. A release helper verifies its parent by Developer ID team, so
 * it signs ad-hoc ("-") only when asked to explicitly, for an unsigned local GOAT.app; such a
 * helper serves any parent (renderHelperInfoPlist).
 */
export function chooseSigningIdentity(input: {
  readonly channel: HelperChannel;
  readonly explicit: string | undefined;
  readonly findIdentityOutput: string;
}): { readonly identity: string } | { readonly error: string } {
  // Each valid identity line: index, SHA-1, quoted name.
  const developerIds = [
    ...input.findIdentityOutput.matchAll(
      /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/gmu,
    ),
  ].map(([, hash, name]) => ({ hash: hash ?? "", name: name ?? "" }));
  const identity = input.explicit?.trim() || developerIds[0]?.name || "-";
  if (input.channel === "dev" || input.explicit?.trim() === "-") return { identity };
  // A release helper checks its parent's Developer ID team, so it must carry one itself.
  return developerIds.some(({ hash, name }) => identity === name || identity.toUpperCase() === hash)
    ? { identity }
    : {
        error:
          "A " +
          input.channel +
          " helper must be signed with a Developer ID Application identity from this keychain.",
      };
}

export function renderHelperInfoPlist(
  template: string,
  input: { readonly bundleId: string; readonly version: string; readonly allowAnyParent: boolean },
): string {
  return template
    .replaceAll("@BUNDLE_ID@", input.bundleId)
    .replaceAll("@VERSION@", input.version)
    .replaceAll("@ALLOW_ANY_PARENT@", input.allowAnyParent ? "<true/>" : "<false/>");
}

const fail = (problem: string) => new ReleaseVerificationError({ problems: [problem] });

export const buildComputerUseHelper = Effect.fn("buildComputerUseHelper")(function* (input: {
  readonly repoRoot: string;
  readonly output: string;
  readonly channel: HelperChannel;
  readonly identity: string | undefined;
  readonly notaryProfile: string | undefined;
  readonly runner?: ReleaseCommandRunner;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = (program: string, args: readonly string[]) =>
    requireReleaseCommand(input.runner ?? runReleaseCommand, program, args);
  if ((yield* HostProcess.Platform) !== "darwin")
    return yield* fail("The helper builds on macOS only.");

  const release = cuaDriverRelease("darwin", "arm64");
  if (!release) return yield* fail("No pinned Cua Driver release for macOS.");
  // Same cache as the desktop artifact build, verified by the same pin.
  const cacheDir = path.join(input.repoRoot, "node_modules/.cache/goat/cua-driver");
  const archive = path.join(cacheDir, release.archiveName);
  const verified = Effect.fn("verifyCuaDriverArchive")(function* () {
    if (!(yield* fs.exists(archive))) return false;
    const bytes = yield* fs.readFile(archive);
    return (
      bytes.length === release.bytes && (yield* hashBytes(bytes, "SHA-256")) === release.sha256
    );
  });
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  if (!(yield* verified())) {
    yield* run("curl", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--output",
      archive,
      release.url,
    ]);
    if (!(yield* verified()))
      return yield* fail(
        "Cua Driver archive failed size/SHA-256 verification: " + release.archiveName,
      );
  }

  const work = yield* fs.makeTempDirectoryScoped({ prefix: "goat-computer-use-" });
  const extracted = path.join(work, "driver");
  yield* fs.makeDirectory(extracted);
  yield* run("tar", ["-xzf", archive, "-C", extracted]);

  const bundle = path.join(input.output, COMPUTER_USE_HELPER_NAME + ".app");
  const contents = path.join(bundle, "Contents");
  const driverDir = path.join(contents, "Resources", "cua-driver");
  const noticesDir = path.join(contents, "Resources", "notices");
  yield* fs.remove(bundle, { recursive: true, force: true });
  for (const directory of [path.join(contents, "MacOS"), driverDir, noticesDir])
    yield* fs.makeDirectory(directory, { recursive: true });

  // Write the bytes instead of copying the file: a clonefile copy keeps the protected
  // com.apple.provenance xattr, and Gatekeeper kills the staged binary at exec when it
  // survives onto a new path (pattern from synara, MIT: apps/desktop/scripts/provision-cua-driver.mjs).
  // The cursor theme ships beside the driver, which looks it up next to its executable.
  const driverBinaries = [release.executable, "cua-cursor-theme"];
  for (const name of driverBinaries) {
    const source = path.join(extracted, name);
    if (!(yield* fs.exists(source)))
      return yield* fail("Cua Driver release is missing " + name + ".");
    yield* fs.writeFile(path.join(driverDir, name), yield* fs.readFile(source));
    yield* fs.chmod(path.join(driverDir, name), 0o755);
  }

  const sourceDir = path.join(input.repoRoot, "apps/desktop/native/computer-use-helper");
  const executable = path.join(contents, "MacOS", COMPUTER_USE_HELPER_NAME);
  const slices: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = path.join(work, "helper-" + arch);
    yield* run("xcrun", [
      "swiftc",
      "-O",
      "-target",
      arch + "-apple-macos13.0",
      "-o",
      slice,
      path.join(sourceDir, "main.swift"),
    ]);
    slices.push(slice);
  }
  yield* run("lipo", ["-create", "-output", executable, ...slices]);

  const identities = yield* (input.runner ?? runReleaseCommand)("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const choice = chooseSigningIdentity({
    channel: input.channel,
    explicit: input.identity,
    findIdentityOutput: identities.stdout,
  });
  if ("error" in choice) return yield* fail(choice.error);
  const adHoc = choice.identity === "-";

  const bundleId = helperBundleIdForChannel(input.channel);
  const template = yield* fs.readFileString(path.join(sourceDir, "Info.plist"));
  yield* fs.writeFileString(
    path.join(contents, "Info.plist"),
    renderHelperInfoPlist(template, {
      bundleId,
      version: desktopPackageJson.version,
      // An ad-hoc helper has no team to compare its parent's with.
      allowAnyParent: input.channel === "dev" || adHoc,
    }),
  );
  // macOS shows this icon in System Settings' privacy lists and the permission drag panel,
  // where the helper has to read as its own app beside GOAT.app (#1251).
  const iconset = path.join(work, "AppIcon.iconset");
  yield* fs.makeDirectory(iconset);
  const iconSource = path.join(sourceDir, "icon-1024.png");
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [suffix, pixels] of [
      ["", size],
      ["@2x", size * 2],
    ] as const) {
      const name = "icon_" + size + "x" + size + suffix + ".png";
      yield* run("sips", [
        "-z",
        String(pixels),
        String(pixels),
        iconSource,
        "--out",
        path.join(iconset, name),
      ]);
    }
  }
  yield* run("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(contents, "Resources", "AppIcon.icns"),
  ]);
  // Cua Driver's MIT notices travel with every copy of the driver (#667).
  const notices = path.join(input.repoRoot, "apps/desktop/src/cua/notices");
  for (const name of yield* fs.readDirectory(notices))
    yield* fs.copyFile(path.join(notices, name), path.join(noticesDir, name));

  const signing = [
    "--force",
    "--options",
    "runtime",
    ...(adHoc ? [] : ["--timestamp"]),
    "--sign",
    choice.identity,
  ];
  for (const name of driverBinaries)
    yield* run("codesign", [...signing, path.join(driverDir, name)]);
  yield* run("codesign", [
    ...signing,
    "--entitlements",
    path.join(sourceDir, "entitlements.plist"),
    bundle,
  ]);
  yield* run("codesign", ["--verify", "--strict", "--deep", "--verbose=2", bundle]);

  if (input.notaryProfile) {
    if (adHoc) return yield* fail("Notarization needs a Developer ID signature.");
    const zip = path.join(work, "helper.zip");
    yield* run("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
    yield* run("xcrun", [
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      input.notaryProfile,
      "--wait",
    ]);
    yield* run("xcrun", ["stapler", "staple", bundle]);
  }
  return {
    bundle,
    bundleId,
    identity: choice.identity,
    notarized: input.notaryProfile !== undefined,
  };
}, Effect.scoped);

const command = Command.make(
  "build-computer-use-helper",
  {
    channel: Flag.Literals("channel", ["dev", "nightly", "stable"]).pipe(Flag.withDefault("dev")),
    output: Flag.String("output").pipe(Flag.optional),
    identity: Flag.String("identity").pipe(
      Flag.withDescription(
        "codesign identity; defaults to the keychain's Developer ID Application.",
      ),
      Flag.optional,
    ),
    notaryProfile: Flag.String("notary-profile").pipe(
      Flag.withDescription("notarytool keychain profile; notarizes and staples when set."),
      Flag.optional,
    ),
  },
  ({ channel, output, identity, notaryProfile }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = path.resolve(import.meta.dirname, "..");
      const built = yield* buildComputerUseHelper({
        repoRoot,
        channel,
        output: Option.getOrElse(output, () =>
          path.join(repoRoot, "apps/desktop/.computer-use-helper"),
        ),
        identity: Option.getOrUndefined(identity),
        notaryProfile: Option.getOrUndefined(notaryProfile),
      });
      yield* Effect.log(
        "Built " +
          built.bundle +
          " (" +
          built.bundleId +
          ", signed " +
          (built.identity === "-" ? "ad-hoc" : built.identity) +
          (built.notarized ? ", notarized" : "") +
          ").",
      );
    }),
);
if (import.meta.main)
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
