import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import type { ProviderFilterOptionPage } from "@goat/source-control-core/server/PullRequestProvider";

const FILTER_OPTIONS_LIMIT = 100;

/**
 * Exact matches first, then names that begin with the query, then the rest, so a short query
 * still puts the obvious answer at the top of a long list.
 */
export function rankFilterOptions<A>(
  pages: ReadonlyArray<ProviderFilterOptionPage<A>>,
  input: {
    readonly query: string | undefined;
    readonly keyOf: (item: A) => string;
    readonly textsOf: (item: A) => ReadonlyArray<string | null>;
    /** Ties keep the hosts' order instead of sorting by key. */
    readonly hostOrder?: boolean;
  },
): { readonly items: ReadonlyArray<A>; readonly truncated: boolean } {
  const query = input.query?.trim().toLowerCase() ?? "";
  const unique = new Map<string, A>();
  for (const page of pages) {
    for (const item of page.items) {
      const key = input.keyOf(item).toLowerCase();
      if (!unique.has(key)) unique.set(key, item);
    }
  }
  const rank = (item: A) => {
    const texts = input.textsOf(item).flatMap((text) => (text ? [text.toLowerCase()] : []));
    if (query.length === 0) return 0;
    if (texts.includes(query)) return 0;
    if (texts.some((text) => text.startsWith(query))) return 1;
    if (texts.some((text) => text.includes(query))) return 2;
    return null;
  };
  const ranked = [...unique.values()]
    .flatMap((item) => {
      const score = rank(item);
      return score === null ? [] : [{ item, score, key: input.keyOf(item) }];
    })
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        (input.hostOrder === true
          ? 0
          : left.key.localeCompare(right.key, undefined, { sensitivity: "base" })),
    );
  return {
    items: ranked.slice(0, FILTER_OPTIONS_LIMIT).map(({ item }) => item),
    truncated: ranked.length > FILTER_OPTIONS_LIMIT || pages.some((page) => page.truncated),
  };
}

export const gatherReferencePages = Effect.fn("PullRequestService.gatherReferencePages")(
  <Project, Item>(
    projects: ReadonlyArray<Project>,
    read: (
      project: Project,
    ) => Effect.Effect<ProviderFilterOptionPage<Item>, PullRequestProviderError> | undefined,
    concurrency: number,
  ) =>
    Effect.forEach(
      projects,
      (project) => {
        const page = read(project);
        return page === undefined ? Effect.succeed(null) : Effect.result(page);
      },
      { concurrency },
    ).pipe(
      Effect.map((answers) => {
        const pages: Array<ProviderFilterOptionPage<Item>> = [];
        let failure: PullRequestProviderError | undefined;
        for (const answer of answers) {
          if (answer === null) continue;
          if (Result.isSuccess(answer)) pages.push(answer.success);
          else failure ??= answer.failure;
        }
        return { pages, failure };
      }),
    ),
);
