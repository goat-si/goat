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
import {
  isFinalPullRequestSnapshot,
  isPullRequestSyncUnsettled,
} from "../orchestration-v2/pullRequestSyncFinal.ts";
import { pullRequestsFromLinks } from "./channelWorkerObservation.ts";

/** Where a work row's pull requests come from, and whether anything still refreshes their state. */
export interface PullRequestSource {
  readonly pullRequests: ReadonlyArray<ChannelTaskPullRequest>;
  readonly refreshed: boolean;
  /** Pull requests (repository#number) the refresher no longer reads even on a refreshed thread. */
  readonly final?: ReadonlySet<string>;
}
export interface ThreadPullRequestColumns {
  readonly pull_requests_json: string | null;
  readonly pull_requests_deleted_at: string | null;
}

/**
 * A projection thread `p`'s links and what decides their refresh, its payload parsed once. A
 * payload that is not JSON yields text no decoder accepts, so it reads as unreadable, not missing.
 */
export const threadPullRequestColumns = (sql: SqlClient.SqlClient) =>
  sql`CASE WHEN p.thread_id IS NULL THEN NULL
      WHEN json_valid(p.payload_json)
        THEN json_extract(p.payload_json, '$.pullRequests', '$.settledAt', '$.settledOverride', '$.archivedAt')
      ELSE 'invalid' END AS pull_requests_json,
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
            snapshot: Schema.NullOr(
              Schema.Struct({
                state: PullRequestState,
                closedAt: Schema.optional(Schema.NullOr(Schema.String)),
                mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            ),
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

const pullRequestKey = (item: { readonly repository: string; readonly number: number }) =>
  item.repository + "#" + item.number;

/** A thread's pull requests; undefined without a projection row, "unreadable" when they cannot be read. */
export const threadPullRequestSource = (
  columns: ThreadPullRequestColumns,
  nowMs: number,
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
    final: new Set(
      (links ?? []).flatMap((link) =>
        isFinalPullRequestSnapshot(link.snapshot, nowMs) ? [pullRequestKey(link)] : [],
      ),
    ),
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
  // Merged and closed show from any source (a closed one can reopen, which only a refresh
  // shows); open shows only while something still reads the host.
  state !== undefined && (refreshed || state !== "open") ? { ...item, state } : item;

/**
 * Which duplicate of a pull request a row keeps, lowest first: a state from a thread that still
 * reads it (refreshed and not final, as the refresher judges both); a merged or closed state no
 * longer read; the stored copy's state; no state. A tie keeps the first source met.
 */
const precedence = (item: BotRowPullRequest, fromThread: boolean, refreshed: boolean) =>
  item.state === undefined ? 3 : !fromThread ? 2 : refreshed ? 0 : 1;

/**
 * One row's pull requests by repository and number, capped before encoding, since shipped clients
 * reject a longer list.
 */
export const botRowPullRequests = (
  threads: ReadonlyArray<PullRequestSource>,
  copy: PullRequestSource,
): { readonly pullRequests?: Array<BotRowPullRequest>; readonly pullRequestsOmitted?: number } => {
  const byKey = new Map<string, { readonly item: BotRowPullRequest; readonly rank: number }>();
  for (const [source, fromThread] of [
    ...threads.map((thread) => [thread, true] as const),
    [copy, false] as const,
  ])
    for (const pullRequest of source.pullRequests) {
      const key = pullRequestKey(pullRequest);
      const refreshed = source.refreshed && source.final?.has(key) !== true;
      const item = shown(pullRequest, refreshed);
      const rank = precedence(item, fromThread, refreshed);
      if (rank < (byKey.get(key)?.rank ?? Number.POSITIVE_INFINITY)) byKey.set(key, { item, rank });
    }
  const all = [...byKey.values()]
    .map(({ item }) => item)
    .toSorted(
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
