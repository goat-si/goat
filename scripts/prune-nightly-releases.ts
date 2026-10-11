#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import {
  makeGitHubReleasesClient,
  nightlyVersionOfTag,
  publishedNightlies,
  type GitHubRelease,
  type GitHubReleaseTag,
  type GitHubReleasesClient,
} from "./lib/github-releases.ts";

export interface NightlyPrunePolicy {
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly protect: ReadonlyArray<string>;
}

export function parseProtectedTags(value: string) {
  return value
    .split(/[,\r\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

const millisecondsOf = (date: string) => {
  const parsed = DateTime.make(date);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
};

/** Unknown ages are retained. Orphan age is the nightly's UTC build date, not its source commit's age. */
export function selectReleasesToPrune(
  releases: ReadonlyArray<GitHubRelease>,
  tags: ReadonlyArray<GitHubReleaseTag>,
  now: number,
  policy: NightlyPrunePolicy,
) {
  const cutoff = now - policy.maxAgeDays * 86_400_000;
  const nightlies = publishedNightlies(releases);
  const protectedTags = new Set(policy.protect);
  const keptIds = new Set(
    nightlies.slice(0, Math.max(1, policy.keep)).map((release) => release.id),
  );
  const removed = nightlies.filter((release) => {
    const publishedAt =
      release.published_at === null ? undefined : millisecondsOf(release.published_at);
    return (
      !keptIds.has(release.id) &&
      !protectedTags.has(release.tag_name) &&
      publishedAt !== undefined &&
      publishedAt <= cutoff
    );
  });
  const releaseTags = new Set(releases.map((release) => release.tag_name));
  const orphanTags = tags
    .filter((tag) => {
      if (releaseTags.has(tag.name) || protectedTags.has(tag.name)) return false;
      const date = nightlyVersionOfTag(tag.name)?.match(/-nightly\.(\d{4})(\d{2})(\d{2})\./);
      if (!date) return false;
      const dateString = `${date[1]}-${date[2]}-${date[3]}`;
      const parsed = DateTime.make(`${dateString}T00:00:00Z`);
      // Date parsing may normalize impossible dates; those tags have unknown age.
      return (
        Option.isSome(parsed) &&
        DateTime.formatIsoDateUtc(parsed.value) === dateString &&
        DateTime.toEpochMillis(parsed.value) <= cutoff
      );
    })
    .map((tag) => tag.name);
  if (nightlies[0] && removed.some((release) => release.id === nightlies[0]!.id)) {
    throw new Error("Prune selected the newest published nightly.");
  }
  return { releases: removed, orphanTags };
}

export const pruneNightlyReleases = Effect.fn("pruneNightlyReleases")(function* (
  client: GitHubReleasesClient,
  policy: NightlyPrunePolicy,
  dryRun = false,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const plan = selectReleasesToPrune(
    yield* client.listReleases(),
    yield* client.listTags(),
    now,
    policy,
  );
  for (const release of plan.releases) {
    yield* Console.log(
      `${dryRun ? "Would delete" : "Deleting"} release ${release.id}, then tag ${release.tag_name}.`,
    );
    if (!dryRun) {
      yield* client.deleteRelease(release.id);
      yield* client.deleteTag(release.tag_name);
    }
  }
  for (const tag of plan.orphanTags) {
    yield* Console.log(`${dryRun ? "Would delete" : "Deleting"} orphan tag ${tag}.`);
    if (!dryRun) yield* client.deleteTag(tag);
  }
  return plan;
});

const NonnegativeInteger = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const command = Command.make(
  "prune-nightly-releases",
  {
    repo: Flag.String("repo"),
    keep: Flag.String("keep").pipe(Flag.withSchema(NonnegativeInteger), Flag.withDefault(30)),
    maxAgeDays: Flag.String("max-age-days").pipe(
      Flag.withSchema(NonnegativeInteger),
      Flag.withDefault(30),
    ),
    protect: Flag.String("protect").pipe(Flag.withDefault("")),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  },
  ({ repo, keep, maxAgeDays, protect, dryRun }) =>
    Effect.gen(function* () {
      const client = yield* makeGitHubReleasesClient(repo);
      yield* pruneNightlyReleases(
        client,
        { keep, maxAgeDays, protect: parseProtectedTags(protect) },
        dryRun,
      );
    }),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
