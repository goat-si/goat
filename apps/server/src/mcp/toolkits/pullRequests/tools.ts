import { withClientRequestId } from "../keyedParameters.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PositiveInt,
  PullRequestActivity,
  PullRequestChecks,
  PullRequestDetail,
  PullRequestDiffFileContentsInput,
  PullRequestFilterOptions,
  PullRequestFilterOptionsInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsResult,
  PullRequestReviewGuide,
  PullRequestReviewGuideRun,
  PullRequestState,
  PullRequestThreadComment,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestService from "../../../pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ProjectService.ProjectService,
];

const guideDependencies = [
  ...dependencies,
  PullRequestReviewGuideService.PullRequestReviewGuideService,
];

export const PullRequestTargetInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Thread. Default: this thread.",
    }),
  ),
  url: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "With `number`, when no `url`.",
    }),
  ),
  number: Schema.optional(
    PositiveInt.annotate({
      description: "With `repository`, when no `url`.",
    }),
  ),
  host: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Default: this project's host.",
    }),
  ),
});
export type PullRequestTargetInput = typeof PullRequestTargetInput.Type;

export class PullRequestUrlInvalidError extends Schema.TaggedError<PullRequestUrlInvalidError>()(
  "PullRequestUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a recognised pull request URL. Pass repository and number instead.";
  }
}

export class PullRequestTargetIncompleteError extends Schema.TaggedError<PullRequestTargetIncompleteError>()(
  "PullRequestTargetIncompleteError",
  {},
) {
  override get message(): string {
    return "Pass either url, or both repository and number.";
  }
}

export class PullRequestHostRequiredError extends Schema.TaggedError<PullRequestHostRequiredError>()(
  "PullRequestHostRequiredError",
  {},
) {
  override get message(): string {
    return "This thread's project has no recognised remote. Pass host or url.";
  }
}

export class PullRequestUrlUnavailableError extends Schema.TaggedError<PullRequestUrlUnavailableError>()(
  "PullRequestUrlUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread's project is on a host with no known pull request URL shape. Pass url.";
  }
}

export class PullRequestThreadRequiredError extends Schema.TaggedError<PullRequestThreadRequiredError>()(
  "PullRequestThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a GOAT thread.";
  }
}

export class PullRequestThreadNotFoundError extends Schema.TaggedError<PullRequestThreadNotFoundError>()(
  "PullRequestThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestLinkFailedError extends Schema.TaggedError<PullRequestLinkFailedError>()(
  "PullRequestLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the pull request.";
  }
}

export class PullRequestUnlinkFailedError extends Schema.TaggedError<PullRequestUnlinkFailedError>()(
  "PullRequestUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the pull request.";
  }
}

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestNotOpenError extends Schema.TaggedError<PullRequestNotOpenError>()(
  "PullRequestNotOpenError",
  { state: Schema.String },
) {
  override get message(): string {
    return `The pull request is ${this.state}, so there is nothing to watch.`;
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";
  }
}

export class PullRequestListFailedError extends Schema.TaggedError<PullRequestListFailedError>()(
  "PullRequestListFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the pull request.";
  }
}

export class PullRequestProjectNotFoundError extends Schema.TaggedError<PullRequestProjectNotFoundError>()(
  "PullRequestProjectNotFoundError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `No project in this environment is a checkout of ${this.repository}, so its pull requests cannot be read here. Add one with goat_project_create.`;
  }
}

export class PullRequestRepositoryAmbiguousError extends Schema.TaggedError<PullRequestRepositoryAmbiguousError>()(
  "PullRequestRepositoryAmbiguousError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `${this.repository} names more than one repository checked out here. Pass url, or repository as its full path.`;
  }
}

export class PullRequestGuideFailedError extends Schema.TaggedError<PullRequestGuideFailedError>()(
  "PullRequestGuideFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The host refused or failed a fresh read; detail is its own explanation. */
export class PullRequestReadFailedError extends Schema.TaggedError<PullRequestReadFailedError>()(
  "PullRequestReadFailedError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The answer cannot fit the read budget; detail says how to ask for less. */
export class PullRequestReadTooLargeError extends Schema.TaggedError<PullRequestReadTooLargeError>()(
  "PullRequestReadTooLargeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const PullRequestToolError = Schema.Union([
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUrlUnavailableError,
  PullRequestThreadRequiredError,
  PullRequestThreadNotFoundError,
  PullRequestLinkFailedError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestWatchFailedError,
  PullRequestNotOpenError,
  PullRequestWatchFromSubagentError,
  PullRequestProjectNotFoundError,
  PullRequestRepositoryAmbiguousError,
  PullRequestGuideFailedError,
  PullRequestReadFailedError,
  PullRequestReadTooLargeError,
]);
export type PullRequestToolError = typeof PullRequestToolError.Type;

const PullRequestIdentity = {
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.String,
};

export const LinkPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  alreadyLinked: Schema.Boolean,
  next: Schema.optional(Schema.String),
});
export type LinkPullRequestResult = typeof LinkPullRequestResult.Type;

