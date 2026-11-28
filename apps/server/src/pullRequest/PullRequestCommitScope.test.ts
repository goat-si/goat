import { SourceControlProviderKind, type ProjectId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import {
  project,
  makeService,
  changeRequest,
  fakeProvider,
  hostedChangeRequest,
} from "./pullRequestTestFixtures.ts";
import { activityListing } from "./pullRequestActivityListing.testkit.ts";

it.effect("a refused merge notifies readers so they re-read the conflicting state", () =>
  Effect.gen(function* () {
    let mergeable = true;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestSummary: () =>
            Effect.succeed({
              ...changeRequest(1, "2026-09-16T00:00:00.000Z"),
              mergeability: mergeable ? "mergeable" : "conflicting",
            }),
          runAction: () =>
            Effect.suspend(() => {
              mergeable = false;
              return Effect.fail(
                new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation: "runAction",
                  reason: "failed",
                  detail: "Pull Request has merge conflicts",
                }),
              );
            }),
        }),
      ],
    });

    assert.strictEqual((yield* service.summary(reference)).mergeability, "mergeable");
    const refreshed = yield* service.subscribeRefreshes.pipe(
      Stream.take(1),
      Stream.mapEffect(() => service.summary(reference)),
      Stream.runHead,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.flip(service.runAction({ ...reference, action: "merge" }));
    assert.strictEqual(Option.getOrThrow(yield* Fiber.join(refreshed)).mergeability, "conflicting");
  }),
);

it.effect("reads a commit's diff only for a commit the change request lists", () =>
  Effect.gen(function* () {
    const listed = "a".repeat(40);
    const read: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider(SourceControlProviderKind.make("github"), {
          ...activityListing(listed, "b".repeat(40)),
          getDiff: (input) =>
            Effect.sync(() => {
              read.push(input.commit);
              return {
                patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+x\n",
                truncated: false,
                nextCursor: null,
              };
            }),
          getDiffFilePaths: () =>
            Effect.succeed({ files: [{ oldPath: "a.ts", newPath: "a.ts" }], nextCursor: null }),
          getDiffFileContents: (input) =>
            Effect.sync(() => {
              read.push(input.commit);
              return { oldContents: "old", newContents: "new" };
            }),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const file = { changeType: "change" as const, oldPath: "a.ts", newPath: "a.ts" };

    for (const commit of ["c".repeat(40), "abcdef", "A".repeat(41), ""]) {
      const diff = yield* service.diff({ ...ref, commit }).pipe(Effect.flip);
      const contents = yield* service
        .diffFileContents({ ...ref, ...file, commit })
        .pipe(Effect.flip);
      assert.strictEqual(diff.reason, "not-found");
      assert.strictEqual(contents.reason, "not-found");
    }
    assert.deepStrictEqual(read, []);

    yield* service.diff({ ...ref, commit: "AAAAAAA" });
    yield* service.diffFileContents({ ...ref, ...file, commit: "aaaaaaa" });
    assert.deepStrictEqual(read, [listed, listed]);
  }),
);

it.effect("refuses a review when the requested head has moved before submitting", () =>
  Effect.gen(function* () {
    let writes = 0;
    const head = "a".repeat(40);
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () => Effect.succeed({ ...hostedChangeRequest(""), headSha: head }),
          submitReview: ({ expectedHeadSha }) =>
            Effect.sync(() => {
              assert.strictEqual(expectedHeadSha, head);
              writes++;
            }),
        }),
      ],
    });
    const input = {
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      verdict: "approve" as const,
      body: "",
      comments: [],
    };
    const error = yield* service
      .submitReview({ ...input, expectedHeadSha: "b".repeat(40) })
      .pipe(Effect.flip);
    assert.include(error.detail, "Review the new commits");
    assert.strictEqual(writes, 0);
    yield* service.submitReview({ ...input, expectedHeadSha: "aaaaaaa" });
    assert.strictEqual(writes, 1);
  }),
);
