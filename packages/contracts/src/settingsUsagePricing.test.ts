import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });

  it("ignores an invalid model filter without dropping the other settings", () => {
    const valid = { include: [{ provider: "newer-provider", model: "orbit-1" }] };
    expect(decodeServerSettings({ usageModelFilter: valid }).usageModelFilter).toEqual(valid);
    const settings = decodeServerSettings({
      usageModelFilter: { exclude: [{ model: "" }] },
      usageModelAliases: { "drift-9": "orbit-1" },
    });
    expect(settings.usageModelFilter).toBeUndefined();
    expect(settings.usageModelAliases).toEqual({ "drift-9": "orbit-1" });
  });
});
