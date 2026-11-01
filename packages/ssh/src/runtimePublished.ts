import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  parseChecksums,
  type CliArchivePlatformKey,
  type CliReleaseChannel,
} from "@goat/shared/cliRelease";
import {
  decodeRuntimeManifest,
  runtimeManifestAssetName,
  runtimeManifestVerdict,
  type RuntimeManifest,
} from "@goat/shared/runtimeManifest";
import { compareRuntimeBuilds } from "@goat/shared/semver";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";

/** Channels a client falls back to, in order: nightlies track dev most closely. */
const FALLBACK_CHANNELS: ReadonlyArray<CliReleaseChannel> = ["nightly", "stable"];
/** Manifest releases inspected per channel; each costs two small downloads. */
const MAX_INSPECTED_PER_CHANNEL = 5;
const MAX_SMALL_ASSET_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = "20 seconds";
/**
 * GitHub allows 60 unauthenticated API requests an hour per address, shared with everything
 * else on that address. One index read serves every host and retry for ten minutes, and a
 * failed read is not repeated for two, or until the rate limit resets.
 */
const INDEX_CACHE_MS = 10 * 60 * 1000;
const INDEX_FAILURE_CACHE_MS = 2 * 60 * 1000;
const MAX_INDEX_PAGES = 3;
const INDEX_PAGE_SIZE = 100;

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optionalKey(Schema.Boolean),
    assets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);
type ReleaseIndex = typeof ReleaseIndex.Type;
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

