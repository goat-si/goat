import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ReviewDiffFileStat, reviewFileChangeType } from "./review.ts";
import { ReviewDiffFileStat as baseSchema } from "./testing/reviewDiffFileStat.base.ts";

const decodeBase = Schema.decodeUnknownSync(baseSchema);
const decodeCurrent = Schema.decodeUnknownSync(ReviewDiffFileStat);

describe("review file metadata compatibility", () => {
  it("lets an old schema ignore a new change type", () => {
    const payload = {
      path: "file",
      previousPath: null,
      additions: 1,
      deletions: 0,
      changeType: "new",
    };
    expect(decodeBase(payload)).toEqual({
      path: "file",
      previousPath: null,
      additions: 1,
      deletions: 0,
    });
    expect(decodeCurrent(payload)).toEqual(payload);
    expect(decodeCurrent({ path: "file", previousPath: null, additions: 0, deletions: 0 })).toEqual(
      { path: "file", previousPath: null, additions: 0, deletions: 0 },
    );
  });
  it("accepts an unfamiliar type for unknown presentation", () => {
    expect(
      decodeCurrent({
        path: "file",
        previousPath: null,
        additions: 0,
        deletions: 0,
        changeType: "future-kind",
      }).changeType,
    ).toBe("future-kind");
    expect(reviewFileChangeType({ changeType: "future-kind", previousPath: null })).toBe("unknown");
    expect(reviewFileChangeType({ previousPath: "before" })).toBe("rename-changed");
  });
});
