#!/usr/bin/env node
import { runtimeManifestAssetName } from "@goat/shared/runtimeManifest";
import { checkReleaseRuntimeManifest } from "./lib/runtime-manifest.ts";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { compareSemverVersions } from "@goat/shared/semver";
import { cliReleaseChannelOf } from "@goat/shared/cliRelease";
import {
  gitBlobSha,
  hashBytes,
  makeGitHubReleasesClient,
  nightlyVersionOfTag,
  publishedNightlies,
  type GitHubReleaseAsset,
  type GitHubReleasesClient,
} from "./lib/github-releases.ts";
import { renderReleaseNotes } from "./lib/release-notes.ts";

export class NightlyPublishError extends Schema.TaggedError<NightlyPublishError>()(
  "NightlyPublishError",
  { message: Schema.String },
) {}

export const REPOSITORY_RELEASE_FILES = [
  "install.sh",
  "install.ps1",
  "install-goat-server.sh",
  "THIRD_PARTY_NOTICES.md",
] as const;
export type PublishOutcome = "published" | "superseded" | "already-published";

/** Nightly versions publish as prereleases; plain x.y.z versions publish as the stable release. */
export function releaseChannelOfVersion(version: string): "nightly" | "stable" | undefined {
  if (nightlyVersionOfTag(`v${version}`) === version) return "nightly";
  if (/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    return cliReleaseChannelOf(version) === "stable" ? "stable" : undefined;
  }
  return undefined;
}

/** SHA256SUMS is the local asset inventory; verify it before any mutation. */
export const readLocalReleaseAssets = Effect.fn("readLocalReleaseAssets")(function* (
  dir: string,
  version: string,
  requireRepositoryFiles = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sums = yield* fs.readFile(path.join(dir, "SHA256SUMS"));
  const checksums = new Map<string, string>();
  for (const line of new TextDecoder().decode(sums).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line);
    const name = match?.[2];
    if (
      match?.[1] === undefined ||
      name === undefined ||
      name === "SHA256SUMS" ||
      name === "." ||
      name === ".." ||
      /[/\\\r\n]/.test(name) ||
      checksums.has(name)
    ) {
      return yield* new NightlyPublishError({ message: "Invalid or duplicate SHA256SUMS entry." });
    }
    checksums.set(name, match[1].toLowerCase());
  }
  if (
    checksums.size === 0 ||
    (requireRepositoryFiles && REPOSITORY_RELEASE_FILES.some((file) => !checksums.has(file)))
  ) {
    return yield* new NightlyPublishError({
      message: "SHA256SUMS must include the installers and third-party notices.",
    });
  }
  const runtimeName = runtimeManifestAssetName(version);
  // A runtime-only backfill of a release from before manifests has none; clients treat such a
  // release by the pre-manifest rule. A full release always needs one, and any one is checked.
  if (!checksums.has(runtimeName)) {
    if (requireRepositoryFiles)
      return yield* new NightlyPublishError({
        message: `Missing runtime manifest: ${runtimeName}.`,
      });
  } else {
    const runtimeProblems = checkReleaseRuntimeManifest(
      yield* fs.readFileString(path.join(dir, runtimeName)),
      version,
      checksums,
    );
    if (runtimeProblems.length)
      return yield* new NightlyPublishError({ message: runtimeProblems.join("; ") });
  }
  const entries = yield* fs.readDirectory(dir);
  if (entries.some((name) => name !== "SHA256SUMS" && !checksums.has(name))) {
    return yield* new NightlyPublishError({
      message: "Release directory contains files outside SHA256SUMS.",
    });
  }
  const assets: { name: string; size: number; sha256: string }[] = [];
  for (const [name, sha256] of checksums) {
    const bytes = yield* fs.readFile(path.join(dir, name));
    if ((yield* hashBytes(bytes)) !== sha256) {
      return yield* new NightlyPublishError({ message: `Local checksum differs for ${name}.` });
    }
    assets.push({ name, size: bytes.byteLength, sha256 });
  }
  assets.push({ name: "SHA256SUMS", size: sums.byteLength, sha256: yield* hashBytes(sums) });
  return assets;
});

const assetMatches = Effect.fn("nightlyAssetMatches")(function* (
  client: GitHubReleasesClient,
  remote: GitHubReleaseAsset,
  local: { name: string; size: number; sha256: string },
) {
  if (remote.name !== local.name || remote.size !== local.size) return false;
  const digest =
    remote.digest == null
      ? yield* hashBytes(yield* client.downloadAsset(remote.id))
      : /^sha256:([0-9a-f]{64})$/i.exec(remote.digest)?.[1]?.toLowerCase();
  return digest === local.sha256;
});