export const UnlinkPullRequestResult = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  wasLinked: Schema.Boolean,
});
export type UnlinkPullRequestResult = typeof UnlinkPullRequestResult.Type;

export const WatchPullRequestResult = Schema.Struct({
  ...PullRequestIdentity,
  watching: Schema.Boolean,
  wasWatching: Schema.Boolean,
});
export type WatchPullRequestResult = typeof WatchPullRequestResult.Type;

export const ThreadPullRequestEntry = Schema.Struct({
  ...PullRequestIdentity,
  source: ThreadPullRequestLinkSource,
  watching: Schema.Boolean,
  state: Schema.NullOr(PullRequestState),
  title: Schema.NullOr(Schema.String),
  headBranch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  isDraft: Schema.NullOr(Schema.Boolean),
  stack: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** 1-based layer from the bottom; siblings share a layer. */
      position: Schema.Int,
      size: Schema.Int,
    }),
  ),
});
export type ThreadPullRequestEntry = typeof ThreadPullRequestEntry.Type;

export const ListThreadPullRequestsResult = Schema.Struct({
  pullRequests: Schema.Array(ThreadPullRequestEntry),
  chains: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["native", "derived"]),
      /** Bottom to top; each pull request comes before the ones built on it. */
      numbers: Schema.Array(Schema.Int),
    }),
  ),
});
export type ListThreadPullRequestsResult = typeof ListThreadPullRequestsResult.Type;