export class PublishedRuntimeFetchError extends Schema.TaggedError<PublishedRuntimeFetchError>()(
  "PublishedRuntimeFetchError",
  {
    url: Schema.String,
    /** When GitHub's rate limit allows the next request, in epoch milliseconds. */
    retryAt: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {}

const isPublishedRuntimeFetchError = Schema.is(PublishedRuntimeFetchError);

export interface PublishedRuntime {
  readonly version: string;
  readonly channel: CliReleaseChannel;
  /**
   * Absent for a release published before manifests. Such a runtime proves its compatibility
   * only after installation, from its own binary; see `findPublishedRuntime`.
   */
  readonly manifest?: RuntimeManifest;
}

/**
 * Why nothing qualified. `unreachable`: the release index could not be read.
 * `client-too-old`: a runtime for this platform exists but only speaks newer protocols.
 * `none`: no release has a runtime this client may start.
 */
export type PublishedRuntimeMiss = "unreachable" | "client-too-old" | "none";

export type PublishedRuntimeSearch =
  | { readonly found: PublishedRuntime; readonly rejected: ReadonlyArray<string> }
  | { readonly miss: PublishedRuntimeMiss; readonly rejected: ReadonlyArray<string> };

let indexCache: { readonly until: number; readonly index: ReleaseIndex | undefined } | undefined;

/** Test seam: forget the cached release index. */
export const resetPublishedRuntimeIndexCache = () => {
  indexCache = undefined;
};

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

const fetchSmall = (fetchImpl: typeof fetch, url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchImpl(url, {
        signal,
        headers: { accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const limited =
          (response.status === 403 || response.status === 429) &&
          response.headers.get("x-ratelimit-remaining") === "0" &&
          Number.isSafeInteger(reset);
        throw new PublishedRuntimeFetchError({
          url,
          ...(limited ? { retryAt: reset * 1000 } : {}),
          cause: `status ${response.status}`,
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_SMALL_ASSET_BYTES)
        throw new PublishedRuntimeFetchError({ url, cause: "larger than 1 MiB" });
      return bytes;
    },
    catch: (cause) =>
      isPublishedRuntimeFetchError(cause) ? cause : new PublishedRuntimeFetchError({ url, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new PublishedRuntimeFetchError({ url, cause: "timed out" })),
    }),
  );

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const readIndex = Effect.fn("ssh.runtime.published.index")(function* (fetchImpl: typeof fetch) {
  const now = yield* Clock.currentTimeMillis;
  if (indexCache !== undefined && now < indexCache.until) return indexCache.index;
  // Read to the end: whether a channel has published manifests must see every release.
  const releases: Array<ReleaseIndex[number]> = [];
  let retryAt: number | undefined;
  let complete = false;
  for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
    const read = yield* fetchSmall(fetchImpl, cliReleaseIndexPageUrl(page)).pipe(
      Effect.flatMap((bytes) => decodeReleaseIndex(text(bytes))),
      Effect.result,
    );
    if (read._tag === "Failure") {
      if (read.failure._tag === "PublishedRuntimeFetchError") retryAt = read.failure.retryAt;
      break;
    }
    releases.push(...read.success);
    if (read.success.length < INDEX_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  indexCache = complete
    ? { until: now + INDEX_CACHE_MS, index: releases }
    : { until: Math.max(now + INDEX_FAILURE_CACHE_MS, retryAt ?? 0), index: undefined };
  return indexCache.index;
});

/**
 * The newest published runtime for `platformKey` that this client may start, nightlies first.
 *
 * A release with a manifest qualifies when SHA256SUMS covers both the manifest and the
 * archive it names, its protocol ranges include this client's, and it has every required
 * capability. A release without one cannot be judged before it is installed. It is offered
 * only while its channel has published no manifest at all, and only the newest such release,
 * so the caller can install it and let the installed runtime decide. Once a channel publishes
 * manifests, its older releases are never offered.
 */
export const findPublishedRuntime = Effect.fn("ssh.runtime.published.find")(function* (input: {
  readonly platformKey: CliArchivePlatformKey;
  readonly requestedVersion: string;
  /** Versions this client already installed on the host and then refused. */
  readonly exclude?: ReadonlySet<string>;
  readonly fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const rejected: string[] = [];
  const index = yield* readIndex(fetchImpl);
  if (index === undefined)
    return { miss: "unreachable", rejected } satisfies PublishedRuntimeSearch;
  const crypto = yield* Crypto.Crypto;
  let clientTooOld = false;
  for (const channel of FALLBACK_CHANNELS) {
    const published = index
      .flatMap((release) => {
        const version = RELEASE_TAG.exec(release.tag_name)?.[1];
        return release.draft !== true &&
          version !== undefined &&
          cliReleaseChannelOf(version) === channel
          ? [{ version, assets: new Set(release.assets.map((asset) => asset.name)) }]
          : [];
      })
      .toSorted(
        (a, b) => compareRuntimeBuilds({ version: b.version }, { version: a.version }) ?? 0,
      );
    const channelHasManifests = published.some((release) =>
      release.assets.has(runtimeManifestAssetName(release.version)),
    );
    let inspected = 0;
    for (const release of published) {
      const archive = cliArchiveFileName(release.version, input.platformKey);
      if (release.version === input.requestedVersion || !release.assets.has(archive)) continue;
      const manifestName = runtimeManifestAssetName(release.version);
      if (!release.assets.has(manifestName)) {
        if (channelHasManifests) continue;
        // Only the newest: an older pre-manifest release proves nothing the newest did not.
        if (input.exclude?.has(release.version)) break;
        return {
          found: { version: release.version, channel },
          rejected,
        } satisfies PublishedRuntimeSearch;
      }
      if (inspected++ >= MAX_INSPECTED_PER_CHANNEL) break;
      if (input.exclude?.has(release.version)) continue;
      const base = cliReleaseDownloadBaseUrl(release.version);
      const fetched = yield* Effect.all([
        fetchSmall(fetchImpl, `${base}/${CLI_RELEASE_CHECKSUMS_FILE}`),
        fetchSmall(fetchImpl, `${base}/${manifestName}`),
      ]).pipe(Effect.result);
      if (fetched._tag === "Failure") {
        rejected.push(`${release.version}: manifest download failed`);
        continue;
      }
      const [sumsBytes, manifestBytes] = fetched.success;
      const checksums = parseChecksums(text(sumsBytes));
      const manifestSha = Hex.encode(yield* crypto.digest("SHA-256", manifestBytes));
      const manifest = decodeRuntimeManifest(text(manifestBytes));
      const entry = manifest?.platforms?.[input.platformKey];
      if (
        manifest === undefined ||
        checksums.get(manifestName) !== manifestSha ||
        manifest.version !== release.version ||
        entry?.asset !== archive ||
        checksums.get(archive) !== entry.sha256
      ) {
        rejected.push(`${release.version}: manifest does not match SHA256SUMS`);
        continue;
      }
      const verdict = runtimeManifestVerdict(manifest);
      if (verdict !== "compatible") {
        if (verdict === "client-too-old") clientTooOld = true;
        rejected.push(`${release.version}: ${verdict}`);
        continue;
      }
      return {
        found: { version: release.version, channel, manifest },
        rejected,
      } satisfies PublishedRuntimeSearch;
    }
  }
  return {
    miss: clientTooOld ? "client-too-old" : "none",
    rejected,
  } satisfies PublishedRuntimeSearch;
});
