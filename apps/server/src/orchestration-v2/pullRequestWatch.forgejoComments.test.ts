import {
  PullRequestWatchPolicy,
  SourceControlProviderKind,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ForgejoComment,
  forgejoComment,
} from "@goat/source-control-forgejo/server/forgejoPullRequestJson";

import { evaluatePullRequestWatch } from "./pullRequestWatch.ts";

const decodeForgejoComment = Schema.decodeSync(ForgejoComment);
// Bot remarks wake here, so the comment comparison is tested apart from the policy.
const context = {
  policy: {
    ...Schema.decodeSync(PullRequestWatchPolicy)({}),
    botRemarks: "react",
    conflictMaxIdleDays: null,
  },
  threadActiveAt: Date.parse("2026-10-02T12:00:00.000Z"),
  now: Date.parse("2026-10-02T12:00:00.000Z"),
} satisfies Parameters<typeof evaluatePullRequestWatch>[3];
type Args = Parameters<typeof evaluatePullRequestWatch>;
const evaluate = (watch: Args[0], detail: Args[1], remarks: Args[2]) =>
  evaluatePullRequestWatch(watch, detail, remarks, context);

describe("Forgejo comment watch boundary", () => {
  const createdAt = "2026-10-10T19:52:40Z";
  const editedAt = "2026-10-10T20:04:50Z";
  const seen = {
    startedAt: "2026-10-02T12:00:00.000Z",
    headSha: "aaaaaaaaaa",
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-10-10T19:52:40.000Z",
    remarkIds: ["29061"],
    conflicting: false,
    wakes: 2,
  } satisfies ThreadPullRequestWatch;
  const finalDetail = {
    provider: SourceControlProviderKind.make("forgejo"),
    headSha: seen.headSha,
    checks: [],
    mergeability: "mergeable",
    viewer: "agent-user",
    author: { login: "agent-user", name: null, avatarUrl: null },
  } satisfies Parameters<typeof evaluatePullRequestWatch>[1];
  const decodedComment = (updatedAt: string | null | undefined) =>
    forgejoComment(
      decodeForgejoComment({
        id: 29061,
        body: "Performance: five rounds complete",
        user: { login: "forgejo-actions" },
        created_at: createdAt,
        ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
      }),
    );

  it.each([undefined, null, createdAt, "2026-10-10T19:52:40.000Z"])(
    "does not wake for an unchanged comment with updated_at %s",
    (updatedAt) => {
      const comment = decodedComment(updatedAt);
      assert.isUndefined(comment.editedAt);
      assert.deepEqual(evaluate(seen, finalDetail, [comment]).changes, []);
    },
  );

  it("wakes once for the edit of an already-seen benchmark comment", () => {
    const finalComment = decodedComment(editedAt);
    assert.strictEqual(finalComment.editedAt, "2026-10-10T20:04:50.000Z");
    assert.isUndefined(decodedComment(createdAt).editedAt);
    const completed = evaluate(seen, finalDetail, [finalComment]);
    assert.deepEqual(completed.changes, [{ kind: "remarks", remarks: [finalComment] }]);
    assert.strictEqual(completed.next.remarksThrough, "2026-10-10T20:04:50.000Z");
    assert.deepEqual(evaluate(completed.next, finalDetail, [finalComment]).changes, []);
    assert.deepEqual(evaluate(seen, finalDetail, [decodedComment(createdAt)]).changes, []);
    const secondEdit = decodedComment("2026-10-10T20:05:50Z");
    const second = evaluate(completed.next, finalDetail, [secondEdit]);
    assert.deepEqual(second.changes, [{ kind: "remarks", remarks: [secondEdit] }]);
    assert.deepEqual(evaluate(second.next, finalDetail, [secondEdit]).changes, []);
    assert.deepEqual(
      evaluate(seen, finalDetail, [
        { ...finalComment, author: { login: "agent-user", name: null, avatarUrl: null } },
      ]).changes,
      [],
    );
  });
});
