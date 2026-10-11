import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeGitHubReleasesClient, type GitHubRelease } from "./lib/github-releases.ts";
import {
  parseProtectedTags,
  pruneNightlyReleases,
  selectReleasesToPrune,
} from "./prune-nightly-releases.ts";

const now = Date.parse("2026-10-12T00:00:00Z");
const policy = { keep: 30, maxAgeDays: 30, protect: [] as string[] };
const nightly = (id: number, date = "2026-08-01T00:00:00Z"): GitHubRelease => ({
  id,
  tag_name: `v0.1.0-nightly.20260801.${id}`,
  draft: false,
  prerelease: true,
  published_at: date,
});
const oldReleases = Array.from({ length: 31 }, (_, index) => nightly(index + 1));

describe("nightly prune selection", () => {
  it("keeps the newest 30 versions and selects the 31st regardless of input order", () => {
    expect(
      selectReleasesToPrune(oldReleases, [], now, policy).releases.map((release) => release.id),
    ).toEqual([1]);
  });

  it("retains young releases and prunes at exactly 30 days", () => {
    const atBoundary = [...oldReleases.slice(1), nightly(1, "2026-09-12T00:00:00.000Z")];
    expect(
      selectReleasesToPrune(atBoundary, [], now, policy).releases.map((release) => release.id),
    ).toEqual([1]);
    atBoundary[30] = nightly(1, "2026-09-12T00:00:00.001Z");
    expect(selectReleasesToPrune(atBoundary, [], now, policy).releases).toEqual([]);
  });

  it("preserves protected tags, drafts, stable, preview, and unknown timestamps", () => {
    const extra = [
      { ...nightly(100), draft: true },
      { ...nightly(101), tag_name: "v0.1.0" },
      { ...nightly(102), tag_name: "v0.1.0-preview.20260801.1" },
      { ...nightly(103), tag_name: "v0.0.1-nightly.20260801.1", published_at: null },
      { ...nightly(104), tag_name: "v0.0.1-nightly.20260801.2", published_at: "invalid" },
    ];
    expect(
      selectReleasesToPrune([...oldReleases, ...extra], [], now, {
        ...policy,
        protect: [nightly(1).tag_name],
      }).releases,
    ).toEqual([]);
  });

  it("explicitly retains the newest published nightly even when keep is zero", () => {
    expect(
      selectReleasesToPrune([nightly(1), nightly(2)], [], now, {
        ...policy,
        keep: 0,
        maxAgeDays: 0,
      }).releases.map((release) => release.id),
    ).toEqual([1]);
  });

  it("deletes old orphan nightly tags while retaining recent, protected, non-nightly, and release-backed tags", () => {
    const tags = [
      "v0.1.0-nightly.20260912.1",
      "v0.1.0-nightly.20260913.1",
      "v0.1.0-nightly.20260801.1",
      "v0.1.0-nightly.20260801.2",
      "v0.1.0-nightly.20260801.3",
      "v0.1.0-preview.20260801.1",
      "v0.1.0",
      "v0.1.0-nightly.20261301.1",
    ].map((name) => ({ name }));
    const releases = [nightly(2), { ...nightly(3), draft: true }];
    expect(
      selectReleasesToPrune(releases, tags, now, { ...policy, protect: [tags[2]!.name] })
        .orphanTags,
    ).toEqual([tags[0]!.name]);
    expect(parseProtectedTags(" a, b\nc\r\nd,, ")).toEqual(["a", "b", "c", "d"]);
  });
});

const fixture = (failTag = false) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const calls: string[] = [];
    const releases = [nightly(1), nightly(2)];
    const fetch: typeof globalThis.fetch = async (url, init = {}) => {
      const target = new URL(String(url));
      const method = init.method ?? "GET";
      calls.push(`${method} ${target.pathname}`);
      if (method === "GET")
        return new Response(
          JSON.stringify(
            target.pathname.endsWith("/releases")
              ? releases
              : [{ name: "v0.1.0-nightly.20200101.1" }],
          ),
        );
      if (method === "DELETE" && target.pathname.includes("/git/refs/") && failTag)
        return new Response("denied", { status: 403 });
      return new Response(null, { status: 204 });
    };
    const client = yield* makeGitHubReleasesClient("owner/releases", { fetch }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GOAT_RELEASES_TOKEN: "fake-token" } }),
        ),
      ),
    );
    return { client, calls };
  });

it.effect("deletes a release before its tag, then deletes orphan tags", () =>
  Effect.gen(function* () {
    const { client, calls } = yield* fixture();
    yield* pruneNightlyReleases(client, { ...policy, keep: 1, maxAgeDays: 0 });
    expect(calls.slice(2)).toEqual([
      "DELETE /repos/owner/releases/releases/1",
      "DELETE /repos/owner/releases/git/refs/tags/v0.1.0-nightly.20260801.1",
      "DELETE /repos/owner/releases/git/refs/tags/v0.1.0-nightly.20200101.1",
    ]);
  }),
);

it.effect("dry-run lists releases and tags without mutations", () =>
  Effect.gen(function* () {
    const { client, calls } = yield* fixture();
    const plan = yield* pruneNightlyReleases(client, { ...policy, keep: 1, maxAgeDays: 0 }, true);
    expect(plan.releases).toHaveLength(1);
    expect(plan.orphanTags).toHaveLength(1);
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  }),
);

it.effect("stops on tag deletion failure so the orphan can be recovered on the next run", () =>
  Effect.gen(function* () {
    const { client, calls } = yield* fixture(true);
    expect(
      (yield* pruneNightlyReleases(client, { ...policy, keep: 1, maxAgeDays: 0 }).pipe(Effect.flip))
        .message,
    ).toContain("HTTP 403");
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(2);
  }),
);
