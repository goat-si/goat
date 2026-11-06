import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";
import type { PullRequestChecksState, PullRequestReviewDecision } from "@goat/contracts";
import {
  trimmed,
  toActor,
  toState,
  toMergeability,
  toLabels,
  toPipelineStatus,
  type GitLabMergeRequestListItem,
} from "./gitLabMergeRequestJson.ts";
type DecodeFailure = Cause.Cause<Schema.SchemaError>;

/** What a listed merge request needs beyond REST: its approval, reviewer and pipeline state. */
const LIST_STATE_GRAPHQL_FIELDS = `iid approved approvedBy(first: 1) { nodes { username } }
  reviewers(first: 20) { nodes { username mergeRequestInteraction { reviewState } } }
  headPipeline { status }`;

export const LIST_STATES_GRAPHQL_QUERY = `query($fullPath: ID!, $iids: [String!]) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes { ${LIST_STATE_GRAPHQL_FIELDS} }
    }
  }
}`;

const RawMetadataSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ enterprise: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
);

const RawListStateFields = {
  iid: Schema.String,
  approved: Schema.optional(Schema.NullOr(Schema.Boolean)),
  approvedBy: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
      }),
    ),
  ),
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  username: Schema.optional(Schema.NullOr(Schema.String)),
                  mergeRequestInteraction: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({ reviewState: Schema.optional(Schema.NullOr(Schema.String)) }),
                    ),
                  ),
                }),
              ),
            ),
          ),
        ),
      }),
    ),
  ),
  headPipeline: Schema.optional(
    Schema.NullOr(Schema.Struct({ status: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
};

const RawListStateNodeSchema = Schema.Struct(RawListStateFields);

const RawListStatesSchema = Schema.Struct({
  data: Schema.Struct({
    metadata: RawMetadataSchema,
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequests: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ nodes: Schema.Array(Schema.NullOr(RawListStateNodeSchema)) }),
          ),
        ),
      }),
    ),
  }),
});

const decodeListStates = decodeJsonResult(RawListStatesSchema);

export interface GitLabMergeRequestListState {
  /** Absent when the approval state can't be judged. */
  readonly reviewDecision?: PullRequestReviewDecision | null;
  readonly checksState: PullRequestChecksState | null;
}

function toChecksState(pipelineStatus: string | null | undefined): PullRequestChecksState | null {
  if (pipelineStatus == null) return null;
  switch (toPipelineStatus(pipelineStatus)) {
    case "success":
      return "passing";
    case "failure":
    case "cancelled":
      return "failing";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

/**
 * Only Enterprise Edition holds `approved` to the project's approval rules, so an unapproved
 * merge request there still needs review even when someone, such as a bot, approved it.
 * Community Edition reports `approved` once anyone approves and requires no review.
 * A reviewer asking for changes outranks both, as it does on GitHub.
 */
function toListState(
  node: typeof RawListStateNodeSchema.Type,
  enterprise: boolean | null | undefined,
): GitLabMergeRequestListState {
  const checksState = toChecksState(node.headPipeline?.status);
  if (
    node.reviewers?.nodes?.some(
      (reviewer) => reviewer?.mergeRequestInteraction?.reviewState === "REQUESTED_CHANGES",
    )
  ) {
    return { reviewDecision: "changes-requested", checksState };
  }
  const approvals = node.approvedBy?.nodes?.length;
  if (
    node.approved == null ||
    approvals === undefined ||
    (node.approved === false && approvals === 0 && enterprise == null)
  ) {
    return { checksState };
  }
  return {
    reviewDecision:
      node.approved === false && (enterprise || approvals > 0)
        ? "review-required"
        : approvals > 0
          ? "approved"
          : null,
    checksState,
  };
}

export function decodeListStatesJson(
  raw: string,
): Result.Result<ReadonlyMap<number, GitLabMergeRequestListState>, DecodeFailure> {
  const decoded = decodeListStates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const enterprise = decoded.success.data.metadata?.enterprise;
  const states = new Map<number, GitLabMergeRequestListState>();
  for (const node of decoded.success.data.project?.mergeRequests?.nodes ?? []) {
    const number = Number(node?.iid);
    if (node === null || !Number.isSafeInteger(number)) continue;
    states.set(number, toListState(node, enterprise));
  }
  return Result.succeed(states);
}

/** The fields a listed merge request needs, so one GraphQL read stands in for REST and states. */
export const LIST_ITEM_GRAPHQL_FIELDS = `${LIST_STATE_GRAPHQL_FIELDS}
  title webUrl state draft createdAt updatedAt mergedAt sourceBranch targetBranch
  conflicts mergeStatusEnum author { username name avatarUrl } labels(first: 100) { nodes { title } }`;

const RawGraphqlListNodeSchema = Schema.Struct({
  ...RawListStateFields,
  title: Schema.String,
  webUrl: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  conflicts: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeStatusEnum: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        username: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Struct({ title: Schema.String })))),
        ),
      }),
    ),
  ),
});

