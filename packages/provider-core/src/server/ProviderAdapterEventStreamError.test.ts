import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderAdapterEventStreamError } from "./ProviderAdapter.ts";

it("accepts missing and boolean local stream origin but rejects malformed origin", () => {
  const decode = Schema.decodeUnknownSync(ProviderAdapterEventStreamError);
  const input = {
    _tag: "ProviderAdapterEventStreamError",
    driver: "codex",
    providerSessionId: "session",
  };
  expect(decode(input).raisedByGoat).toBeUndefined();
  expect(decode({ ...input, raisedByGoat: true }).raisedByGoat).toBe(true);
  expect(() => decode({ ...input, raisedByGoat: "true" })).toThrow();
});
