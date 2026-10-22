import type { SshPreflightStep } from "@goat/contracts";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliReleaseDownloadBaseUrl,
  isPublishableCliReleaseVersion,
  type CliArchivePlatformKey,
} from "@goat/shared/cliRelease";
import { HttpClient } from "effect/http";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { RemoteGoatRunnerOptions } from "./remoteRuntime.ts";
import { MAX_RUNTIME_ARCHIVE_BYTES } from "./runtimeArchive.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { findPublishedRuntime, type PublishedRuntimeSearch } from "./runtimePublished.ts";

type Availability = "present" | "absent" | "unknown";
export const RuntimeReleaseHead = Context.Reference<
  (url: string) => Effect.Effect<Availability, never, HttpClient.HttpClient>
>("ssh/preflight/RuntimeReleaseHead", {
  defaultValue: () => (url) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.head(url);
      return response.status >= 200 && response.status < 300
        ? ("present" as const)
        : response.status === 404 || response.status === 410
          ? ("absent" as const)
          : ("unknown" as const);
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => "unknown" as const),
    ),
});
export const RuntimePublishedSearch = Context.Reference<
  (input: {
    readonly platformKey: CliArchivePlatformKey;
    readonly requestedVersion: string;
    readonly exclude: ReadonlySet<string>;
  }) => Effect.Effect<PublishedRuntimeSearch, never, Crypto.Crypto>
