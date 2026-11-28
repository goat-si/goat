import * as Effect from "effect/Effect";

export const start = (input: {
  readonly limit: number;
  readonly cursor?: { readonly resumeAfter?: string | undefined } | undefined;
  readonly state: string;
  readonly query?: string | undefined;
  readonly involvement?: string | undefined;
}) =>
  Effect.annotateCurrentSpan({
    "gitcafe.list.limit": input.limit,
    "gitcafe.list.resumed": input.cursor?.resumeAfter !== undefined,
    "gitcafe.list.state": input.state,
    "gitcafe.list.query": Boolean(input.query?.trim()),
    "gitcafe.list.involvement": input.involvement ?? "none",
    "gitcafe.list.author_discovery_pages": 0,
  });

export const outcome = (pages: number, rows: number, truncated: boolean) =>
  Effect.annotateCurrentSpan({
    "gitcafe.list.pages": pages,
    "gitcafe.list.rows": rows,
    "gitcafe.list.truncated": truncated,
  });

export const filters = (narrowed: boolean, discovery: boolean) =>
  Effect.annotateCurrentSpan({
    "gitcafe.list.actor_narrowed": narrowed,
    "gitcafe.list.author_discovery": discovery,
  });

export const page = (requested: number, returned: number) =>
  Effect.annotateCurrentSpan({
    "gitcafe.page.rows_requested": requested,
    "gitcafe.page.rows_returned": returned,
  });

export const query = (
  input: {
    readonly state: string;
    readonly query?: string | undefined;
    readonly involvement?: string | undefined;
  },
  filters: ReadonlyArray<readonly [string, string]>,
  actorId: string | undefined,
  rows: number,
  after: string | null,
) => {
  const query = new URLSearchParams({ limit: String(rows), sort: "newest" });
  if (input.state !== "all") query.set("state", input.state);
  if (input.query?.trim()) query.set("q", input.query.trim());
  for (const [key, value] of filters) query.set(key, value);
  if (actorId !== undefined)
    query.set(
      input.involvement === "reviewing" ? "reviewers" : "authors",
      JSON.stringify([actorId]),
    );
  if (after !== null) query.set("after", after);
  return query;
};

export const isNew = (
  pull: { readonly createdAt: string; readonly number: number },
  resume: { readonly created: number; readonly number: number } | null,
) => {
  if (resume === null) return true;
  const created = Date.parse(pull.createdAt);
  return created < resume.created || (created === resume.created && pull.number < resume.number);
};
