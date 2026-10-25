#!/usr/bin/env node
// Builds and signs "GOAT Computer Use.app", the macOS helper that owns computer use's TCC
// identity and runs the pinned Cua Driver as its direct child. See
// apps/desktop/native/computer-use-helper/main.swift for what the helper does at runtime.
//
//   node scripts/build-computer-use-helper.ts --channel dev
//   GOAT_CUA_HELPER_PATH="$PWD/apps/desktop/.computer-use-helper/GOAT Computer Use.app" vp run dev
//
// Signing goes inside out (driver binaries, then the helper); GOAT.app is signed last by
// whoever embeds the helper. Every channel signs with a Developer ID identity from the
// keychain under a designated requirement of bundle id plus team, so a rebuild keeps its
// Accessibility and Screen Recording grants. Ad-hoc signing is opt-in (--ad-hoc, dev only):
// its cdhash changes per build, which orphans the grants and adds a look-alike row to each
// System Settings list (#1333).
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

const KEYCHAIN_REMEDY =
  "Run the build from Terminal while signed in to this Mac (an SSH or agent session usually cannot use the login keychain), and choose Always Allow when macOS asks to let codesign use the key.";

export const AD_HOC_WARNING = [
  "WARNING: signing GOAT Computer Use ad-hoc.",
  "macOS treats every ad-hoc build as a new app: Accessibility and Screen Recording grants stop",
  'applying after each rebuild, and System Settings collects another "GOAT Computer Use" row in',
  "both lists. Remove every old row before allowing a new build, or build with a Developer ID.",
].join("\n");

export type SigningChoice =
  | { readonly identity: string; readonly team: string }
  | { readonly identity: "-"; readonly warning: string }
  | { readonly error: string };

/**
 * The identity to sign with: an explicit one, else the first Developer ID Application in
 * `security find-identity` output. Ad-hoc needs `adHoc` and the dev channel, because a
 * release helper verifies its parent by Developer ID team and an ad-hoc one has none. The one
 * exception is `unsignedPackage`: an unsigned local GOAT.app (build-desktop-artifact.ts
 * --computer-use-helper) has no team either, so its helper is ad-hoc and serves any parent.
 */
export function chooseSigningIdentity(input: {
  readonly channel: HelperChannel;
  readonly explicit: string | undefined;
  readonly adHoc: boolean;
  readonly unsignedPackage?: boolean;
  readonly findIdentityOutput: string;
}): SigningChoice {
  const explicit = input.explicit?.trim() || undefined;
  if (input.adHoc) {
    if (input.channel !== "dev" && !input.unsignedPackage)
      return { error: "Only a dev helper may be signed ad-hoc; drop --ad-hoc." };
    if (explicit !== undefined && explicit !== "-")
      return { error: "Pass either --identity or --ad-hoc, not both." };
    return { identity: "-", warning: AD_HOC_WARNING };
  }
  if (explicit === "-")
    return { error: "Ad-hoc signing needs --ad-hoc (dev only); --identity - is not accepted." };
  // Each valid identity line: index, SHA-1, quoted name.
  const developerIds = [
    ...input.findIdentityOutput.matchAll(
      /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/gmu,
    ),
  ].map(([, hash, name]) => ({ hash: hash ?? "", name: name ?? "" }));
  const match =
    explicit === undefined
      ? developerIds[0]
      : developerIds.find(({ hash, name }) => explicit === name || explicit.toUpperCase() === hash);
  const team = match?.name.match(/\(([A-Z0-9]{10})\)$/u)?.[1];
  if (match && team) return { identity: explicit ?? match.name, team };
  return {
    error: [
      explicit === undefined
        ? "No usable Developer ID Application identity: `security find-identity -v -p codesigning` lists none."
        : "The identity " +
          explicit +
          " is not a Developer ID Application identity in this keychain.",
      KEYCHAIN_REMEDY,
      ...(input.channel === "dev"
        ? [
            "For a throwaway dev build, pass --ad-hoc and accept that every rebuild loses its grants.",
          ]
        : []),
    ].join("\n"),
  };
}

