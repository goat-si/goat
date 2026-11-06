import {
  resolvePullRequestAuthorFilter,
  type PullRequestListState,
  type PullRequestInvolvement,
  type PullRequestListFilters,
} from "@goat/contracts";

export function stateParam(state: PullRequestListState): string {
  return state === "open" ? "opened" : state;
}

export function involvementParams(input: {
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "reviewing":
      return [["reviewer_username", input.viewer]];
    case "all":
      return [];
  }
}

/**
 * GitLab's `labels` asks for every label it names, so only groups of one go to it; a group of
 * alternatives is left for the service to narrow. A comma would split a name in two, and `None`
 * and `Any` mean "unlabeled" and "labeled" to GitLab rather than labels of those names.
 */
export function filterParams(input: {
  readonly filters?: PullRequestListFilters | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  const filters = input.filters;
  if (filters === undefined) return [];
  const listable = (names: ReadonlyArray<string>) =>
    names.filter((name) => !name.includes(",") && !/^(?:none|any)$/iu.test(name.trim()));
  const required = listable(
    (filters.labels ?? []).flatMap((group) => (group.length === 1 ? group : [])),
  );
  const excluded = listable(filters.excludedLabels ?? []);
  return [
    ...(required.length === 0 ? [] : [["labels", required.join(",")] as const]),
    ...(excluded.length === 0 ? [] : [["not[labels]", excluded.join(",")] as const]),
    ...(filters.author === undefined || input.involvement === "authored"
      ? []
      : [
          [
            "author_username",
            resolvePullRequestAuthorFilter(filters.author, input.viewer),
          ] as const,
        ]),
    ...(filters.draft === undefined
      ? []
      : [["wip", filters.draft === "only" ? "yes" : "no"] as const]),
  ];
}

export function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

export function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}
