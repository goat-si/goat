#!/usr/bin/env node
// Guards the GOAT release version: the four package manifests the release
// stamps must agree, stay on plain x.y.z at or above 0.1.0, and yield a
// nightly version every consumer (desktop feed and app, CLI installers)
// accepts. Runs in goat-ci so an upstream merge cannot silently bring back 0.0.x.
//
// With --candidate and --published-tags (one goat-releases tag per line) it also
// checks the version a release run is about to publish: it must sort above the
// newest stable and the previous build on its channel, and a base that already
// shipped stable fails with the bump command (docs/internals/release-channels.md#version-rule).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { cliReleaseChannelOf, newestCliReleaseVersion } from "@goat/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";

import { resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";
import { checkReleaseCandidate } from "./lib/release-version.ts";
import { resolveNightlyReleaseMetadata } from "./resolve-nightly-release.ts";

export const RELEASE_MANIFESTS = [
  "apps/desktop/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

export const MINIMUM_GOAT_VERSION = "0.1.0";
/** The last version the two Macs ran before GOAT's own numbering. */
export const LAST_UPSTREAM_NIGHTLY = "0.0.45-nightly.20261011.3";

/** Returns one line per problem; an empty list means the versions are releasable. */
export function checkReleaseVersions(versions: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const distinct = [...new Set(Object.values(versions))];
  if (distinct.length !== 1) {
    problems.push(
      `release manifests disagree: ${Object.entries(versions)
        .map(([file, version]) => `${file}=${version}`)
        .join(", ")}`,
    );
    return problems;
  }
  const version = distinct[0] ?? "";
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) ||
    parseSemver(version) === null
  ) {
    problems.push(
      `version ${version} must be plain x.y.z; nightlies add their suffix at release time`,
    );
    return problems;
  }
  if (compareSemverVersions(version, MINIMUM_GOAT_VERSION) < 0) {
    problems.push(
      `version ${version} is below ${MINIMUM_GOAT_VERSION}; keep GOAT's version when merging upstream`,
    );
  }

  const nightly = resolveNightlyReleaseMetadata(version, "20261012", 1, "0123456789abcdef");
  if (resolveDesktopUpdateChannel(nightly.version) !== "nightly") {
    problems.push(`${nightly.version} is not a nightly for the desktop feed`);
  }
  if (cliReleaseChannelOf(nightly.version) !== "nightly") {
    problems.push(`${nightly.version} is not a nightly for the CLI installers`);
  }
  if (newestCliReleaseVersion([{ tag_name: nightly.tag }], "nightly") !== nightly.version) {
    problems.push(`tag ${nightly.tag} is not selected by the CLI release index`);
  }
  if (compareSemverVersions(nightly.version, LAST_UPSTREAM_NIGHTLY) <= 0) {
    problems.push(`${nightly.version} does not sort above ${LAST_UPSTREAM_NIGHTLY}`);
  }
  return problems;
}

class ReleaseVersionCheckError extends Schema.TaggedError<ReleaseVersionCheckError>()(
  "ReleaseVersionCheckError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.problems.map((problem) => `check-release-version: ${problem}`).join("\n");
  }
}

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

export const readReleaseVersions = Effect.fn("readReleaseVersions")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versions: Record<string, string> = {};
  for (const file of RELEASE_MANIFESTS) {
    const manifest = yield* decodeManifest(yield* fs.readFileString(path.join(root, file)));
    versions[file] = manifest.version;
  }
  return versions;
});

const command = Command.make(
  "check-release-version",
  {
    candidate: Flag.String("candidate").pipe(
      Flag.withDescription("Version this run is about to publish."),
      Flag.optional,
    ),
    publishedTags: Flag.String("published-tags").pipe(
      Flag.withDescription("File with one published goat-releases tag per line."),
      Flag.optional,
    ),
  },
  ({ candidate, publishedTags }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const problems = checkReleaseVersions(yield* readReleaseVersions(root));
      if (Option.isSome(candidate)) {
        const tags = Option.isSome(publishedTags)
          ? (yield* fs.readFileString(publishedTags.value)).split(/\r?\n/).filter(Boolean)
          : [];
        problems.push(
          ...checkReleaseCandidate({ candidate: candidate.value, publishedTags: tags }),
        );
      }
      if (problems.length > 0) return yield* new ReleaseVersionCheckError({ problems });
      yield* Console.log(
        Option.isSome(candidate)
          ? `check-release-version: ok (${candidate.value} can be published)`
          : "check-release-version: ok",
      );
    }),
).pipe(Command.withDescription("Check the GOAT release version."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
