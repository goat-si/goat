import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

const decode = Schema.decodeUnknownSync(ServerProviderUsageLimits);
it("accepts an older usage report without a zero cap", () => {
  expect(
    decode({ checkedAt: "2026-01-01T00:00:00.000Z", windows: [] }).zeroSpendCap,
  ).toBeUndefined();
});
it("rejects a non-boolean zero cap", () => {
  expect(() =>
    decode({ checkedAt: "2026-01-01T00:00:00.000Z", windows: [], zeroSpendCap: "true" }),
  ).toThrow();
});
