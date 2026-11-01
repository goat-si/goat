import { cliReleaseChannelOf } from "@goat/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { FetchHttpClient } from "effect/http";

export const GitHubReleaseAsset = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  size: Schema.Int,
  digest: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
});
export type GitHubReleaseAsset = typeof GitHubReleaseAsset.Type;

export const GitHubRelease = Schema.Struct({
  id: Schema.Int,
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  created_at: Schema.optional(Schema.String),
});
export type GitHubRelease = typeof GitHubRelease.Type;
export const GitHubReleaseTag = Schema.Struct({ name: Schema.String });
export type GitHubReleaseTag = typeof GitHubReleaseTag.Type;
const Contents = Schema.Struct({ sha: Schema.String });

export class GitHubReleaseError extends Schema.TaggedError<GitHubReleaseError>()(
  "GitHubReleaseError",
  { message: Schema.String, status: Schema.optional(Schema.Int) },
) {}

export function nightlyVersionOfTag(tag: string): string | undefined {
  const version = tag.replace(/^v/, "");
  return parseSemver(version) && cliReleaseChannelOf(version) === "nightly" ? version : undefined;
}

export function publishedNightlies(releases: ReadonlyArray<GitHubRelease>) {
  return releases
    .filter((release) => !release.draft && nightlyVersionOfTag(release.tag_name) !== undefined)
    .toSorted((left, right) => compareSemverVersions(right.tag_name, left.tag_name));
}

export const hashBytes = (bytes: Uint8Array, algorithm: "SHA-256" | "SHA-1" = "SHA-256") =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest(algorithm, Uint8Array.from(bytes)),
    catch: () =>
      new GitHubReleaseError({ message: `Failed to hash release bytes (${algorithm}).` }),
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export const gitBlobSha = (bytes: Uint8Array) => {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const blob = new Uint8Array(header.byteLength + bytes.byteLength);
  blob.set(header);
  blob.set(bytes, header.byteLength);
  return hashBytes(blob, "SHA-1");
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export interface GitHubReleasesOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Effect.Effect<void>;
  /** Number of retries after the initial request. */
  readonly retries?: number;
  readonly maxBackoffMs?: number;
}

