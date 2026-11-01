import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { MemoryHubSettingsSnapshot } from "./MemoryHubSettings.ts";

const space = "00000000-0000-4000-8000-000000000001";
const otherSpace = "00000000-0000-4000-8000-000000000002";
const decode = Schema.decodeUnknownSync(MemoryHubSettingsSnapshot);
it("retains server-only provenance, decodes old receipts and rejects mismatched spaces", () => {
  assert.isNull(decode({ settings: { mode: "disabled" }, version: 0 }).provenance);
  const receipt = {
    settings: { mode: "hub", memorySpaceId: space },
    version: 1,
    provenance: { source: "auto-initialized", memorySpaceId: space },
  };
  expect(decode(receipt)).toEqual(receipt);
  assert.throws(() =>
    decode({ ...receipt, provenance: { ...receipt.provenance, memorySpaceId: otherSpace } }),
  );
  assert.throws(() =>
    decode({ ...receipt, provenance: { ...receipt.provenance, source: "manual" } }),
  );
  assert.throws(() => decode({ ...receipt, settings: { mode: "disabled" } }));
});
