import { ProviderInstanceId, UsageLimitSourceId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { resetCreditChoices } from "./usageLimits.ts";

const credits = {
  availableCount: 2,
  nextCreditId: "weekly",
  options: [
    {
      creditId: "weekly",
      label: "Weekly reset",
      description: "Refills weekly.",
      availableCount: 1,
    },
    {
      creditId: "fable",
      label: "Fable reset",
      description: "Refills Fable only.",
      availableCount: 1,
    },
  ],
};
it("offers distinct grants with their own descriptions and inputs", () => {
  const choices = resetCreditChoices(credits, { instanceId: ProviderInstanceId.make("claude") }, 0);
  expect(choices.map((choice) => choice.input)).toEqual([
    { instanceId: "claude", creditId: "weekly" },
    { instanceId: "claude", creditId: "fable" },
  ]);
  expect(choices[1]?.confirmDescription).toContain("Refills Fable only.");
});
it("keeps legacy and source-account redemption inputs intact", () => {
  const legacy = { availableCount: 1, nextCreditId: "weekly" };
  const local = { instanceId: ProviderInstanceId.make("claude") };
  expect(resetCreditChoices(legacy, local, 0)[0]?.input).toEqual(local);
  const source = { sourceId: UsageLimitSourceId.make("home"), accountId: "a", creditId: "weekly" };
  expect(resetCreditChoices(credits, source, 0)[0]?.summary).toContain("cannot select");
  expect(resetCreditChoices(credits, source, 0)[0]?.availableCount).toBe(0);
});
