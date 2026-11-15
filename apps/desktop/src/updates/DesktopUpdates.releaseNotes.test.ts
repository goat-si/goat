import * as NodeModule from "node:module";

import { assert, describe, it } from "@effect/vitest";
import { computeReleaseNotes } from "electron-updater/out/providers/GitHubProvider.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

type ReleaseFeed = Parameters<typeof computeReleaseNotes>[2];
type RunningVersion = Parameters<typeof computeReleaseNotes>[0];

// electron-updater's own dependencies, which apps/desktop does not declare.
const requireFromUpdater = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("electron-updater"),
);
const { parseXml } = requireFromUpdater("builder-util-runtime") as {
  parseXml: (xml: string) => ReleaseFeed;
};
const semver = requireFromUpdater("semver") as { parse: (version: string) => RunningVersion };

const releaseTitle = (version: string) =>
  version.includes("-nightly.") ? `GOAT Nightly ${version} (0123456789ab)` : `GOAT v${version}`;

const releaseFeed = (...versions: ReadonlyArray<string>) =>
  parseXml(
    `<feed xmlns="http://www.w3.org/2005/Atom">${versions
      .map(
        (version) =>
          `<entry><link rel="alternate" type="text/html" href="https://github.com/goat-si/goat-releases/releases/tag/v${version}"/><title>${releaseTitle(version)}</title><content type="html">&lt;ul&gt;&lt;li&gt;${version} change&lt;/li&gt;&lt;/ul&gt;</content></entry>`,
      )
      .join("")}</feed>`,
  );

/** The update info electron-updater's GitHub provider reports when /releases/latest names `version`. */
const stableUpdateInfo = (
  feed: ReleaseFeed,
  version: string,
  runningVersion: string,
  fullChangelog: boolean,
) => {
  const latestRelease =
    feed
      .getElements("entry")
      .find((entry) => entry.element("link").attribute("href").endsWith(`/tag/v${version}`)) ??
    feed.element("entry");
  return {
    version,
    releaseName: latestRelease.elementValueOrEmpty("title"),
    releaseNotes: computeReleaseNotes(
      semver.parse(runningVersion),
      fullChangelog,
      feed,
      latestRelease,
    ),
  };
};

describe("DesktopUpdates release notes", () => {
  it.effect.each([
    {
      name: "shows no notes for a Stable release missing from the releases feed",
      runningVersion: "1.2.3",
      feedVersions: ["1.2.5-nightly.20261102.1", "1.2.5-nightly.20261101.1"],
      expected: [],
    },
    {
      name: "shows a Stable release's own notes from the releases feed",
      runningVersion: "1.2.3",
      feedVersions: ["1.2.5-nightly.20261102.1", "1.2.4", "1.2.4-nightly.20261030.1"],
      expected: [{ version: "1.2.4", items: ["1.2.4 change"], totalItems: 1 }],
    },
    {
      name: "shows a Stable release's notes when switching down from a newer Nightly",
      runningVersion: "1.2.5-nightly.20261027.1",
      feedVersions: ["1.2.5-nightly.20261102.1", "1.2.4"],
      expected: [{ version: "1.2.4", items: ["1.2.4 change"], totalItems: 1 }],
    },
  ])("$name", ({ runningVersion, feedVersions, expected }) => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit(
          "update-available",
          stableUpdateInfo(
            releaseFeed(...feedVersions),
            "1.2.4",
            runningVersion,
            harness.fullChangelog(),
          ),
        );
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.availableVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, expected);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
