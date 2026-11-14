import {
  CHANNEL_BOT_ROW_PULL_REQUESTS,
  PositiveInt,
  PullRequestState,
  ThreadPullRequestLinkSource,
  TrimmedNonEmptyString,
  type BotRowPullRequest,
  type ChannelTask,
  type ChannelTaskPullRequest,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { isPullRequestSyncUnsettled } from "../orchestration-v2/pullRequestSyncFinal.ts";
import { pullRequestsFromLinks } from "./channelWorkerObservation.ts";

/** Where a work row's pull requests come from, and whether anything still refreshes their state. */
export interface PullRequestSource {
  readonly pullRequests: ReadonlyArray<ChannelTaskPullRequest>;
  readonly refreshed: boolean;
}
export interface ThreadPullRequestColumns {
  readonly pull_requests_json: string | null;
  readonly pull_requests_deleted_at: string | null;
}

/** A projection thread `p`'s links and what decides their refresh, its payload parsed once. */
export const threadPullRequestColumns = (sql: SqlClient.SqlClient) =>
  sql`json_extract(p.payload_json, '$.pullRequests', '$.settledAt', '$.settledOverride', '$.archivedAt') AS pull_requests_json,
    p.deleted_at AS pull_requests_deleted_at`;

// Only what a row shows; a link's snapshot and watch details are not decoded.
const decodeColumns = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            repository: TrimmedNonEmptyString,
            number: PositiveInt,
            url: TrimmedNonEmptyString,
            source: ThreadPullRequestLinkSource,
            snapshot: Schema.NullOr(Schema.Struct({ state: PullRequestState })),
            watch: Schema.optional(Schema.Unknown),
          }),
        ),
      ),
      Schema.NullOr(Schema.String),
      Schema.NullOr(Schema.String),
      Schema.NullOr(Schema.String),
    ]),
  ),
);

/** A thread's pull requests; undefined without a projection row, "unreadable" when they cannot be read. */
export const threadPullRequestSource = (
  columns: ThreadPullRequestColumns,
): PullRequestSource | "unreadable" | undefined => {
  if (columns.pull_requests_json === null) return undefined;
  const decoded = decodeColumns(columns.pull_requests_json);
  if (Option.isNone(decoded)) return "unreadable";
  const [links, settledAt, settledOverride, archivedAt] = decoded.value;
  return {
    pullRequests: pullRequestsFromLinks(links ?? []),
    // The refresher reads unsettled, unarchived, undeleted threads only.
    refreshed:
      columns.pull_requests_deleted_at === null &&
      archivedAt === null &&
      isPullRequestSyncUnsettled({ settledOverride, settledAt }),
  };
};

/** The copy the ledger keeps of the worker's links, refreshed only while the task runs or waits. */
export const observedPullRequestSource = (task: ChannelTask): PullRequestSource => ({
  pullRequests: task.observed?.pullRequests ?? [],
  refreshed: task.status === "running" || task.status === "waiting_input",
});

const RANK = { open: 0, none: 1, merged: 2, closed: 3 } as const;
const shown = (
  { url: _url, state, ...item }: ChannelTaskPullRequest,
  refreshed: boolean,
): BotRowPullRequest =>
  // A terminal state stays true; any other is shown only while something still reads the host.
  state !== undefined && (refreshed || state !== "open") ? { ...item, state } : item;

/**
 * One row's pull requests by repository and number: projection threads win over the copy, a
 * thread that still shows a state over one that does not. Capped before encoding, since shipped
 * clients reject a longer list.
 */
export const botRowPullRequests = (
  threads: ReadonlyArray<PullRequestSource>,
  copy: PullRequestSource,
): { readonly pullRequests?: Array<BotRowPullRequest>; readonly pullRequestsOmitted?: number } => {
  const byKey = new Map<string, BotRowPullRequest>();
  for (const source of threads)
    for (const pullRequest of source.pullRequests) {
      const key = pullRequest.repository + "#" + pullRequest.number;
      const item = shown(pullRequest, source.refreshed);
      const known = byKey.get(key);
      if (known === undefined || (known.state === undefined && item.state !== undefined))
        byKey.set(key, item);
    }
  for (const pullRequest of copy.pullRequests) {
    const key = pullRequest.repository + "#" + pullRequest.number;
    if (!byKey.has(key)) byKey.set(key, shown(pullRequest, copy.refreshed));
  }
  const all = [...byKey.values()].toSorted(
    (left, right) =>
      RANK[left.state ?? "none"] - RANK[right.state ?? "none"] ||
      right.number - left.number ||
      left.repository.localeCompare(right.repository),
  );
  if (all.length === 0) return {};
  const omitted = all.length - CHANNEL_BOT_ROW_PULL_REQUESTS;
  return {
    pullRequests: all.slice(0, CHANNEL_BOT_ROW_PULL_REQUESTS),
    ...(omitted > 0 ? { pullRequestsOmitted: omitted } : {}),
  };
};