export const publishNightlyRelease = Effect.fn("publishNightlyRelease")(function* (input: {
  readonly client: GitHubReleasesClient;
  readonly dir: string;
  readonly version: string;
  readonly name: string;
  readonly dryRun?: boolean;
  /**
   * Publish only the release assets: no installers are required and nothing is committed
   * to the repository. Used for goat-si/goat's own releases, which carry the runtime
   * archives for SSH hosts and `goat update`.
   */
  readonly assetsOnly?: boolean;
  /** Commit the release tag points at; goat-releases tags its own main. */
  readonly target?: string | undefined;
}) {
  const { client, dir, version, name, dryRun = false, assetsOnly = false } = input;
  const repositoryFiles = assetsOnly ? [] : REPOSITORY_RELEASE_FILES;
  const channel = releaseChannelOfVersion(version);
  if (channel === undefined) {
    return yield* new NightlyPublishError({
      message: "--version must be a nightly semver or a plain x.y.z stable version.",
    });
  }
  const prerelease = channel === "nightly";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const local = yield* readLocalReleaseAssets(dir, version, !assetsOnly);
  const releases = yield* client.listReleases();
  const sameTag = releases.find((release) => !release.draft && release.tag_name === `v${version}`);
  const allMatch = Effect.fn("nightlyAssetsMatch")(function* (id: number) {
    const remote = yield* client.listAssets(id);
    if (remote.length !== local.length) return false;
    for (const asset of local) {
      const candidates = remote.filter((entry) => entry.name === asset.name);
      if (candidates.length !== 1 || !(yield* assetMatches(client, candidates[0]!, asset)))
        return false;
    }
    return true;
  });
  if (sameTag) {
    if (!(yield* allMatch(sameTag.id))) {
      return yield* new NightlyPublishError({
        message: "tag already published with different bytes",
      });
    }
    return "already-published" as const;
  }
  // Only a newer nightly supersedes a nightly; a stable release is cut by hand
  // and is never superseded by the nightly train.
  const superseded = (rows: typeof releases) =>
    prerelease &&
    publishedNightlies(rows).some(
      (release) => compareSemverVersions(release.tag_name, version) > 0,
    );
  if (superseded(releases)) return "superseded" as const;
  const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
  let draft = releases.find((release) => release.draft && release.tag_name === `v${version}`);
  if (dryRun) {
    if (draft) yield* client.listAssets(draft.id);
    for (const file of repositoryFiles) yield* client.getContents(file);
    yield* Console.log(
      `Would ${draft ? "reconcile" : "create"} ${channel} draft v${version}, verify ${local.length} assets, sync repository files, recheck supersession, and publish.\n${renderReleaseNotes(
        version,
        date,
        local.map((asset) => asset.name),
      )}`,
    );
    return undefined;
  }
  draft ??= yield* client.createDraft(
    version,
    name,
    renderReleaseNotes(
      version,
      date,
      local.map((asset) => asset.name),
    ),
    prerelease,
    input.target,
  );
  if (!draft.draft)
    return yield* new NightlyPublishError({
      message: "Refusing to reconcile a published release.",
    });
  const retained = new Set<string>();
  for (const remote of yield* client.listAssets(draft.id)) {
    const asset = local.find((entry) => entry.name === remote.name);
    if (!asset || retained.has(remote.name) || !(yield* assetMatches(client, remote, asset))) {
      yield* client.deleteAsset(remote.id);
    } else retained.add(remote.name);
  }
  for (const asset of local) {
    if (retained.has(asset.name)) continue;
    const bytes = yield* fs.readFile(path.join(dir, asset.name));
    if (bytes.byteLength !== asset.size || (yield* hashBytes(bytes)) !== asset.sha256) {
      return yield* new NightlyPublishError({
        message: `Local asset changed during publish: ${asset.name}.`,
      });
    }
    yield* client.uploadAsset(draft.id, asset.name, bytes);
  }
  if (!(yield* allMatch(draft.id))) {
    return yield* new NightlyPublishError({ message: "Draft assets differ after reconciliation." });
  }
  // A superseded run must not touch the repository's files either.
  if (superseded(yield* client.listReleases())) return "superseded" as const;
  for (const file of repositoryFiles) {
    const bytes = yield* fs.readFile(path.join(dir, file));
    if ((yield* hashBytes(bytes)) !== local.find((asset) => asset.name === file)!.sha256) {
      return yield* new NightlyPublishError({
        message: `Local asset changed during sync: ${file}.`,
      });
    }
    const contents = yield* client.getContents(file);
    if (contents?.sha !== (yield* gitBlobSha(bytes))) {
      yield* client.putContents(file, bytes, version, contents?.sha);
    }
  }
  if (superseded(yield* client.listReleases())) return "superseded" as const;
  yield* client.publishDraft(draft.id, prerelease);
  const published = yield* client.getRelease(draft.id);
  if (published.draft || published.prerelease !== prerelease) {
    return yield* new NightlyPublishError({
      message: `Published release must be a non-draft ${prerelease ? "prerelease" : "stable release"}.`,
    });
  }
  return "published" as const;
});

export const writePublishOutcome = Effect.fn("writePublishOutcome")(function* (
  outcome: PublishOutcome,
) {
  const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
  const line = `outcome=${outcome}\n`;
  if (Option.isSome(output) && output.value.length > 0) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(output.value, line, { flag: "a" });
  } else yield* Console.log(line.trimEnd());
});

const command = Command.make(
  "publish-nightly-release",
  {
    repo: Flag.String("repo"),
    dir: Flag.String("dir"),
    version: Flag.String("version"),
    name: Flag.String("name"),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    assetsOnly: Flag.Boolean("assets-only").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(input.repo);
      const outcome = yield* publishNightlyRelease({
        ...input,
        target: Option.getOrUndefined(input.target),
        client,
      });
      if (outcome !== undefined) {
        if (input.dryRun) yield* Console.log(`Dry-run: outcome=${outcome}; no changes planned.`);
        else yield* writePublishOutcome(outcome);
      }
    }),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
