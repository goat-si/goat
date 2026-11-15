import { assert, describe, it } from "@effect/vitest";
import type { PullRequestState } from "@goat/contracts";
import { botRowPullRequests, type PullRequestSource } from "./channelBotRowPullRequests.ts";

const source = (refreshed: boolean, state?: PullRequestState, final?: true): PullRequestSource => ({
  refreshed,
  ...(final ? { final: new Set(["goat-si/goat#42"]) } : {}),
  pullRequests: [
    {
      repository: "goat-si/goat",
      number: 42,
      url: "https://github.com/goat-si/goat/pull/42",
      ...(state === undefined ? {} : { state }),
      watching: false,
    },
  ],
});
const none: PullRequestSource = { refreshed: false, pullRequests: [] };
// Each source states something different about the same pull request.
const refreshedThread = source(true, "open");
const staleFinalThread = source(false, "closed");
const staleOpenThread = source(false, "open");
const runningCopy = source(true, "merged");
const staleOpenCopy = source(false, "open");
// An unsettled thread whose closed snapshot the refresher no longer reads (closed 24 hours or more).
const finalClosedThread = source(true, "closed", true);
// Merged with mergedAt: final, and a merge cannot be undone, whether or not the thread is read.
const finalMergedThread = source(true, "merged", true);
const staleFinalMergedThread = source(false, "merged", true);

const kept = (
  threads: ReadonlyArray<PullRequestSource>,
  copy = none,
): ReadonlyArray<string> | undefined =>
  botRowPullRequests(threads, copy).pullRequests?.map((item) => item.state ?? "none");

describe("botRowPullRequests", () => {
  it("keeps one pull request per key, by the precedence of what its sources can still say", () => {
    const cases: ReadonlyArray<
      readonly [string, ReadonlyArray<PullRequestSource>, PullRequestSource, string]
    > = [
      // A refreshed thread outranks a final state nothing reads any more, in either order.
      ["refreshed, then stale final", [refreshedThread, staleFinalThread], none, "open"],
      ["stale final, then refreshed", [staleFinalThread, refreshedThread], none, "open"],
      ["refreshed thread over the copy", [refreshedThread], runningCopy, "open"],
      ["refreshed, then stateless", [refreshedThread, staleOpenThread], none, "open"],
      ["stateless, then refreshed", [staleOpenThread, refreshedThread], none, "open"],
      ["stale final thread over the copy", [staleFinalThread], runningCopy, "closed"],
      ["stale final, then stateless", [staleFinalThread, staleOpenThread], none, "closed"],
      ["stateless, then stale final", [staleOpenThread, staleFinalThread], none, "closed"],
      ["the copy over a stateless thread", [staleOpenThread], runningCopy, "merged"],
      ["no state anywhere", [staleOpenThread], staleOpenCopy, "none"],
      // A closed snapshot nothing reads any more never outranks an open one still read.
      ["final closed, then refreshed", [finalClosedThread, refreshedThread], none, "open"],
      ["refreshed, then final closed", [refreshedThread, finalClosedThread], none, "open"],
      ["final closed over the copy", [finalClosedThread], runningCopy, "closed"],
      // A confirmed merge outranks an open state another thread still reads, in either order.
      ["final merged, then refreshed open", [finalMergedThread, refreshedThread], none, "merged"],
      ["refreshed open, then final merged", [refreshedThread, finalMergedThread], none, "merged"],
      [
        "stale merged, then refreshed open",
        [staleFinalMergedThread, refreshedThread],
        none,
        "merged",
      ],
      [
        "refreshed open, then stale merged",
        [refreshedThread, staleFinalMergedThread],
        none,
        "merged",
      ],
    ];
    assert.deepStrictEqual(
      Object.fromEntries(cases.map(([name, threads, copy]) => [name, kept(threads, copy)])),
      Object.fromEntries(cases.map(([name, , , state]) => [name, [state]])),
    );
  });
});
