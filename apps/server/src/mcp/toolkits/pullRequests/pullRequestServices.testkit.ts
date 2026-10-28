import * as Layer from "effect/Layer";

import * as PullRequestSync from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";

/** The pull request toolkit's services with no behavior, for tests that only list or route its tools. */
export const inertPullRequestServices = Layer.mergeAll(
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestSync.PullRequestSyncReactor)({}),
);
