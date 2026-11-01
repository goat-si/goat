import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it } from "@effect/vitest";
import {
  cliArchiveFileName,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
} from "@goat/shared/cliRelease";
import {
  ownRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestAssetName,
} from "@goat/shared/runtimeManifest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import { TestClock } from "effect/testing";

import { findPublishedRuntime, resetPublishedRuntimeIndexCache } from "./runtimePublished.ts";

const KEY = "linux-arm64";
afterEach(() => resetPublishedRuntimeIndexCache());

interface Release {
  readonly version: string;
  /** Publish a manifest; `newer` makes it serve only protocols newer than this client's. */
  readonly manifest?: "ok" | "newer";
  readonly draft?: boolean;
}

/** A stub of goat-releases: the paged index plus each release's SHA256SUMS and manifest. */
const releases = (pages: ReadonlyArray<ReadonlyArray<Release>>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const routes = new Map<string, string>();
    pages.forEach((page, index) =>
      routes.set(
        cliReleaseIndexPageUrl(index + 1),
        JSON.stringify(
          page.map((release) => ({
            tag_name: `v${release.version}`,
            draft: release.draft ?? false,
            assets: [
              cliArchiveFileName(release.version, KEY),
              "SHA256SUMS",
              ...(release.manifest === undefined
                ? []
                : [runtimeManifestAssetName(release.version)]),
            ].map((name) => ({ name })),
          })),
        ),
      ),
    );
    for (const release of pages.flat()) {
      if (release.manifest === undefined) continue;
      const asset = cliArchiveFileName(release.version, KEY);
      const own = ownRuntimeManifest({ version: release.version });
      const manifest = JSON.stringify(
        releaseRuntimeManifest(
          release.manifest === "newer"
            ? { ...own, protocol: { ...own.protocol, ssh: { min: 99_999, max: 99_999 } } }
            : own,
          new Map([[asset, "a".repeat(64)]]),
        ),
      );
      const sha = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(manifest)));
      const base = cliReleaseDownloadBaseUrl(release.version);
      routes.set(`${base}/${runtimeManifestAssetName(release.version)}`, manifest);
      routes.set(
        `${base}/SHA256SUMS`,
        `${"a".repeat(64)}  ${asset}\n${sha}  ${runtimeManifestAssetName(release.version)}\n`,
      );
    }
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      requested.push(String(url));
      const body = routes.get(String(url));
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    }) as typeof fetch;
    return { fetchImpl, requested };
  });

const find = (fetchImpl: typeof fetch) =>
  findPublishedRuntime({ platformKey: KEY, requestedVersion: "0.1.0-dev.1.gabcdef0", fetchImpl });

describe("published runtime search", () => {
  it.effect("reads every index page before deciding a channel has no manifests", () =>
    Effect.gen(function* () {
      const fillers = Array.from({ length: 99 }, (_, i) => ({
        version: `0.0.${i}`,
        draft: true,
      }));
      const { fetchImpl } = yield* releases([
        [{ version: "0.1.0-nightly.20261020.300" }, ...fillers],
        [{ version: "0.1.0-nightly.20261001.100", manifest: "ok" }],
      ]);
      const result = yield* find(fetchImpl);
      // The newer release predates manifests, and its channel has published one since.
      assert.isTrue("found" in result);
      if ("found" in result) {
        assert.equal(result.found.version, "0.1.0-nightly.20261001.100");
        assert.isDefined(result.found.manifest);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("offers the newest pre-manifest release only while its channel has no manifest", () =>
    Effect.gen(function* () {
      const { fetchImpl, requested } = yield* releases([
        [{ version: "0.1.0-nightly.20261019.194" }, { version: "0.1.0-nightly.20261018.190" }],
      ]);
      const result = yield* find(fetchImpl);
      assert.isTrue("found" in result && result.found.version === "0.1.0-nightly.20261019.194");
      assert.isTrue("found" in result && result.found.manifest === undefined);
      assert.deepEqual(requested, [cliReleaseIndexPageUrl(1)]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back from nightly to stable, and says when only a newer app would do", () =>
    Effect.gen(function* () {
      const both = yield* releases([
        [
          { version: "0.1.0-nightly.20261020.300", manifest: "newer" },
          { version: "0.0.9", manifest: "ok" },
        ],
      ]);
      const stable = yield* find(both.fetchImpl);
      assert.isTrue("found" in stable && stable.found.version === "0.0.9");
      assert.isTrue("found" in stable && stable.found.channel === "stable");
      assert.deepEqual(stable.rejected, ["0.1.0-nightly.20261020.300: client-too-old"]);
      resetPublishedRuntimeIndexCache();
      const newerOnly = yield* releases([
        [{ version: "0.1.0-nightly.20261020.300", manifest: "newer" }],
      ]);
      assert.deepInclude(yield* find(newerOnly.fetchImpl), { miss: "client-too-old" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits out GitHub's rate limit before reading the index again", () =>
    Effect.gen(function* () {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(15 * 60) },
        });
      }) as typeof fetch;
      assert.deepInclude(yield* find(fetchImpl), { miss: "unreachable" });
      yield* TestClock.adjust("10 minutes");
      yield* find(fetchImpl);
      assert.equal(calls, 1);
      yield* TestClock.adjust("6 minutes");
      yield* find(fetchImpl);
      assert.equal(calls, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
