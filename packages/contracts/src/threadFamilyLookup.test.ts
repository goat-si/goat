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
  it("carries each looked-up thread's project, and an older client's decode ignores it", () => {
    const answer = {
      snapshotSequence: 0,
      threads: [],
      lookupTitles: { fork: "Fork" },
      lookupProjectIds: { fork: "project-1", orphan: null },
    };
    expect(decodeFamily(answer).lookupProjectIds).toEqual({ fork: "project-1", orphan: null });
    const olderFamily = Schema.Struct({
      snapshotSequence: Schema.Number,
      threads: Schema.Array(Schema.Unknown),
      lookupTitles: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    });
    expect(Schema.decodeSync(olderFamily)(answer)).toEqual({
      snapshotSequence: 0,
      threads: [],
      lookupTitles: { fork: "Fork" },
    });
  });
});
