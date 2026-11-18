import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  ProviderConsumeResetCreditInput,
  ServerProviderResetCredits,
} from "./providerUsageLimits.ts";

const decodeInput = Schema.decodeUnknownSync(ProviderConsumeResetCreditInput);
const decodeCredits = Schema.decodeUnknownSync(ServerProviderResetCredits);
it("accepts older reset requests and credit reports", () => {
  expect(decodeInput({ instanceId: "claude" })).toEqual({ instanceId: "claude" });
  expect(decodeCredits({ availableCount: 1, nextCreditId: "weekly" })).toEqual({
    availableCount: 1,
    nextCreditId: "weekly",
  });
});
it("rejects an empty selected credit", () => {
  expect(() => decodeInput({ instanceId: "claude", creditId: "" })).toThrow();
});
