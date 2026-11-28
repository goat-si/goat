import * as Effect from "effect/Effect";
export const activityListing = (...oids: ReadonlyArray<string>) => ({
  getChangeRequestActivity: () =>
    Effect.succeed({
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: oids.map((oid) => ({
        oid,
        messageHeadline: "Change",
        committedDate: "2026-01-01T00:00:00.000Z",
      })),
    }),
});
