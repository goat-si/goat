import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageSummaryInput } from "./usage.ts";

const input = { sinceDay: "2026-08-01", untilDay: "2026-08-02", timeZone: "UTC" } as const;
const { provisional: _added, ...olderFields } = UsageSummaryInput.fields;
// The input a server from before `provisional` decodes with.
const OlderUsageSummaryInput = Schema.Struct(olderFields);
const wire = Schema.fromJsonString(UsageSummaryInput);
const decodeOlderInput = Schema.decodeUnknownSync(OlderUsageSummaryInput);
const decodeInput = Schema.decodeUnknownSync(UsageSummaryInput);
const decodeWire = Schema.decodeSync(wire);
const encodeWire = Schema.encodeSync(wire);

it("an older server reads a provisional request as a plain read", () => {
  const decoded = decodeOlderInput({ ...input, provisional: true });
  expect(decoded).toEqual(input);
});

it("a newer server reads an older client's request as a plain read", () => {
  const decoded = decodeWire(JSON.stringify(input));
  expect(decoded.provisional).toBeUndefined();
  const provisional = decodeWire(JSON.stringify({ ...input, provisional: true }));
  expect(decodeWire(encodeWire(provisional)).provisional).toBe(true);
});

it("rejects a provisional flag that is not a boolean", () => {
  expect(() => decodeInput({ ...input, provisional: "yes" })).toThrow();
});