>("ssh/preflight/RuntimePublishedSearch", {
  defaultValue: () => (input) =>
    findPublishedRuntime(input).pipe(
      Effect.orElseSucceed(() => ({ miss: "unreachable" as const, rejected: [] })),
    ),
});
const Assets = Schema.Struct({ assets: Schema.Array(Schema.Struct({ name: Schema.String })) });
const decodeAssets = Schema.decodeUnknownEffect(Schema.fromJsonString(Assets));
export const checkRuntimeAvailability = Effect.fn("ssh/preflight.runtime")(function* (input: {
  readonly runner: RemoteGoatRunnerOptions;
  readonly platformKey: CliArchivePlatformKey;
  readonly installedCandidates: ReadonlyArray<{
    readonly version: string;
    readonly held?: "pending" | "rejected";
  }>;
  readonly ownerLabel: string;
  readonly hostHasData: boolean;
  readonly host?: string;
}) {
  const { runner, ownerLabel, platformKey, installedCandidates } = input;
  // Held fallbacks can run only through provisioning's published path and fresh-data gate.
  const installedVersions = installedCandidates
    .filter((candidate) => candidate.held === undefined)
    .map((candidate) => candidate.version);
  // Reusable candidates may avoid a transfer even when the requested archive exists.
  const result = (step: Omit<SshPreflightStep, "id">, needsTransfer = false) => ({
    step: { id: "runtime" as const, ...step },
    needsTransfer: needsTransfer && installedVersions.length === 0,
  });
  if (runner.nodeScriptPath?.trim())
    return result({
      state: "warning",
      summary: `Runs GOAT from ${runner.nodeScriptPath}; needs Node ${runner.nodeEngineRange ?? "supported by this build"}.`,
    });
  const version = runner.archiveVersion?.trim() ?? "";
  if (version && installedVersions.includes(version))
    return result({ state: "passed", summary: `GOAT ${version} is already installed.` });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let inconclusive = false;
  const fileName = cliArchiveFileName(version, platformKey);
  for (const [directory, requireSidecar] of [
    [runner.bundledArchiveDirectory, true],
    [runner.archiveDirectory, false],
  ] as const) {
    if (!directory?.trim()) continue;
    const available = yield* Effect.gen(function* () {
      const archivePath = path.join(directory, fileName);
      if (!(yield* fs.exists(archivePath))) return false;
      const stat = yield* fs.stat(archivePath);
      if (stat.type !== "File" || stat.size > BigInt(MAX_RUNTIME_ARCHIVE_BYTES)) return false;
      for (const file of requireSidecar ? [`${fileName}.sha256`] : []) {
        const filePath = path.join(directory, file);
        if (!(yield* fs.exists(filePath))) return false;
        if ((yield* fs.stat(filePath)).type !== "File") return false;
      }
      return true;
    }).pipe(
      Effect.orElseSucceed(() => {
        inconclusive = true;
        return false;
      }),
    );
    if (available)
      return result(
        { state: "passed", summary: `Uploads GOAT ${version} from ${ownerLabel}.` },
        true,
      );
  }
  if (runner.releaseBaseUrl?.trim() || isPublishableCliReleaseVersion(version)) {
    const head = yield* RuntimeReleaseHead;
    const baseUrl = cliReleaseDownloadBaseUrl(version, runner.releaseBaseUrl ?? undefined);
    const sources = runner.releaseBaseUrl?.trim()
      ? [baseUrl, cliReleaseDownloadBaseUrl(version)]
      : [baseUrl];
    for (const base of sources) {
      const checks = yield* Effect.all(
        [head(`${base}/${fileName}`), head(`${base}/${CLI_RELEASE_CHECKSUMS_FILE}`)],
        { concurrency: "unbounded" },
      );
      if (checks.every((value) => value === "present"))
        return result(
          { state: "passed", summary: `Downloads the published GOAT ${version} release.` },
          true,
        );
      if (!checks.includes("absent")) inconclusive = true;
    }
    const gh = yield* runPreflightProcess(runner.ghCommand ?? "gh", [
      "release",
      "view",
      `v${version}`,
      "--repo",
      CLI_RELEASE_REPOSITORY,
      "--json",
      "assets",
    ]);
    if (gh.exitCode === 0) {
      const assets = yield* decodeAssets(gh.stdout).pipe(Effect.option);
      if (assets._tag === "Some") {
        const names = new Set(assets.value.assets.map((asset) => asset.name));
        if (names.has(fileName) && names.has(CLI_RELEASE_CHECKSUMS_FILE))
          return result(
            { state: "passed", summary: `Downloads the published GOAT ${version} release.` },
            true,
          );
      } else inconclusive = true;
    } else if (!/release not found|HTTP 404/iu.test(gh.stderr)) inconclusive = true;
  }
  if (installedVersions.length)
    return result({
      state: "warning",
      summary: `GOAT ${installedVersions[0]} is installed; connect checks whether it is compatible with GOAT ${version}.`,
    });
  if (runner.publishedFallback === true && !runner.releaseBaseUrl?.trim() && !input.hostHasData) {
    const search = yield* RuntimePublishedSearch;
    const published = yield* search({
      platformKey,
      requestedVersion: version,
      exclude: new Set(
        installedCandidates.flatMap((candidate) =>
          candidate.held === "rejected" ? [candidate.version] : [],
        ),
      ),
    });
    if ("found" in published)
      return result(
        {
          state: "passed",
          summary: `GOAT ${version} isn't published for ${platformKey}; GOAT installs ${published.found.version}, the newest compatible ${published.found.channel} release.`,
        },
        true,
      );
    if (published.miss === "unreachable")
      return result({
        state: "warning",
        summary: `Could not check published GOAT runtimes for ${platformKey}.`,
        detail: "Check that this computer can reach github.com, then check again.",
      });
    if (published.miss === "client-too-old")
      return result({
        state: "failed",
        summary: `Every published GOAT runtime for ${platformKey} needs a newer app.`,
        fix: { actor: "human", instruction: "Update this app, then check again." },
      });
  }
  if (inconclusive)
    return result({
      state: "warning",
      summary: `Could not confirm a GOAT ${version} runtime for ${platformKey}.`,
      detail: "Check the network and release access, then check again.",
    });
  return result({
    state: "failed",
    summary: input.hostHasData
      ? `${input.host || "The host"} has GOAT data but no runtime this app can start, and GOAT ${version} isn't published for ${platformKey}.`
      : `GOAT ${version} has no runtime for ${platformKey}: it isn't bundled with this build or published.`,
    fix: {
      actor: "human",
      instruction: `Install a published GOAT release (stable or nightly) on ${ownerLabel}.`,
    },
  });
});
