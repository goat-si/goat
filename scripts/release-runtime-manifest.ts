#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Release assembly compares decoded archive metadata.
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@goat/shared/cliRelease";
import {
  decodeRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestAssetName,
  RUNTIME_MANIFEST_ARCHIVE_ENTRY,
  type RuntimeManifest,
} from "@goat/shared/runtimeManifest";
import {
  readReleaseAsset,
  ReleaseVerificationError,
  requireReleaseCommand,
  runReleaseCommand,
  type ReleaseCommandRunner,
} from "./lib/release-verify.ts";

export function createReleaseRuntimeManifest(
  version: string,
  archives: readonly { asset: string; sha256: string; manifest: RuntimeManifest }[],
): RuntimeManifest {
  const first = archives[0]?.manifest;
  if (!first) throw new Error("No runtime archives found.");
  const allowed = new Set(CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(version, key)));
  const seen = new Set<string>();
  for (const archive of archives) {
    if (
      !allowed.has(archive.asset) ||
      seen.has(archive.asset) ||
      !/^[a-f0-9]{64}$/.test(archive.sha256)
    )
      throw new Error(`${archive.asset}: invalid or duplicate runtime archive.`);
    seen.add(archive.asset);
    if (archive.manifest.version !== version || archive.manifest.platforms !== undefined)
      throw new Error(`${archive.asset}: invalid embedded runtime manifest for ${version}.`);
    if (!NodeUtil.isDeepStrictEqual(first, archive.manifest))
      throw new Error(`${archive.asset}: embedded runtime manifests disagree.`);
  }
  return releaseRuntimeManifest(
    first,
    new Map(archives.map(({ asset, sha256 }) => [asset, sha256])),
  );
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const writeReleaseRuntimeManifest = Effect.fn("writeReleaseRuntimeManifest")(function* (
  dir: string,
  version: string,
  runner: ReleaseCommandRunner = runReleaseCommand,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir);
  const archives: { asset: string; sha256: string; manifest: RuntimeManifest }[] = [];
  const expectedNames = new Set(
    CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(version, key)),
  );
  const unexpected = names.filter(
    (name) =>
      /^goat-.+-(?:darwin|linux|win32)-(?:arm64|x64)\.(?:tar\.gz|zip)$/.test(name) &&
      !expectedNames.has(name),
  );
  if (unexpected.length)
    return yield* new ReleaseVerificationError({
      problems: unexpected.map((name) => `Unexpected runtime archive: ${name}`),
    });
  for (const key of CLI_ARCHIVE_PLATFORM_KEYS) {
    const asset = cliArchiveFileName(version, key);
    if (!names.includes(asset)) continue;
    const archive = path.resolve(dir, asset);
    const stem = asset.replace(/\.(?:tar\.gz|zip)$/, "");
    const entry = `${stem}/${RUNTIME_MANIFEST_ARCHIVE_ENTRY}`;
    // Read just the manifest, without extracting native code or the dependency tree.
    const zip = asset.endsWith(".zip");
    const listing = yield* requireReleaseCommand(
      runner,
      zip ? "unzip" : "tar",
      zip ? ["-Z1", archive] : ["-tf", archive],
    );
    if (listing.stdout.split(/\r?\n/).filter((name) => name === entry).length !== 1)
      return yield* new ReleaseVerificationError({
        problems: [`${asset}: missing or duplicate ${entry}`],
      });
    const output = yield* requireReleaseCommand(
      runner,
      zip ? "unzip" : "tar",
      zip ? ["-p", archive, entry] : ["-xOf", archive, entry],
    );
    const manifest = decodeRuntimeManifest(output.stdout);
    if (!manifest)
      return yield* new ReleaseVerificationError({
        problems: [`${asset}: invalid runtime manifest`],
      });
    archives.push({ asset, sha256: (yield* readReleaseAsset(dir, asset)).sha256, manifest });
  }
  const manifest = yield* Effect.try({
    try: () => createReleaseRuntimeManifest(version, archives),
    catch: (cause) => new ReleaseVerificationError({ problems: [String(cause)] }),
  });
  yield* fs.writeFileString(
    path.join(dir, runtimeManifestAssetName(version)),
    `${yield* encodeJson(manifest)}\n`,
  );
  return manifest;
});

const command = Command.make(
  "release-runtime-manifest",
  {
    dir: Flag.String("dir"),
    version: Flag.String("version"),
  },
  ({ dir, version }) => writeReleaseRuntimeManifest(dir, version),
);

if (import.meta.main)
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
