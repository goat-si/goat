import { assert, expect, it } from "@effect/vitest";
import { SourceControlProviderKind, type ProjectId } from "@goat/contracts";
import { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Effect from "effect/Effect";
import { project, hostedChangeRequest } from "./pullRequestTestFixtures.ts";

function registerInteractiveRateLimitTest(
  makeService: typeof import("./PullRequestService.test.ts").makeService,
) {
  it.effect(
    "opening a pull request during a rate-limit pause still reads its detail and activity",
    () =>
      Effect.gen(function* () {
        let detailReads = 0;
        let activityReads = 0;
        const service = yield* makeService({
          projects: [
            project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
          ],
          providers: [
            fakePullRequestProvider(SourceControlProviderKind.make("github"), {
              getChangeRequest: ({ number }) =>
                Effect.suspend(() => {
                  detailReads += 1;
                  return number === 1
                    ? Effect.fail(
                        new PullRequestProviderError({
                          provider: SourceControlProviderKind.make("github"),
                          operation: "getChangeRequest",
                          reason: "rate-limited",
                          detail: "GitHub API rate limit exceeded.",
                        }),
                      )
                    : Effect.succeed({ ...hostedChangeRequest("Body"), number });
                }),
              getChangeRequestActivity: () =>
                Effect.sync(() => {
                  activityReads += 1;
                  return {
                    comments: [],
                    commentCount: 0,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                  };
                }),
            }),
          ],
        });
        const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 2 };

        yield* Effect.result(service.detail({ ...reference, number: 1 }));
        const background = yield* Effect.result(service.detail(reference));
        const opened = yield* Effect.result(
          service
            .detail(reference)
            .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),
        );
        const timeline = yield* Effect.result(
          service
            .activity(reference)
            .pipe(Effect.provideService(SourceControlRateLimit.Interactive, true)),
        );

        expect(background).toMatchObject({ _tag: "Failure" });
        expect({ opened, timeline }).toMatchObject({
          opened: { _tag: "Success", success: { number: 2 } },
          timeline: { _tag: "Success", success: { commentCount: 0 } },
        });
        assert.strictEqual(detailReads, 2);
        assert.strictEqual(activityReads, 1);
      }),
  );
}

function registerFinishedTurnListingTest(
  makeService: typeof import("./PullRequestService.test.ts").makeService,
) {
  it.effect("a finished turn leaves another project's cached listing in place", () =>
    Effect.gen(function* () {
      const reads: string[] = [];
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            listChangeRequests: ({ repository }) => {
              reads.push(repository);
              return Effect.succeed({ items: [], truncated: false, continues: false });
            },
          }),
        ],
      });
      const webListing = { state: "open" as const, projectId: "p1" as ProjectId };
      const everyListing = { state: "open" as const };

      yield* service.list(webListing);
      yield* service.list(everyListing);
      reads.length = 0;
      yield* service.refreshAfterTurn("p2" as ProjectId);
      yield* service.list(webListing);
      yield* service.list(everyListing);
      assert.deepStrictEqual(reads, []);

      yield* service.refreshAfterTurn("p2" as ProjectId, { pushed: true });
      yield* service.list(everyListing);
      assert.deepStrictEqual(reads.toSorted(), ["acme/api", "acme/web"]);
    }),
  );
}

export function registerPullRequestBehaviorTests(
  makeService: typeof import("./PullRequestService.test.ts").makeService,
) {
  registerInteractiveRateLimitTest(makeService);
  registerFinishedTurnListingTest(makeService);
}
