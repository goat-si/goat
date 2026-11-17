import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestSetFilesViewedInput, PullRequestThreadComment } from "./pullRequest.ts";
import { PullRequestUnavailableError } from "./pullRequestErrors.ts";

// What the schemas looked like before these fields, as an older peer still decodes them.
const OlderThreadComment = PullRequestThreadComment.mapFields(
  ({ reviewUrl: _, ...fields }) => fields,
);
const OlderSetFilesViewedInput = Schema.Struct({
  ...PullRequestSetFilesViewedInput.fields,
  files: Schema.Array(Schema.Struct({ path: Schema.String, viewed: Schema.Boolean })),
});

const decodeComment = Schema.decodeUnknownSync(PullRequestThreadComment);
const decodeOlderComment = Schema.decodeUnknownSync(OlderThreadComment);
const decodePress = Schema.decodeUnknownSync(PullRequestSetFilesViewedInput);
const decodeOlderPress = Schema.decodeUnknownSync(OlderSetFilesViewedInput);
const decodeUnavailable = Schema.decodeUnknownSync(PullRequestUnavailableError);
// An older client knew the error without listResult.
const decodeOlderUnavailable = Schema.decodeUnknownSync(
  Schema.TaggedStruct("PullRequestUnavailableError", { reason: Schema.String }),
);

/** A payload as it arrives off the wire. */
const wire = (value: object): unknown => JSON.parse(JSON.stringify(value));

const comment = {
  id: "c1",
  author: null,
  body: "nit",
  createdAt: "2026-07-01T00:00:00.000Z",
  url: "https://github.com/o/r/pull/1#discussion_r1",
};
const reference = { projectId: "p1", repository: "o/r", number: 1 };

describe("pull request wire fields across versions", () => {
  it("decodes a thread comment's reviewUrl when present and absent, and an older peer ignores it", () => {
    const reviewUrl = "https://github.com/o/r/pull/1#pullrequestreview-9";
    expect(decodeComment(wire({ ...comment, reviewUrl }))).toMatchObject({ reviewUrl });
    expect(decodeComment(wire(comment))).not.toHaveProperty("reviewUrl");
    expect(decodeOlderComment(wire({ ...comment, reviewUrl }))).not.toHaveProperty("reviewUrl");
  });

  it("accepts a Viewed press with or without the file's revision, and an older server drops it", () => {
    const files = [{ path: "a.ts", viewed: true, revision: "blob-a" }];
    const plain = [{ path: "a.ts", viewed: true }];
    expect(decodePress(wire({ ...reference, files })).files).toEqual(files);
    expect(decodePress(wire({ ...reference, files: plain })).files).toEqual(plain);
    expect(decodeOlderPress(wire({ ...reference, files })).files).toEqual(plain);
  });

  it("refuses an empty or overlong revision", () => {
    for (const revision of ["", " ", "x".repeat(257)]) {
      const files = [{ path: "a.ts", viewed: true, revision }];
      expect(() => decodePress(wire({ ...reference, files }))).toThrow();
    }
  });
});

describe("a failed list's partial result", () => {
  const providers = ["github.com", "gitlab.com", "bitbucket.org"].map((host) => ({
    host,
    kind: "github",
    searchesOnHost: true,
    projectCount: 500,
    projectIds: Array.from({ length: 500 }, (_, index) => `project-${host}-${index}`),
    configured: false,
    detail: "GitHub CLI is not authenticated. Run gh auth login on the server.",
  }));
  const errors = Array.from({ length: 500 }, (_, index) => ({
    projectId: `project-${index}`,
    projectTitle: `a-long-organisation-name/a-long-repository-name-${index}`,
    message: `a-long-organisation-name/a-long-repository-name-${index} could not be read.`,
  }));
  const listResult = {
    viewers: {},
    providers,
    entries: [],
    errors,
    truncated: false,
    nextCursors: {},
  };
  const failure = {
    _tag: "PullRequestUnavailableError",
    reason: "cli-unauthenticated",
    listResult,
  };

  it("decodes on a newer client, is ignored by an older one, and stays bounded", () => {
    expect(decodeUnavailable(wire(failure)).listResult?.errors).toHaveLength(500);
    expect(decodeOlderUnavailable(wire(failure))).not.toHaveProperty("listResult");
    const bytes = new TextEncoder().encode(JSON.stringify(wire(failure))).length;
    // 500 unreadable repositories and three hosts naming 500 projects each.
    expect(bytes).toBeLessThan(160_000);
  });
});
