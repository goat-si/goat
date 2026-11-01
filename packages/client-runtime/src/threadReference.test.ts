import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";

import { resolveThreadReferenceCopyTarget, threadChipCopyTarget } from "./threadReference.ts";

const crossRepositoryPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "other/repo",
  number: 42,
  url: "https://github.com/other/repo/pull/42",
  source: "manual",
  linkedAt: "2026-01-01T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

describe("resolveThreadReferenceCopyTarget", () => {
  it("copies a thread as a context fragment that retains its environment", () => {
    const ref = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("thread-1"),
    };
    const target = threadChipCopyTarget(ref, "Remote work");
    expect(target.fragment?.source.environmentId).toBe(ref.environmentId);
    expect(target.fragment?.records).toEqual([
      expect.objectContaining({ kind: "thread", ...ref, title: "Remote work" }),
    ]);
    expect(target.value).toContain("thread/");
    expect(decodeComposerContextFragment(encodeComposerContextFragment(target.fragment!)!)).toEqual(
      target.fragment,
    );
  });
  it("does not copy another reference while the open panel URL is unavailable", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: null,
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toBeNull();
  });

  it("prefers the open panel pull request over the thread pull request", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        openPanelPullRequestUrl: "https://github.com/t3/pr/14",
        pullRequests: [crossRepositoryPullRequest],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({
      kind: "pull-request",
      value: "https://github.com/t3/pr/14",
      successTitle: "PR link copied",
    });
  });

  it.each([null, "https://github.com/t3/pr/12"])(
    "copies a native cross-repository link before the fallback URL %s",
    (linkedPullRequestUrl) => {
      expect(
        resolveThreadReferenceCopyTarget({
          threadId: "thread-1",
          pullRequests: [crossRepositoryPullRequest],
          linkedPullRequestUrl,
        }),
      ).toMatchObject({
        kind: "pull-request",
        value: crossRepositoryPullRequest.url,
      });
    },
  );

  it("uses the fallback URL when native links are dismissed", () => {
    expect(
      resolveThreadReferenceCopyTarget({
        threadId: "thread-1",
        pullRequests: [{ ...crossRepositoryPullRequest, source: "stack-dismissed" }],
        linkedPullRequestUrl: "https://github.com/t3/pr/12",
      }),
    ).toMatchObject({ kind: "pull-request", value: "https://github.com/t3/pr/12" });
  });
});
