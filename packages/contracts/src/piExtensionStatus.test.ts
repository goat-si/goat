import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PiExtensionStatuses } from "./piExtensionStatus.ts";

const decode = Schema.decodeUnknownSync(Schema.Struct({ extensionStatuses: PiExtensionStatuses }));

describe("Pi extension status compatibility", () => {
  it("defaults an older session without statuses to an empty list", () => {
    expect(decode({})).toEqual({ extensionStatuses: [] });
  });

  it("accepts bounded statuses and rejects oversized payloads", () => {
    const status = { key: "watch", text: "Watching" };
    expect(decode({ extensionStatuses: [status] }).extensionStatuses).toEqual([status]);
    expect(() => decode({ extensionStatuses: Array.from({ length: 33 }, () => status) })).toThrow();
    expect(() => decode({ extensionStatuses: [{ ...status, key: "x".repeat(257) }] })).toThrow();
    expect(() => decode({ extensionStatuses: [{ ...status, text: "x".repeat(4097) }] })).toThrow();
  });
});
