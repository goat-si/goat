import { describe, expect, it } from "vite-plus/test";

import { resolveBrandChannel, resolveEnvironmentIdentificationPillLabel } from "./brandChannel";

describe("brandChannel", () => {
  it.each([
    ["Dev", "dev", "Dev"],
    [" dev ", "dev", "Dev"],
    ["nightly", "nightly", "Nightly"],
    ["NIGHTLY", "nightly", "Nightly"],
    ["Latest", "stable", null],
    ["Alpha", "stable", null],
    ["", "stable", null],
    [null, "stable", null],
    [undefined, "stable", null],
  ] as const)("resolves %s to %s", (stageLabel, channel, label) => {
    expect(resolveBrandChannel(stageLabel)).toBe(channel);
    expect(resolveEnvironmentIdentificationPillLabel(stageLabel)).toBe(label);
  });
});