const LinkPullRequestTool = Tool.make(agentSurfaceRegistry["pull_request.link"].name, {
  description: agentSurfaceRegistry["pull_request.link"].description,
  parameters: PullRequestTargetInput,
  success: LinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.link"]));

const UnlinkPullRequestTool = Tool.make(agentSurfaceRegistry["pull_request.unlink"].name, {
  description: agentSurfaceRegistry["pull_request.unlink"].description,
  parameters: PullRequestTargetInput,
  success: UnlinkPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.unlink"]));

const ListThreadPullRequestsTool = Tool.make(agentSurfaceRegistry["pull_request.list"].name, {
  description: agentSurfaceRegistry["pull_request.list"].description,
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId.annotate({ description: "Thread. Default: this thread." })),
  }),
  success: ListThreadPullRequestsResult,
  failure: PullRequestToolError,
  dependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.list"]));

const WatchPullRequestTool = Tool.make(agentSurfaceRegistry["pull_request.watch"].name, {
  description: agentSurfaceRegistry["pull_request.watch"].description,
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.watch"]))
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const UnwatchPullRequestTool = Tool.make(agentSurfaceRegistry["pull_request.unwatch"].name, {
  description: agentSurfaceRegistry["pull_request.unwatch"].description,
  parameters: PullRequestTargetInput,
  success: WatchPullRequestResult,
  failure: PullRequestToolError,
  dependencies,
})
  .annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.unwatch"]))
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents);

const GuideTarget = Schema.Struct({
  url: PullRequestTargetInput.fields.url,
  repository: PullRequestTargetInput.fields.repository,
  number: PullRequestTargetInput.fields.number,
  host: PullRequestTargetInput.fields.host,
});

const GuideOutcome = Schema.Struct({
  ...PullRequestIdentity,
  outcome: Schema.Literals(["started", "running", "failed"]).annotate({
    description: "started: a run began. running: joined a run for this head. failed: see detail.",
  }),
  detail: Schema.NullOr(Schema.String),
});

export const WritePullRequestGuidesResult = Schema.Struct({
  guides: Schema.Array(GuideOutcome),
});
export type WritePullRequestGuidesResult = typeof WritePullRequestGuidesResult.Type;

export const ReadPullRequestGuideResult = Schema.Struct({
  ...PullRequestIdentity,
  guide: Schema.NullOr(PullRequestReviewGuide),
  run: Schema.NullOr(PullRequestReviewGuideRun),
  currentHeadSha: Schema.NullOr(Schema.String),
  stale: Schema.Boolean.annotate({
    description: "True when the PR head moved after the guide was written.",
  }),
});
export type ReadPullRequestGuideResult = typeof ReadPullRequestGuideResult.Type;

const WritePullRequestGuidesTool = Tool.make(
  agentSurfaceRegistry["pull_request_guide.update"].name,
  {
    description: agentSurfaceRegistry["pull_request_guide.update"].description,
    parameters: withClientRequestId(
      Schema.Struct({
        pullRequests: Schema.Array(GuideTarget).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(20),
        ),
      }),
    ),
    success: WritePullRequestGuidesResult,
    failure: PullRequestToolError,
    dependencies: guideDependencies,
  },
).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request_guide.update"]));

const ReadPullRequestGuideTool = Tool.make(agentSurfaceRegistry["pull_request_guide.read"].name, {
  description: agentSurfaceRegistry["pull_request_guide.read"].description,
  parameters: GuideTarget,
  success: ReadPullRequestGuideResult,
  failure: PullRequestToolError,
  dependencies: guideDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request_guide.read"]));

const readDependencies = [...dependencies, PullRequestService.PullRequestService];

const ReadPullRequestTool = Tool.make(agentSurfaceRegistry["pull_request.read"].name, {
  description: agentSurfaceRegistry["pull_request.read"].description,
  parameters: GuideTarget,
  success: Schema.Struct({ ...PullRequestIdentity, pullRequest: PullRequestDetail }),
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.read"]));

const PullRequestChecksTool = Tool.make(agentSurfaceRegistry["pull_request.checks"].name, {
  description: agentSurfaceRegistry["pull_request.checks"].description,
  parameters: GuideTarget,
  success: Schema.Struct({ ...PullRequestIdentity, checks: Schema.NullOr(PullRequestChecks) }),
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.checks"]));

const Omitted = Schema.Int.annotate({
  description: "Items left out to keep the response within its byte budget.",
});

const PullRequestActivityTool = Tool.make(agentSurfaceRegistry["pull_request.activity"].name, {
  description: agentSurfaceRegistry["pull_request.activity"].description,
  parameters: GuideTarget,
  success: Schema.Struct({
    ...PullRequestIdentity,
    activity: PullRequestActivity,
    commentsOmitted: Omitted,
    reviewThreadsOmitted: Omitted,
    commitsOmitted: Omitted,
    reviewersOmitted: Omitted,
    reactionsOmitted: Omitted,
  }),
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.activity"]));

const PullRequestReviewThreadTool = Tool.make(
  agentSurfaceRegistry["pull_request.review_thread"].name,
  {
    description: agentSurfaceRegistry["pull_request.review_thread"].description,
    parameters: Schema.Struct({
      ...GuideTarget.fields,
      threadId: TrimmedNonEmptyString,
      cursor: TrimmedNonEmptyString,
    }),
    success: Schema.Struct({
      ...PullRequestIdentity,
      comments: Schema.Array(PullRequestThreadComment),
      nextCursor: Schema.NullOr(Schema.String),
      commentsOmitted: Omitted,
    }),
    failure: PullRequestToolError,
    dependencies: readDependencies,
  },
).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.review_thread"]));

const PullRequestFileTool = Tool.make(agentSurfaceRegistry["pull_request.file"].name, {
  description: agentSurfaceRegistry["pull_request.file"].description,
  parameters: Schema.Struct({
    ...GuideTarget.fields,
    commit: Schema.optional(TrimmedNonEmptyString),
    changeType: PullRequestDiffFileContentsInput.fields.changeType,
    oldPath: TrimmedNonEmptyString,
    newPath: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({
    ...PullRequestIdentity,
    oldContents: Schema.String,
    newContents: Schema.String,
    oldTruncated: Schema.Boolean,
    newTruncated: Schema.Boolean,
  }),
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.file"]));

const PullRequestSearchTool = Tool.make(agentSurfaceRegistry["pull_request.search"].name, {
  description: agentSurfaceRegistry["pull_request.search"].description,
  parameters: Schema.Struct({
    state: PullRequestListInput.fields.state,
    involvement: PullRequestListInput.fields.involvement,
    filters: PullRequestListInput.fields.filters,
    projectId: PullRequestListInput.fields.projectId,
    query: PullRequestListInput.fields.query,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    cursors: PullRequestListInput.fields.cursors,
  }),
  success: Schema.Struct({
    entries: PullRequestListResult.fields.entries,
    rowsClipped: Schema.Boolean.annotate({
      description: "Some row text was cut to 1 KiB or a row list to 20 items.",
    }),
    errors: PullRequestListResult.fields.errors,
    truncated: PullRequestListResult.fields.truncated,
    nextCursors: PullRequestListResult.fields.nextCursors,
  }),
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.search"]));

const PullRequestStatsTool = Tool.make(agentSurfaceRegistry["pull_request.stats"].name, {
  description: agentSurfaceRegistry["pull_request.stats"].description,
  parameters: Schema.Struct({
    pullRequests: Schema.Array(GuideTarget).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
  }),
  success: PullRequestListStatsResult,
  failure: PullRequestToolError,
  dependencies: readDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.stats"]));

const PullRequestFilterOptionsTool = Tool.make(
  agentSurfaceRegistry["pull_request.filter_options"].name,
  {
    description: agentSurfaceRegistry["pull_request.filter_options"].description,
    parameters: Schema.Struct({
      kind: PullRequestFilterOptionsInput.fields.kind,
      projectId: PullRequestFilterOptionsInput.fields.projectId,
      query: PullRequestFilterOptionsInput.fields.query,
    }),
    success: PullRequestFilterOptions,
    failure: PullRequestToolError,
    dependencies: readDependencies,
  },
).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["pull_request.filter_options"]));

export const PullRequestsToolkit = Toolkit.make(
  LinkPullRequestTool,
  UnlinkPullRequestTool,
  ListThreadPullRequestsTool,
  WatchPullRequestTool,
  UnwatchPullRequestTool,
  WritePullRequestGuidesTool,
  ReadPullRequestGuideTool,
  ReadPullRequestTool,
  PullRequestChecksTool,
  PullRequestActivityTool,
  PullRequestReviewThreadTool,
  PullRequestFileTool,
  PullRequestSearchTool,
  PullRequestStatsTool,
  PullRequestFilterOptionsTool,
);
