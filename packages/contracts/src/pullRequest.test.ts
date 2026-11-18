import { SourceControlProviderKind } from "./sourceControl.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PullRequestActionInput,
  PullRequestDetail,
  PullRequestLabel,
  PullRequestListResult,
  PullRequestFilterOptions,
  PullRequestMergeCapabilities,
  resolvePullRequestAuthorFilter,
} from "./pullRequest.ts";

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(PullRequestDetail));
const decodeFilterOptions = Schema.decodeUnknownSync(Schema.toCodecJson(PullRequestFilterOptions));

const LIST_RESULT: PullRequestListResult = {
  viewers: { "github.com": "bilal", "gitlab.com": "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: SourceControlProviderKind.make("github"),
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: SourceControlProviderKind.make("gitlab"),
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: "project-1" as PullRequestListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "goat-si/goat",
      number: 1,
      title: "Add a pull requests page",
      url: "https://github.com/goat-si/goat/pull/1",
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: "feat/page",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      viewerReviewRequested: false,
      labels: [{ name: "backend", color: null }],
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com goat-si/goat": "2026-07-02T00:00:00Z|1|1" },
};

describe("PullRequestListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record
   * with an optional value, for one — fails as an interrupted request rather than as a schema
   * error.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(PullRequestListResult);

    const decoded = Schema.decodeSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });
});

describe("PullRequestCapabilities", () => {
  const base = {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: true, listCandidates: true },
  };

  it("loads a newer server's detail response, dropping unknown options in order", () => {
    const options = {
      actions: ["close", "archive", "merge"],
      verdicts: ["request-changes", "block", "approve"],
      updateMethods: ["rebase", "fast-forward", "merge"],
    };
    const detail = {
      ...LIST_RESULT.entries[0],
      workspaceRoot: "/workspace/sample-repo",
      body: "",
      changedFiles: 1,
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      capabilities: {
        ...base,
        actions: options.actions,
        mergeMethods: ["squash", "semi-linear", "merge"],
        updateMethods: options.updateMethods,
        review: { ...base.review, verdicts: options.verdicts },
      },
      viewerPermissions: { ...options, comment: true, resolve: true, requestReviewers: true },
    };
    const decoded = decodeDetail(detail);

    expect(decoded.capabilities).toEqual({
      ...base,
      actions: ["close", "merge"],
      mergeMethods: ["squash", "merge"],
      updateMethods: ["rebase", "merge"],
      review: { ...base.review, verdicts: ["request-changes", "approve"] },
    });
    expect(decoded.viewerPermissions).toEqual({
      actions: ["close", "merge"],
      verdicts: ["request-changes", "approve"],
      updateMethods: ["rebase", "merge"],
      comment: true,
      resolve: true,
      requestReviewers: true,
    });
    expect(decoded.title).toBe(detail.title);
  });
});

describe("PullRequestDetail merge queue removal", () => {
  const detail = {
    ...LIST_RESULT.entries[0],
    workspaceRoot: "/workspace/sample-repo",
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: [],
      search: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
      reviewers: { request: true, listCandidates: true },
    },
    viewerPermissions: {
      actions: [],
      verdicts: [],
      comment: true,
      resolve: true,
      requestReviewers: true,
    },
  };
  const removal = { id: "RMQE_1", removedAt: "2026-07-02T00:00:00Z", reason: "CI failed" };
  // A peer built from dev before merge queue removals: the same contract minus that one field.
  const { mergeQueueRemoval: _addedField, ...fieldsBeforeRemovals } = PullRequestDetail.fields;
  const decodeWithPeerBeforeRemovals = Schema.decodeUnknownSync(
    Schema.toCodecJson(Schema.Struct(fieldsBeforeRemovals)),
  );

  it("reads an older server's detail, which reports no removal", () => {
    const decoded = decodeDetail(detail);
    expect(Object.hasOwn(decoded, "mergeQueueRemoval")).toBe(false);
  });

  it("an older peer accepts a detail that reports a removal and drops the unknown key", () => {
    const encoded = JSON.parse(JSON.stringify({ ...detail, mergeQueueRemoval: removal }));
    expect(decodeDetail(encoded).mergeQueueRemoval).toEqual(removal);
    const decoded = decodeWithPeerBeforeRemovals(encoded);
    expect(Object.hasOwn(decoded, "mergeQueueRemoval")).toBe(false);
    expect(decoded.title).toBe(detail.title);
  });

  it("rejects a removal without an id or with a reason that is not text", () => {
    expect(() => decodeDetail({ ...detail, mergeQueueRemoval: { ...removal, id: " " } })).toThrow();
    expect(() =>
      decodeDetail({ ...detail, mergeQueueRemoval: { ...removal, reason: 5 } }),
    ).toThrow();
  });

  it("a client reads a detail whose auto-merge method a newer host added, dropping only that method", () => {
    // fast-forward joined the merge methods this way; the next one must not break older clients.
    const decoded = decodeDetail({ ...detail, autoMergeEnabled: true, autoMergeMethod: "train" });
    expect(Object.hasOwn(decoded, "autoMergeMethod")).toBe(false);
    expect(decoded.autoMergeEnabled).toBe(true);
    expect(decodeDetail({ ...detail, autoMergeMethod: "fast-forward" }).autoMergeMethod).toBe(
      "fast-forward",
    );
  });
});

