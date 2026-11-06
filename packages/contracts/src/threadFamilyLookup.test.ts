import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2GetThreadFamilyInput,
  OrchestrationV2ThreadFamily,
} from "./orchestrationV2.ts";

const decodeInput = Schema.decodeUnknownSync(OrchestrationV2GetThreadFamilyInput);
const decodeFamily = Schema.decodeUnknownSync(OrchestrationV2ThreadFamily);

describe("thread family lookup compatibility", () => {
  it("accepts a bounded list of requested thread ids", () => {
    expect(decodeInput({ threadId: "current", lookupThreadIds: ["fork"] })).toMatchObject({
      lookupThreadIds: ["fork"],
    });
    expect(() =>
      decodeInput({
        threadId: "current",
        lookupThreadIds: Array.from({ length: 101 }, (_, index) => `thread-${index}`),
      }),
    ).toThrow();
  });
  it("accepts a legacy family response without lookup results", () => {
    expect(decodeFamily({ snapshotSequence: 0, threads: [] })).toEqual({
      snapshotSequence: 0,
      threads: [],
    });
  });
});
