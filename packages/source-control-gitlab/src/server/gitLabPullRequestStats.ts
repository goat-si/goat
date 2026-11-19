import * as Effect from "effect/Effect";
import type { GitLabPullRequestCli } from "./GitLabPullRequestCli.ts";
import type { makeGitLabListReads } from "./gitLabListReads.ts";
import {
  decodeMergeRequestFileStatsJson,
  decodeMergeRequestStatsJson,
  MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
  MERGE_REQUEST_STATS_GRAPHQL_QUERY,
} from "./gitLabMergeRequestJson.ts";

export function makeGitLabPullRequestStats(graphqlRead: Parameters<typeof makeGitLabListReads>[0]) {
  const STAT_IIDS_PER_REQUEST = 100;
  const mergeRequestStats = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly numbers: ReadonlyArray<number>;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "listMergeRequestStats",
      query: MERGE_REQUEST_STATS_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iids: input.numbers.map(String) },
      decode: decodeMergeRequestStatsJson,
    });

  const STAT_REQUEST_CONCURRENCY = 4;

  const listMergeRequestStats: GitLabPullRequestCli["Service"]["listMergeRequestStats"] = (
    input,
  ) => {
    const byRepository = new Map<string, Set<number>>();
    for (const { repository, number } of input.changeRequests) {
      const numbers = byRepository.get(repository) ?? new Set<number>();
      numbers.add(number);
      byRepository.set(repository, numbers);
    }
    const reads: Array<{ readonly repository: string; readonly numbers: ReadonlyArray<number> }> =
      [];
    for (const [repository, numberSet] of byRepository) {
      const numbers = [...numberSet];
      for (let start = 0; start < numbers.length; start += STAT_IIDS_PER_REQUEST) {
        reads.push({ repository, numbers: numbers.slice(start, start + STAT_IIDS_PER_REQUEST) });
      }
    }
    return Effect.forEach(
      reads,
      (read) =>
        mergeRequestStats({ cwd: input.cwd, host: input.host, ...read }).pipe(
          Effect.map((stats) =>
            read.numbers.flatMap((number) => {
              const stat = stats.get(number);
              return stat === undefined ? [] : [{ repository: read.repository, number, ...stat }];
            }),
          ),
          // One read GitLab could not answer costs its own rows their counts, not every other
          // read's on the same page. An unusable CLI or account still reaches the caller.
          Effect.catchIf(
            (cause) =>
              cause._tag !== "GitLabCliUnavailableError" &&
              cause._tag !== "GitLabCliAuthenticationError" &&
              cause._tag !== "GitLabCliRateLimitError",
            (cause) =>
              Effect.logWarning("GitLab merge request line count read failed", {
                repository: read.repository,
                reason: cause._tag,
              }).pipe(Effect.as([])),
          ),
        ),
      { concurrency: STAT_REQUEST_CONCURRENCY },
    ).pipe(Effect.map((results) => results.flat()));
  };

  const getMergeRequestFileStats: GitLabPullRequestCli["Service"]["getMergeRequestFileStats"] =
    Effect.fn("GitLabPullRequestCli.getMergeRequestFileStats")((input) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getMergeRequestFileStats",
        query: MERGE_REQUEST_FILE_STATS_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, iid: String(input.number) },
        decode: decodeMergeRequestFileStatsJson,
      }),
    );

  return { listMergeRequestStats, getMergeRequestFileStats };
}
