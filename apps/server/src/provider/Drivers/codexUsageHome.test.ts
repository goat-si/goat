import type { ServerProviderDraft } from "@goat/provider-core/server/snapshotProbe";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@goat/provider-core/server/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { withoutOtherHomeUsage } from "./codexUsageHome.ts";

const window = (usedPercent: number) => ({
  id: "primary",
  kind: "session" as const,
  label: "5h",
  usedPercent,
});
// Home A's published limits, last updated by a session report after B's read began.
const publishedA = makeUsageLimits({
  checkedAt: "2033-01-01T00:00:05.000Z",
  windows: [window(80)],
});

/** What the shared provider publishes after a check whose read was `probed`. */
const committed = (
  probed: ReturnType<typeof makeUsageLimits>,
  home: "same" | "other" | "unknown",
) =>
  resolveUsageLimitsAfterProbe({
    published: publishedA,
    probed: withoutOtherHomeUsage(
      { usageLimits: probed } as ServerProviderDraft,
      home,
      "2033-01-01T00:00:06.000Z",
    ).usageLimits,
  });

describe("withoutOtherHomeUsage", () => {
  it("a failed read under a new home keeps nothing of the previous home's limits", () => {
    const failed = makeUnavailableUsageLimits({
      checkedAt: "2033-01-01T00:00:01.000Z",
      reason: "probeFailed",
    });
    expect(committed(failed, "other")).toBeUndefined();
    expect(committed(failed, "same")).toBe(publishedA);
  });

  it("a read under a new home shows its windows even when the previous home's look newer", () => {
    const readB = makeUsageLimits({ checkedAt: "2033-01-01T00:00:01.000Z", windows: [window(20)] });
    expect(committed(readB, "other")?.windows.map((entry) => entry.usedPercent)).toEqual([20]);
    expect(committed(readB, "same")?.windows.map((entry) => entry.usedPercent)).toEqual([80]);
  });

  it("a read whose home moved while it ran publishes no limits of either home", () => {
    const read = makeUsageLimits({ checkedAt: "2033-01-01T00:00:07.000Z", windows: [window(30)] });
    expect(committed(read, "unknown")).toBeUndefined();
  });
});