/**
 * Bundle id plus Developer ID team: what every rebuild by the same team satisfies, so macOS
 * keeps the helper's grants across rebuilds instead of pinning them to one cdhash.
 */
export const helperDesignatedRequirement = (bundleId: string, team: string) =>
  '=designated => identifier "' +
  bundleId +
  '" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
  " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
  ' and certificate leaf[subject.OU] = "' +
  team +
  '"';

/** Why codesign failed and what fixes it; a keychain the session cannot use is the usual cause. */
function signingFailure(target: string, stderr: string): string {
  const keychain =
    /errSecInternalComponent|User interaction is not allowed|unable to build chain/iu.test(stderr);
  return [
    "codesign could not sign " + target + ": " + stderr.trim(),
    keychain
      ? "The signing key in the login keychain is not usable from this session. " + KEYCHAIN_REMEDY
      : KEYCHAIN_REMEDY,
    "The build does not fall back to ad-hoc signing; pass --ad-hoc only for a throwaway dev build.",
  ].join("\n");
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

type SignedChoice = Exclude<SigningChoice, { readonly error: string }>;

/** Reads the keychain's identities and picks one, failing with the cause when it cannot. */
export const resolveSigningIdentity = Effect.fn("resolveSigningIdentity")(function* (
  runner: ReleaseCommandRunner,
  input: {
    readonly channel: HelperChannel;
    readonly identity: string | undefined;
    readonly adHoc: boolean;
    readonly unsignedPackage?: boolean;
  },
) {
  const identities = yield* runner("security", ["find-identity", "-v", "-p", "codesigning"]);
  // An ad-hoc build needs no keychain, so only a Developer ID build stops on a failed lookup.
  if (identities.exitCode !== 0 && !input.adHoc)
    return yield* fail(
      "security find-identity -v -p codesigning failed (" +
        identities.exitCode +
        "): " +
        identities.stderr.trim() +
        "\n" +
        KEYCHAIN_REMEDY,
    );
  const choice = chooseSigningIdentity({
    channel: input.channel,
    explicit: input.identity,
    adHoc: input.adHoc,
    ...(input.unsignedPackage ? { unsignedPackage: true } : {}),
    findIdentityOutput: identities.stdout,
  });
  if ("error" in choice) return yield* fail(choice.error);
  if ("warning" in choice) yield* Effect.logWarning(choice.warning);
  else yield* Effect.log("Signing with " + choice.identity + ".");
  return choice;
});

/**
 * Signs inside out: the driver binaries, then the helper bundle under its designated
 * requirement. A codesign failure stops the build; it never retries ad-hoc.
 */
export const signComputerUseHelper = Effect.fn("signComputerUseHelper")(function* (
  runner: ReleaseCommandRunner,
  input: {
    readonly choice: SignedChoice;
    readonly bundle: string;
    readonly bundleId: string;
    readonly driverPaths: readonly string[];
    readonly entitlements: string;
  },
) {
  const { choice } = input;
  const signing = [
    "--force",
    "--options",
    "runtime",
    ...("team" in choice ? ["--timestamp"] : []),
    "--sign",
    choice.identity,
  ];
  const sign = Effect.fn("signHelperPart")(function* (target: string, extra: readonly string[]) {
    const result = yield* runner("codesign", [...signing, ...extra, target]);
    if (result.exitCode !== 0) return yield* fail(signingFailure(target, result.stderr));
  });
  for (const driver of input.driverPaths) yield* sign(driver, []);
  yield* sign(input.bundle, [
    "--entitlements",
    input.entitlements,
    ...("team" in choice
      ? ["--requirements", helperDesignatedRequirement(input.bundleId, choice.team)]
      : []),
  ]);
  yield* requireReleaseCommand(runner, "codesign", [
    "--verify",
    "--strict",
    "--deep",
    "--verbose=2",
    input.bundle,
  ]);
});

export const buildComputerUseHelper = Effect.fn("buildComputerUseHelper")(function* (input: {
  readonly repoRoot: string;
  readonly output: string;
  readonly channel: HelperChannel;
  readonly identity: string | undefined;
  readonly adHoc: boolean;
  readonly unsignedPackage?: boolean;
  readonly notaryProfile: string | undefined;
  readonly runner?: ReleaseCommandRunner;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = input.runner ?? runReleaseCommand;
  const run = (program: string, args: readonly string[]) =>
    requireReleaseCommand(runner, program, args);
  if ((yield* HostProcess.Platform) !== "darwin")
    return yield* fail("The helper builds on macOS only.");

  // Choose the identity before the slow build, so a missing key fails in seconds.
  const choice = yield* resolveSigningIdentity(runner, input);

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
      // audit_token_to_pid, for the parent check by audit token.
      "-lbsm",
      "-o",
      slice,
      path.join(sourceDir, "main.swift"),
      path.join(sourceDir, "McpRelay.swift"),
      path.join(sourceDir, "McpFraming.swift"),
      path.join(sourceDir, "McpJsonSyntax.swift"),
      // The agent cursor overlay (#1214); main.swift runs it in agent connection mode.
      path.join(sourceDir, "Overlay.swift"),
      // A person's input while an agent connection runs (#1235); the overlay channel carries it.
      path.join(sourceDir, "HumanInput.swift"),
      // Single-window live pictures (#1370), requested with the frames method.
      path.join(sourceDir, "Frames.swift"),
      // GOAT's own windows, which the live picture never shows (#1321).
      path.join(sourceDir, "HostIdentity.swift"),
      // Grants read again for a moment before they count as missing (#1597).
      path.join(sourceDir, "PermissionSettle.swift"),
    ]);
    slices.push(slice);
  }
  yield* run("lipo", ["-create", "-output", executable, ...slices]);

  const bundleId = helperBundleIdForChannel(input.channel);
  const template = yield* fs.readFileString(path.join(sourceDir, "Info.plist"));
  yield* fs.writeFileString(
    path.join(contents, "Info.plist"),
    renderHelperInfoPlist(template, {
      bundleId,
      version: desktopPackageJson.version,
      // An ad-hoc helper has no team to compare its parent's with.
      allowAnyParent: input.channel === "dev" || !("team" in choice),
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

  const adHoc = !("team" in choice);
  yield* signComputerUseHelper(runner, {
    choice,
    bundle,
    bundleId,
    driverPaths: driverBinaries.map((name) => path.join(driverDir, name)),
    entitlements: path.join(sourceDir, "entitlements.plist"),
  });

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

export const buildComputerUseHelperCommand = Command.make(
  "build-computer-use-helper",
  {
    channel: Flag.Literals("channel", ["dev", "nightly", "stable"]).pipe(Flag.withDefault("dev")),
    output: Flag.String("output").pipe(Flag.optional),
    identity: Flag.String("identity").pipe(
      Flag.withDescription(
        "Developer ID Application identity (name or SHA-1); defaults to the keychain's first one.",
      ),
      Flag.optional,
    ),
    adHoc: Flag.Boolean("ad-hoc").pipe(
      Flag.withDescription(
        "Sign a dev helper ad-hoc. Every rebuild then loses its macOS permissions.",
      ),
      Flag.withDescription("defaults to false; Developer ID signing remains the default"),
      Flag.optional,
    ),
    notaryProfile: Flag.String("notary-profile").pipe(
      Flag.withDescription("notarytool keychain profile; notarizes and staples when set."),
      Flag.optional,
    ),
  },
  ({ channel, output, identity, adHoc, notaryProfile }) =>
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
        adHoc: Option.getOrElse(adHoc, () => false),
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
      // Repeated after the long build output, where the first warning scrolls away.
      if (built.identity === "-") yield* Effect.logWarning(AD_HOC_WARNING);
    }),
);
if (import.meta.main)
  Command.run(buildComputerUseHelperCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
