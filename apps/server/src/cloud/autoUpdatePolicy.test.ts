import { describe, expect, it } from "@effect/vitest";
import { compareRuntimeProtocols, hostCompatibilityOf } from "@goat/shared/sshRuntimeProtocol";
import {
  arbitrateAutomaticTargets,
  automaticUpdateChannel,
  classifyAutomaticTarget,
} from "./autoUpdatePolicy.ts";

const nightly = (day: string, build = 1) => `1.1.0-nightly.202610${day}.${build}`;

describe("automatic update policy", () => {
  it.each([
    ["1.0.0", "stable"],
    [nightly("01"), "nightly"],
    ["1.0.0-preview.20261001.1", undefined],
    ["1.0.0-dev.20261001.gabc", undefined],
    ["1.0.0-pr.123.1", undefined],
  ] as const)("%s follows %s", (version, channel) => {
    expect(automaticUpdateChannel(version)).toBe(channel);
  });

  it("allows only a strictly newer target on the same channel that never failed", () => {
    const classify = (targetVersion: string, failedTarget?: string) =>
      classifyAutomaticTarget({ ownVersion: "1.0.0", targetVersion, failedTarget });
    expect(classify("1.1.0")).toBe("eligible");
    expect(classify("1.0.0")).toBe("not-newer");
    expect(classify("0.9.0")).toBe("not-newer");
    expect(classify(nightly("02"))).toBe("wrong-channel-or-unpublished");
    expect(classify("2.0.0-preview.20261001.1")).toBe("wrong-channel-or-unpublished");
    expect(classify("1.1.0-dev.20261001.gabc")).toBe("wrong-channel-or-unpublished");
    expect(classify("1.1.0", "1.1.0")).toBe("previous-failure");
    expect(
      classifyAutomaticTarget({
        ownVersion: "1.0.0-dev.20261001.gabc",
        targetVersion: "1.1.0",
        failedTarget: undefined,
      }),
    ).toBe("unpublished-or-preview-build");
  });

  it("arbitrates two clients' requests to the newest eligible target", () => {
    // Client A runs an older stable, client B a newer one; neither can move the runtime back.
    expect(
      arbitrateAutomaticTargets({
        ownVersion: "1.1.0",
        failedTarget: undefined,
        candidates: ["1.0.0", "1.2.0"],
      }),
    ).toBe("1.2.0");
    expect(
      arbitrateAutomaticTargets({
        ownVersion: "1.1.0",
        failedTarget: undefined,
        candidates: ["1.3.0", "1.2.0"],
      }),
    ).toBe("1.3.0");
    // A nightly client cannot move a stable runtime onto its channel, and a rolled-back
    // target loses to an older eligible one.
    expect(
      arbitrateAutomaticTargets({
        ownVersion: "1.0.0",
        failedTarget: "1.3.0",
        candidates: [nightly("05"), "1.3.0", "1.2.0"],
      }),
    ).toBe("1.2.0");
    expect(
      arbitrateAutomaticTargets({
        ownVersion: "1.0.0",
        failedTarget: undefined,
        candidates: [nightly("05"), "0.9.0"],
      }),
    ).toBeUndefined();
  });

  it("a runtime newer than a client keeps serving it while the client's protocol is in range", () => {
    // An older client speaks orchestration 4; the updated runtime serves 4 through 6.
    const client = { ssh: { min: 1, max: 1 }, orchestration: { min: 4, max: 4 } };
    const updated = { ssh: { min: 1, max: 1 }, orchestration: { min: 4, max: 6 } };
    expect(compareRuntimeProtocols(client, { protocol: updated })).toBe("compatible");
    expect(hostCompatibilityOf(client, { protocol: updated })).toEqual({
      compatibility: "compatible",
      update: null,
    });
    // Once the runtime stops serving 4, the client is the side named to update.
    const dropped = { ssh: { min: 1, max: 1 }, orchestration: { min: 5, max: 6 } };
    expect(hostCompatibilityOf(client, { protocol: dropped })).toEqual({
      compatibility: "incompatible",
      update: "this-machine",
    });
  });
});