/** Token-bearing requests stay on GitHub's API hosts, including pagination links. */
export const makeGitHubReleasesClient = Effect.fn("makeGitHubReleasesClient")(function* (
  repo: string,
  options: GitHubReleasesOptions = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return yield* new GitHubReleaseError({ message: "--repo must be owner/repository." });
  }
  const token = yield* Config.Redacted("GOAT_RELEASES_TOKEN");
  const fetch = options.fetch ?? (yield* FetchHttpClient.Fetch);
  const sleep = options.sleep ?? ((milliseconds: number) => Effect.sleep(milliseconds));
  const retries = options.retries ?? 4;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const base = `https://api.github.com/repos/${repo}`;

  const request = Effect.fn("githubReleases.request")(function* (
    url: string,
    init: RequestInit = {},
    allowNotFound = false,
  ) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      !["api.github.com", "uploads.github.com"].includes(target.hostname)
    ) {
      return yield* new GitHubReleaseError({ message: "Unexpected GitHub API host." });
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${Redacted.value(token)}`);
    headers.set("Accept", headers.get("Accept") ?? "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    for (let attempt = 0; ; attempt++) {
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(url, { ...init, headers, signal }),
        catch: () => new GitHubReleaseError({ message: "GitHub release request failed." }),
      });
      if (response.ok || (allowNotFound && response.status === 404)) return response;
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => new GitHubReleaseError({ message: "Failed to read GitHub error response." }),
      });
      const retryAfter = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retryable =
        response.status >= 500 ||
        response.status === 429 ||
        (response.status === 403 &&
          (retryAfter !== null ||
            (reset !== null && (remaining === null || remaining === "0")) ||
            /secondary rate limit|abuse detection/i.test(text)));
      if (!retryable || attempt >= retries) {
        return yield* new GitHubReleaseError({
          message: `GitHub release request returned HTTP ${response.status}.`,
          status: response.status,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const afterDate = retryAfter === null ? Option.none() : DateTime.make(retryAfter);
      const delay =
        retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1_000
          : Option.isSome(afterDate)
            ? DateTime.toEpochMillis(afterDate.value) - now
            : reset !== null && /^\d+$/.test(reset)
              ? Number(reset) * 1_000 - now
              : 1_000 * 2 ** attempt;
      yield* sleep(Math.min(maxBackoffMs, Math.max(1_000, delay)));
    }
  });

  const readJson = <A, I>(response: Response, schema: Schema.Codec<A, I>) =>
    Effect.tryPromise({
      try: () => response.text(),
      catch: () => new GitHubReleaseError({ message: "Failed to read GitHub JSON response." }),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));

  const jsonRequest = Effect.fn("githubReleases.jsonRequest")(function* (
    url: string,
    method: string,
    body: unknown,
  ) {
    return yield* request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: yield* encodeJson(body),
    });
  });

  const list = <A, I>(url: string, schema: Schema.Codec<A, I>) =>
    Effect.gen(function* () {
      const items: A[] = [];
      const visited = new Set<string>();
      let next: string | undefined = `${url}?per_page=100`;
      while (next !== undefined) {
        if (visited.has(next)) {
          return yield* new GitHubReleaseError({ message: "GitHub pagination repeated a page." });
        }
        visited.add(next);
        const response: Response = yield* request(next);
        items.push(...(yield* readJson(response, Schema.Array(schema))));
        next = response.headers
          .get("link")
          ?.split(",")
          .find((link) => /;\s*rel="next"/.test(link))
          ?.match(/<([^>]+)>/)?.[1];
      }
      return items;
    });

  return {
    listReleases: () => list(`${base}/releases`, GitHubRelease),
    listTags: () => list(`${base}/tags`, GitHubReleaseTag),
    listAssets: (id: number) => list(`${base}/releases/${id}/assets`, GitHubReleaseAsset),
    getRelease: (id: number) =>
      request(`${base}/releases/${id}`).pipe(
        Effect.flatMap((response) => readJson(response, GitHubRelease)),
      ),
    // Nightlies are prereleases that are never "latest"; a stable release becomes
    // the repository's latest, which is what stable desktop feeds read.
    createDraft: (
      version: string,
      name: string,
      body: string,
      prerelease: boolean,
      target = "main",
    ) =>
      jsonRequest(`${base}/releases`, "POST", {
        tag_name: `v${version}`,
        target_commitish: target,
        draft: true,
        prerelease,
        make_latest: prerelease ? "false" : "true",
        name,
        body,
      }).pipe(Effect.flatMap((response) => readJson(response, GitHubRelease))),
    // goat-nightly's per-run hand-off store. A draft creates no tag and stays hidden
    // from anyone without push access.
    createStagingDraft: (tag: string, target: string) =>
      jsonRequest(`${base}/releases`, "POST", {
        tag_name: tag,
        target_commitish: target,
        draft: true,
        prerelease: true,
        make_latest: "false",
        name: `${tag} (goat-nightly hand-off, deleted after the run)`,
        body: "Temporary goat-nightly build hand-off. The run's cleanup job deletes it.",
      }).pipe(Effect.flatMap((response) => readJson(response, GitHubRelease))),
    publishDraft: (id: number, prerelease: boolean) =>
      jsonRequest(`${base}/releases/${id}`, "PATCH", {
        draft: false,
        prerelease,
        make_latest: prerelease ? "false" : "true",
      }).pipe(Effect.asVoid),
    deleteAsset: (id: number) =>
      request(`${base}/releases/assets/${id}`, { method: "DELETE" }).pipe(Effect.asVoid),
    deleteRelease: (id: number) =>
      request(`${base}/releases/${id}`, { method: "DELETE" }).pipe(Effect.asVoid),
    deleteTag: (tag: string) =>
      // A tag that is already gone is the goal; do not fail a run after publishing.
      request(`${base}/git/refs/tags/${encodeURIComponent(tag)}`, { method: "DELETE" }, true).pipe(
        Effect.asVoid,
      ),
    uploadAsset: (id: number, name: string, bytes: Uint8Array) =>
      request(
        `https://uploads.github.com/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: Uint8Array.from(bytes),
        },
      ).pipe(Effect.flatMap((response) => readJson(response, GitHubReleaseAsset))),
    downloadAsset: (id: number) =>
      request(`${base}/releases/assets/${id}`, {
        headers: { Accept: "application/octet-stream" },
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: () =>
              new GitHubReleaseError({ message: "Failed to download GitHub release asset." }),
          }),
        ),
        Effect.map((bytes) => new Uint8Array(bytes)),
      ),
    getContents: (file: string) =>
      request(`${base}/contents/${encodeURIComponent(file)}?ref=main`, {}, true).pipe(
        Effect.flatMap((response) =>
          response.status === 404 ? Effect.succeed(null) : readJson(response, Contents),
        ),
      ),
    putContents: (file: string, bytes: Uint8Array, version: string, sha?: string) =>
      jsonRequest(`${base}/contents/${encodeURIComponent(file)}`, "PUT", {
        message: `chore: sync ${file} for v${version}`,
        content: Base64.encode(bytes),
        branch: "main",
        ...(sha === undefined ? {} : { sha }),
      }).pipe(Effect.asVoid),
  };
});

export type GitHubReleasesClient = Effect.Success<ReturnType<typeof makeGitHubReleasesClient>>;
