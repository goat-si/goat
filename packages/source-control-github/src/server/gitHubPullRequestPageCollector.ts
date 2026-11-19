import * as Effect from "effect/Effect";
import type { GitHubPullRequestApiError } from "./GitHubPullRequestApi.ts";
import type { GitHubPullRequestListPage } from "./gitHubPullRequestListStates.ts";

/**
 * Pages of up to a hundred until `rows` have arrived or GitHub has no more. Each page asks
 * for only the rows still missing, so the last one does not overshoot.
 */
export const collectGitHubPages = Effect.fn("GitHubPullRequestApi.collect")(function* (
  rows: number,
  page: (
    after: string | null,
    rows: number,
  ) => Effect.Effect<GitHubPullRequestListPage, GitHubPullRequestApiError>,
) {
  const countRows = (pages: ReadonlyArray<GitHubPullRequestListPage>) =>
    pages.reduce((total, read) => total + read.rawCount, 0);
  const pages: GitHubPullRequestListPage[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let truncated = false;
  while (true) {
    const read: GitHubPullRequestListPage = yield* page(after, rows - countRows(pages));
    pages.push(read);
    const next = read.endCursor;
    if (next === null) break;
    // `truncated` also covers a cursor GitHub repeated before `rows` arrived.
    if (seen.has(next) || countRows(pages) >= rows) {
      truncated = true;
      break;
    }
    seen.add(next);
    after = next;
  }
  return {
    items: pages.flatMap((read) => read.items),
    rawCount: countRows(pages),
    truncated,
  };
});
