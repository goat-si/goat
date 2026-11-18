import * as Schema from "effect/Schema";
import type { PullRequestMergeMethod } from "@goat/contracts";

export function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/** Bound decimal length to prevent exponential notation in request paths. */
export function diffCursorPage(cursor: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(cursor) ? Number(cursor) : null;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

export const decodeRevisionRefs = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      sha: Schema.optional(Schema.String),
      parents: Schema.optional(Schema.Array(Schema.Struct({ sha: Schema.String }))),
      base: Schema.optional(Schema.Struct({ sha: Schema.String })),
      head: Schema.optional(Schema.Struct({ sha: Schema.String })),
    }),
  ),
);

/** Where a pull request's head forked off its base, the commit its patch is computed from. */
export const decodeMergeBase = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Schema.String }) }),
  ),
);

// GitHub has no fast-forward-only merge; the service refuses methods a host does not advertise.
export const GRAPHQL_MERGE_METHODS: Partial<
  Record<PullRequestMergeMethod, "MERGE" | "SQUASH" | "REBASE">
> = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" };