// GitLab answers `project: null` for a project the reader cannot see, which REST reports as an error.
const RawGraphqlListSchema = Schema.Struct({
  data: Schema.Struct({
    metadata: RawMetadataSchema,
    project: Schema.Struct({
      mergeRequests: Schema.Struct({
        pageInfo: Schema.Struct({
          hasNextPage: Schema.Boolean,
          endCursor: Schema.optional(Schema.NullOr(Schema.String)),
        }),
        nodes: Schema.Array(Schema.Unknown),
      }),
    }),
  }),
});

const decodeGraphqlList = decodeJsonResult(RawGraphqlListSchema);
const decodeGraphqlListNode = Schema.decodeUnknownExit(RawGraphqlListNodeSchema);

export interface GitLabMergeRequestGraphqlPage {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly states: ReadonlyMap<number, GitLabMergeRequestListState>;
  /** Count before decoding, so a page of rows that fail to decode still moves on. */
  readonly rawCount: number;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export function decodeMergeRequestGraphqlListJson(
  raw: string,
): Result.Result<GitLabMergeRequestGraphqlPage, DecodeFailure> {
  const decoded = decodeGraphqlList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const page = decoded.success.data.project.mergeRequests;
  const enterprise = decoded.success.data.metadata?.enterprise;
  const items: GitLabMergeRequestListItem[] = [];
  const states = new Map<number, GitLabMergeRequestListState>();
  for (const entry of page.nodes) {
    const exit = decodeGraphqlListNode(entry);
    if (!Exit.isSuccess(exit)) continue;
    const node = exit.value;
    const number = Number(node.iid);
    if (!Number.isSafeInteger(number)) continue;
    items.push({
      number,
      title: node.title,
      url: node.webUrl,
      author: toActor(
        node.author == null
          ? null
          : {
              username: node.author.username ?? "",
              name: node.author.name,
              avatar_url: node.author.avatarUrl,
            },
      ),
      headBranch: node.sourceBranch,
      baseBranch: node.targetBranch,
      state: toState({ state: node.state, merged_at: node.mergedAt }),
      isDraft: node.draft ?? false,
      mergeability: toMergeability({
        has_conflicts: node.conflicts,
        merge_status: node.mergeStatusEnum,
      }),
      additions: 0,
      deletions: 0,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      reviewRequestLogins: (node.reviewers?.nodes ?? []).flatMap((reviewer) => {
        const login = trimmed(reviewer?.username);
        return login === null ? [] : [login];
      }),
      labels: toLabels((node.labels?.nodes ?? []).flatMap((label) => (label ? [label.title] : []))),
    });
    states.set(number, toListState(node, enterprise));
  }
  return Result.succeed({
    items,
    states,
    rawCount: page.nodes.length,
    hasNextPage: page.pageInfo.hasNextPage,
    endCursor: trimmed(page.pageInfo.endCursor),
  });
}

export const SERVER_VERSION_GRAPHQL_QUERY = "{ metadata { version } }";

const decodeServerVersion = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      metadata: Schema.optional(
        Schema.NullOr(Schema.Struct({ version: Schema.optional(Schema.NullOr(Schema.String)) })),
      ),
    }),
  }),
);

/**
 * Whether the GraphQL merge request list takes every filter the REST list does: `search` came
 * last, in 17.9. An instance that hides its version keeps REST.
 */
export function decodeGraphqlListSupportJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeServerVersion(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const match = /^(\d+)\.(\d+)/u.exec(decoded.success.data.metadata?.version?.trim() ?? "");
  if (match === null) return Result.succeed(false);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Result.succeed(major > 17 || (major === 17 && minor >= 9));
}

/**
 * Line counts for merge requests of one project. The REST listing carries no line counts, and
 * reading each diff to count them would cost a request per row, so GraphQL's per-merge-request
 * summary is asked for in one read instead.
 */
