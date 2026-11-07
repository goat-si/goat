import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type {
  PullRequestListState,
  PullRequestInvolvement,
  PullRequestListFilters,
} from "@goat/contracts";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import type {
  GitLabPullRequestCliError,
  GitLabMergeRequestListBatch,
} from "./GitLabPullRequestCli.ts";
import { graphqlListQuery, RESUME_AFTER_PATTERN } from "./gitLabQuery.ts";
import {
  decodeListStatesJson,
  decodeMergeRequestGraphqlListJson,
  LIST_STATES_GRAPHQL_QUERY,
  type GitLabMergeRequestListItem,
  type GitLabMergeRequestListState,
} from "./gitLabMergeRequestJson.ts";
export function makeGitLabListReads(
  graphqlRead: <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) => Effect.Effect<A, GitLabCli.GitLabCliError | GitLabMergeRequestReadError>,
) {
  const MAX_PAGE_SIZE = 100;
  const graphqlListPage = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly state: PullRequestListState;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly filters?: PullRequestListFilters | undefined;
    readonly after: string | undefined;
    readonly collected: ReadonlyArray<GitLabMergeRequestListItem>;
    readonly states: ReadonlyMap<number, GitLabMergeRequestListState>;
    readonly cursorAdvance: number;
    /** Bounds the walk when whole pages fail to decode. */
    readonly reads: number;
  }): Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError> =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "listMergeRequests",
      ...graphqlListQuery({
        ...input,
        first: Math.max(1, Math.min(input.limit - input.collected.length, MAX_PAGE_SIZE)),
      }),
      decode: decodeMergeRequestGraphqlListJson,
    }).pipe(
      Effect.flatMap((page) => {
        const collected = [...input.collected, ...page.items];
        const states = new Map([...input.states, ...page.states]);
        const cursorAdvance = input.cursorAdvance + page.rawCount;
        const resumeAfter =
          page.endCursor !== null && RESUME_AFTER_PATTERN.test(page.endCursor)
            ? page.endCursor
            : undefined;
        if (
          page.hasNextPage &&
          resumeAfter !== undefined &&
          collected.length < input.limit &&
          input.reads > 1
        ) {
          return graphqlListPage({
            ...input,
            after: resumeAfter,
            collected,
            states,
            cursorAdvance,
            reads: input.reads - 1,
          });
        }
        return Effect.succeed({
          items: collected,
          truncated: page.hasNextPage,
          cursorAdvance,
          ...(resumeAfter === undefined ? {} : { resumeAfter }),
          listStates: states,
        });
      }),
    );

  const listStatesOf = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }): Effect.Effect<ReadonlyMap<number, GitLabMergeRequestListState>, GitLabPullRequestCliError> =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getListStates",
      query: LIST_STATES_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeListStatesJson,
    });

  return { graphqlListPage, listStatesOf };
}