describe("fast-forward merges", () => {
  const decodeMergeCapabilities = Schema.decodeUnknownSync(PullRequestMergeCapabilities);
  // Peers built from dev before fast-forward: the same contracts minus that method.
  const { "fast-forward": _added, ...capabilityFieldsBefore } = PullRequestMergeCapabilities.fields;
  const decodeCapabilitiesBefore = Schema.decodeUnknownSync(Schema.Struct(capabilityFieldsBefore));
  const decodeActionBefore = Schema.decodeUnknownSync(
    Schema.Struct({
      ...PullRequestActionInput.fields,
      mergeMethod: Schema.optional(Schema.Literals(["merge", "squash", "rebase"])),
    }),
  );
  const merge = { projectId: "p1", repository: "acme/web", number: 1, action: "merge" };

  it("reads an older server's merge capabilities as not allowing fast-forward", () => {
    const decoded = decodeMergeCapabilities({ merge: true, squash: true, rebase: true });
    expect(decoded["fast-forward"]).toBeUndefined();
  });

  it("an older peer drops a fast-forward capability it does not know", () => {
    const sent = { merge: false, squash: false, rebase: false, "fast-forward": true };
    expect(decodeMergeCapabilities(sent)["fast-forward"]).toBe(true);
    expect(Object.hasOwn(decodeCapabilitiesBefore(sent), "fast-forward")).toBe(false);
  });

  it("an older server refuses a fast-forward merge request instead of merging another way", () => {
    expect(() => decodeActionBefore({ ...merge, mergeMethod: "fast-forward" })).toThrow();
    expect(decodeActionBefore({ ...merge, mergeMethod: "rebase" }).mergeMethod).toBe("rebase");
  });
});

describe("resolvePullRequestAuthorFilter", () => {
  it("reads me as the signed-in account on the host", () => {
    expect(resolvePullRequestAuthorFilter("me", "bilal")).toBe("bilal");
    expect(resolvePullRequestAuthorFilter(" @Me ", "bilal")).toBe("bilal");
  });

  it("keeps me as a literal login when the host has no viewer", () => {
    expect(resolvePullRequestAuthorFilter("me", null)).toBe("me");
    expect(resolvePullRequestAuthorFilter("@me", " ")).toBe("@me");
  });

  it("passes any other login through trimmed", () => {
    expect(resolvePullRequestAuthorFilter(" ana ", "bilal")).toBe("ana");
    expect(resolvePullRequestAuthorFilter("meredith", "bilal")).toBe("meredith");
  });
});

it("decodes filter options from a server without reference completion", () => {
  const result = decodeFilterOptions({
    labels: [],
    authors: [],
    truncated: false,
  });
  expect(result.references).toEqual([]);
});

it("accepts labels from older servers and rejects invalid descriptions", () => {
  const decode = Schema.decodeUnknownSync(PullRequestLabel);
  expect(decode({ name: "bug", color: null })).toEqual({ name: "bug", color: null });
  expect(() => decode({ name: "bug", color: null, description: 42 })).toThrow();
});
