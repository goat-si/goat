import * as Effect from "effect/Effect";
import type { GitHubPullRequestListPage } from "./gitHubPullRequestListStates.ts";

const MAX_COLLECTED_PAGES = 100;

/**
 * Pages of up to a hundred until `rows` have arrived or GitHub has no more. Each page asks
 * for only the rows still missing, so the last one does not overshoot.
 */
export const collectGitHubPages = Effect.fn("GitHubPullRequestApi.collect")(function* <Item, E>(
  rows: number,
  page: (after: string | null, rows: number) => Effect.Effect<GitHubPullRequestListPage<Item>, E>,
) {
  const countRows = (pages: ReadonlyArray<GitHubPullRequestListPage<Item>>) =>
    pages.reduce((total, read) => total + read.rawCount, 0);
  const pages: GitHubPullRequestListPage<Item>[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let truncated = false;
  while (true) {
    const read: GitHubPullRequestListPage<Item> = yield* page(after, rows - countRows(pages));
    pages.push(read);
    const next = read.endCursor;
    if (next === null) break;
    // `truncated` also covers a cursor GitHub repeated before `rows` arrived.
    if (
      read.rawCount === 0 ||
      pages.length >= MAX_COLLECTED_PAGES ||
      seen.has(next) ||
      countRows(pages) >= rows
    ) {
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
