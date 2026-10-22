#!/usr/bin/env node
// Adopts legacy T3 env names before anything reads the environment.
import "@goat/contracts/adoptLegacyEnv";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import {
  decodeReleaseReport,
  readReleaseAsset,
  ReleaseVerificationError,
  releaseAssetKey,
  requireReleaseCommand,
  runReleaseCommand,
  updateManifestPrefix,
  writeReleaseReport,
  type ReleaseAsset,
  type ReleaseCommandRunner,
} from "./lib/release-verify.ts";
import {
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";

/** Rewrites only the finalized container; the ZIP and manifest metadata remain intact. */
export function rewriteDmgManifest(manifest: UpdateManifest, asset: ReleaseAsset): UpdateManifest {
  if (!asset.name.endsWith(".dmg") || !manifest.files.some((file) => file.url === asset.name)) {
    throw new Error(`DMG is absent from manifest: ${asset.name}`);
  }
  return {
    ...manifest,
    files: manifest.files.map((file) =>
      file.url === asset.name ? { url: file.url, sha512: asset.sha512, size: asset.size } : file,
    ),
  };
}
const decodeNotaryStatus = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
);
export interface DmgSigningConfig {
  identity: string;
  profile: string;
  keychain?: string | undefined;
}
export const finalizeMacosDmgs = Effect.fn("finalizeMacosDmgs")(function* (
  dir: string,
  reportPath: string,
  config: DmgSigningConfig,
  runner: ReleaseCommandRunner = runReleaseCommand,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!config.identity.trim() || config.identity === "-" || !config.profile.trim()) {
    return yield* new ReleaseVerificationError({
      problems: ["DMG finalization requires a signing identity and keychain profile"],
    });
  }
  let report = yield* decodeReleaseReport(yield* fs.readFileString(reportPath));
  if (!report.ok || report.mode !== "payload" || report.problems.length)
    return yield* new ReleaseVerificationError({
      problems: ["DMG finalization requires a passing builder payload report"],
    });
  const names = yield* fs.readDirectory(dir);
  const dmgs = names.filter((name) => name.endsWith(".dmg")).toSorted();
  if (!dmgs.length)
    return yield* new ReleaseVerificationError({ problems: ["no DMGs to finalize"] });
  const manifests: Array<{ name: string; manifest: UpdateManifest }> = [];
  const prefix = updateManifestPrefix(report.version);
  for (const name of names.filter(
    (name) => name.startsWith(`${prefix}-mac`) && name.endsWith(".yml"),
  )) {
    const source = yield* fs.readFileString(path.join(dir, name));
    const manifest = yield* Effect.try({
      try: () => parseUpdateManifest(source, name, "macOS"),
      catch: (error) => new ReleaseVerificationError({ problems: [String(error)] }),
    });
    if (manifest.version !== report.version)
      return yield* new ReleaseVerificationError({
        problems: [`${name}: version differs from builder report`],
      });
    manifests.push({ name, manifest });
  }
  // Resolve the entire input set before signing anything.
  for (const name of dmgs) {
    const before = yield* readReleaseAsset(dir, name);
    if (
      releaseAssetKey(name) !== report.key ||
      !report.inputs.some((input) => input.name === name && input.sha256 === before.sha256) ||
      report.transforms?.some((transform) => transform.name === name)
    ) {
      return yield* new ReleaseVerificationError({
        problems: [`${name}: builder report does not bind the unmodified DMG`],
      });
    }
    if (
      !manifests.some(({ manifest }) =>
        manifest.files.some(
          (file) => file.url === name && file.sha512 === before.sha512 && file.size === before.size,
        ),
      )
    ) {
      return yield* new ReleaseVerificationError({
        problems: [`${name}: missing or stale pre-finalize manifest entry`],
      });
    }
  }
  for (const name of dmgs) {
    const fullPath = path.join(dir, name);
    const before = yield* readReleaseAsset(dir, name);
    yield* requireReleaseCommand(runner, "codesign", [
      "--sign",
      config.identity,
      "--timestamp",
      fullPath,
    ]);
    const submitted = yield* requireReleaseCommand(runner, "xcrun", [
      "notarytool",
      "submit",
      fullPath,
      "--keychain-profile",
      config.profile,
      ...(config.keychain ? ["--keychain", config.keychain] : []),
      "--wait",
      "--output-format",
      "json",
    ]);
    const status = yield* decodeNotaryStatus(submitted.stdout);
    if (status.status !== "Accepted")
      return yield* new ReleaseVerificationError({
        problems: [`${name}: notarization status ${status.status}`],
      });
    yield* requireReleaseCommand(runner, "xcrun", ["stapler", "staple", fullPath]);
    const after = yield* readReleaseAsset(dir, name);
    if (before.sha256 === after.sha256)
      return yield* new ReleaseVerificationError({
        problems: [`${name}: finalize did not change DMG bytes`],
      });
    for (const entry of manifests) {
      if (!entry.manifest.files.some((file) => file.url === name)) continue;
      entry.manifest = rewriteDmgManifest(entry.manifest, after);
      yield* fs.writeFileString(
        path.join(dir, entry.name),
        serializeUpdateManifest(entry.manifest, { platformLabel: "macOS" }),
      );
    }
    yield* fs.remove(fullPath + ".blockmap", { force: true });
    report = Object.assign({}, report, {
      transforms: [
        ...(report.transforms ?? []),
        { name, from: before.sha256, to: after.sha256, step: "dmg-finalize" as const },
      ],
    });
    yield* writeReleaseReport(reportPath, report);
  }
  return report;
});
const command = Command.make(
  "finalize-macos-dmg",
  {
    dir: Flag.String("dir"),
    report: Flag.String("report").pipe(
      Flag.withDescription("Builder payload report to append the DMG transforms to."),
    ),
  },
  ({ dir, report }) =>
    Effect.gen(function* () {
      const identity = yield* Config.NonEmptyString("GOAT_CLI_MAC_SIGN_IDENTITY");
      const profile = yield* Config.NonEmptyString("APPLE_KEYCHAIN_PROFILE");
      const keychain = yield* Config.String("APPLE_KEYCHAIN").pipe(Config.option);
      yield* finalizeMacosDmgs(dir, report, {
        identity,
        profile,
        keychain: Option.getOrUndefined(keychain),
      });
      yield* Effect.log("DMGs signed, notarized, stapled; manifests and payload report updated.");
    }),
);
if (import.meta.main)
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
