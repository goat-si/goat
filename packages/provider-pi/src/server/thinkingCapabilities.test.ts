import { assert, it } from "@effect/vitest";
import { thinkingCapabilitiesForPiModel } from "./thinkingCapabilities.ts";

it("uses the explicitly advertised thinking levels when present", () => {
  const result = thinkingCapabilitiesForPiModel(
    { reasoning: true, supportedThinkingLevels: ["off", "high", "max", "unknown"] },
    "high",
  );
  const descriptor = result.optionDescriptors?.find((option) => option.id === "thinking");
  assert.equal(descriptor?.type, "select");
  assert.deepEqual(
    descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ["off", "high", "max"],
  );
});
