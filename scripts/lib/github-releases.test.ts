import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import {
  gitBlobSha,
  hashBytes,
  makeGitHubReleasesClient,
  nightlyVersionOfTag,
  type GitHubReleasesOptions,
} from "./github-releases.ts";

const config = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { GOAT_RELEASES_TOKEN: "fake-token" } }),
);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const bytes = new TextEncoder().encode("hello\n");

function fixture(responses: Response[], options: Omit<GitHubReleasesOptions, "fetch"> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected fetch: ${String(url)}`);
    return response;
  };
  const client = makeGitHubReleasesClient("owner/releases", { ...options, fetch }).pipe(
    Effect.provide(config),
  );
  return { calls, client };
}

describe("GitHub releases client", () => {
  it.effect("paginates releases, assets, and tags using Link rel=next and per_page=100", () =>
    Effect.gen(function* () {
      const next = "https://api.github.com/repos/owner/releases/tags?per_page=100&page=2";
      const { client, calls } = fixture([
        json([], 200, { link: `<${next}>; rel="next", <${next}>; rel="last"` }),
        json([{ name: "v0.1.0" }]),
        json([]),
        json([]),
      ]);
      const api = yield* client;
      expect(yield* api.listTags()).toEqual([{ name: "v0.1.0" }]);
      yield* api.listReleases();
      yield* api.listAssets(1);
      expect(calls.map((call) => call.url)).toEqual([
        "https://api.github.com/repos/owner/releases/tags?per_page=100",
        next,
        "https://api.github.com/repos/owner/releases/releases?per_page=100",
        "https://api.github.com/repos/owner/releases/releases/1/assets?per_page=100",
      ]);
      expect(new Headers(calls[0]!.init.headers).get("Authorization")).toBe("Bearer fake-token");
    }),
  );

  it.effect("retries 5xx and secondary rate limits with bounded server-directed backoff", () =>
    Effect.gen(function* () {
      const sleeps: number[] = [];
      const { client, calls } = fixture(
        [
          json({}, 500),
          json({ message: "secondary rate limit" }, 403, { "retry-after": "3" }),
          json({}, 429, { "retry-after": "1000" }),
          json([]),
        ],
        {
          sleep: (ms) =>
            Effect.sync(() => {
              sleeps.push(ms);
            }),
          maxBackoffMs: 5_000,
        },
      );
      yield* (yield* client).listReleases();
      expect(sleeps).toEqual([1_000, 3_000, 5_000]);
      expect(calls).toHaveLength(4);
    }),
  );

  it.effect("honors x-ratelimit-reset and Retry-After dates", () =>
    Effect.gen(function* () {
      const sleeps: number[] = [];
      const { client } = fixture(
        [
          json({}, 403, { "x-ratelimit-reset": "9999999999" }),
          json({}, 429, { "retry-after": "Wed, 01 Jan 2098 00:00:00 GMT" }),
          json([]),
        ],
        {
          sleep: (ms) =>
            Effect.sync(() => {
              sleeps.push(ms);
            }),
          maxBackoffMs: 6_000,
        },
      );
      yield* (yield* client).listReleases();
      expect(sleeps).toEqual([6_000, 6_000]);
    }),
  );

  it.effect("bounds retries and does not retry authorization failures", () =>
    Effect.gen(function* () {
      const sleeps: number[] = [];
      const limited = fixture([json({}, 503), json({}, 503)], {
        retries: 1,
        sleep: (ms) =>
          Effect.sync(() => {
            sleeps.push(ms);
          }),
      });
      expect((yield* (yield* limited.client).listReleases().pipe(Effect.flip)).message).toContain(
        "HTTP 503",
      );
      expect(limited.calls).toHaveLength(2);
      expect(sleeps).toEqual([1_000]);
      const forbidden = fixture([
        json({ message: "Resource not accessible" }, 403, {
          "x-ratelimit-reset": "9999999999",
          "x-ratelimit-remaining": "58",
        }),
      ]);
      expect((yield* (yield* forbidden.client).listReleases().pipe(Effect.flip)).message).toContain(
        "HTTP 403",
      );
      expect(forbidden.calls).toHaveLength(1);
    }),
  );

  it.effect("rejects foreign pagination hosts before exposing the token", () =>
    Effect.gen(function* () {
      const { client, calls } = fixture([
        json([], 200, { link: '<https://example.com/page2>; rel="next"' }),
      ]);
      expect((yield* (yield* client).listReleases().pipe(Effect.flip)).message).toContain(
        "Unexpected GitHub API host",
      );
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("uploads octet-stream bytes to uploads.github.com and hashes downloaded bytes", () =>
    Effect.gen(function* () {
      const { client, calls } = fixture([
        json({ id: 7, name: "file with spaces.zip", size: bytes.byteLength }),
        new Response(bytes),
      ]);
      const api = yield* client;
      yield* api.uploadAsset(1, "file with spaces.zip", bytes);
      const downloaded = yield* api.downloadAsset(7);
      expect(yield* hashBytes(downloaded)).toBe(
        "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      );
      expect(calls[0]!.url).toBe(
        "https://uploads.github.com/repos/owner/releases/releases/1/assets?name=file%20with%20spaces.zip",
      );
      expect(new Headers(calls[0]!.init.headers).get("Content-Type")).toBe(
        "application/octet-stream",
      );
      expect(new Headers(calls[1]!.init.headers).get("Accept")).toBe("application/octet-stream");
      expect(calls[0]!.init.body).toEqual(bytes);
    }),
  );

  it.effect("gets contents from main and puts base64 content with the current blob sha", () =>
    Effect.gen(function* () {
      const { client, calls } = fixture([json({}, 404), json({ sha: "current" }), json({})]);
      const api = yield* client;
      expect(yield* api.getContents("install.sh")).toBeNull();
      expect(yield* api.getContents("install.sh")).toEqual({ sha: "current" });
      yield* api.putContents("install.sh", bytes, "0.1.0-nightly.20261012.1", "current");
      expect(calls[0]!.url).toContain("contents/install.sh?ref=main");
      expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
        message: "chore: sync install.sh for v0.1.0-nightly.20261012.1",
        content: Base64.encode(bytes),
        branch: "main",
        sha: "current",
      });
      expect(yield* gitBlobSha(bytes)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    }),
  );

  it.effect("requires GOAT_RELEASES_TOKEN and detects only valid nightly tags", () =>
    Effect.gen(function* () {
      const error = yield* makeGitHubReleasesClient("owner/releases").pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Effect.flip,
      );
      expect(error._tag).toBe("ConfigError");
      expect(nightlyVersionOfTag("v0.1.0-nightly.20261012.12")).toBe("0.1.0-nightly.20261012.12");
      expect(nightlyVersionOfTag("v0.1.0-preview.20261012.1")).toBeUndefined();
      expect(nightlyVersionOfTag("vbad-nightly.20261012.1")).toBeUndefined();
    }),
  );
});
