import { LIST_ITEM_GRAPHQL_FIELDS } from "./gitLabMergeRequestJson.ts";
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

function listableLabels(filters: PullRequestListFilters) {
  const listable = (names: ReadonlyArray<string>) =>
    names.filter((name) => !name.includes(",") && !/^(?:none|any)$/iu.test(name.trim()));
  return {
    required: listable(
      (filters.labels ?? []).flatMap((group) => (group.length === 1 ? group : [])),
    ),
    excluded: listable(filters.excludedLabels ?? []),
  };
}

export function filterParams(input: {
  readonly filters?: PullRequestListFilters | undefined;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  const filters = input.filters;
  if (filters === undefined) return [];
  const { required, excluded } = listableLabels(filters);
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
    ...(filters.review === "approved"
      ? [["approved_by_usernames[]", "Any"] as const]
      : filters.review === "none"
        ? [["approved_by_ids[]", "None"] as const]
        : []),
  ];
}

/**
 * The GraphQL list takes the REST filters and narrows two review filters exactly: `approvedBy`
 * Any for approved, and reviewer states for changes requested. Only arguments in use are
 * declared, since GraphQL rejects a declared variable the query never reads.
 */
export function graphqlListQuery(input: {
  readonly repository: string;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly filters?: PullRequestListFilters | undefined;
  readonly first: number;
  readonly after: string | undefined;
}): { readonly query: string; readonly variables: Record<string, unknown> } {
  const filters = input.filters ?? {};
  const { required, excluded } = listableLabels(filters);
  const search = input.query?.trim() ?? "";
  const author =
    input.involvement === "authored"
      ? input.viewer
      : filters.author === undefined
        ? undefined
        : resolvePullRequestAuthorFilter(filters.author, input.viewer);
  const args: ReadonlyArray<readonly [name: string, type: string, value: unknown]> = [
    ["state", "MergeRequestState", stateParam(input.state)],
    ...(author === undefined ? [] : [["authorUsername", "String", author] as const]),
    ...(input.involvement === "reviewing"
      ? [["reviewerUsername", "String", input.viewer] as const]
      : []),
    ...(search.length === 0 ? [] : [["search", "String", search] as const]),
    ...(required.length === 0 ? [] : [["labels", "[String!]", required] as const]),
    ...(filters.draft === undefined
      ? []
      : [["draft", "Boolean", filters.draft === "only"] as const]),
    ...(filters.review === "approved" ? [["approvedBy", "[String!]", ["Any"]] as const] : []),
    // Beside `reviewerUsername`, GitLab matches review states on that reviewer alone.
    ...(filters.review === "changes-requested" && input.involvement !== "reviewing"
      ? [["reviewStates", "[MergeRequestReviewState!]", ["REQUESTED_CHANGES"]] as const]
      : []),
  ];
  const declarations = [
    "$fullPath: ID!",
    "$first: Int!",
    "$after: String",
    ...args.map(([name, type]) => `$${name}: ${type}`),
    ...(excluded.length === 0 ? [] : ["$notLabels: [String!]"]),
  ];
  const usages = [
    "sort: UPDATED_DESC",
    "first: $first",
    "after: $after",
    ...args.map(([name]) => `${name}: $${name}`),
    ...(excluded.length === 0 ? [] : ["not: { labels: $notLabels }"]),
  ];
  return {
    query: `query(${declarations.join(", ")}) {
  metadata { enterprise }
  project(fullPath: $fullPath) {
    mergeRequests(${usages.join(", ")}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_ITEM_GRAPHQL_FIELDS} }
    }
  }
}`,
    variables: {
      fullPath: input.repository.trim(),
      first: input.first,
      after: input.after ?? null,
      ...Object.fromEntries(args.map(([name, , value]) => [name, value])),
      ...(excluded.length === 0 ? {} : { notLabels: excluded }),
    },
  };
}

export function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

export function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

export const RESUME_AFTER_PATTERN = /^[\w.:~+-]{1,128}$/u;
