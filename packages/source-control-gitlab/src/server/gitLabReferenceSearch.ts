import * as Effect from "effect/Effect";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabPullRequestCliError } from "./GitLabPullRequestCli.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import { projectPath } from "./gitLabInput.ts";
import { query } from "./gitLabQuery.ts";
import { decodeJsonResult } from "@goat/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PullRequestReferenceCandidate, PullRequestReferenceSigil } from "@goat/contracts";
import { searchParams } from "./gitLabQuery.ts";

export const REFERENCE_PAGE_SIZE = 20;

/**
 * Recently updated issues and merge requests, by title for text. Issue and MR search cannot match
 * a number, so a numeric query also asks for that iid of each.
 */
export function referenceSearches(
  search: string | undefined,
  sigil?: PullRequestReferenceSigil | undefined,
): ReadonlyArray<{
  readonly kind: PullRequestReferenceCandidate["kind"];
  readonly params: ReadonlyArray<readonly [string, string]>;
}> {
  const text = search?.trim() ?? "";
  const numeric = /^\d+$/.test(text);
  const recent: ReadonlyArray<readonly [string, string]> = [
    ["order_by", "updated_at"],
    ["sort", "desc"],
    ...(numeric || searchParams(text, 3).length === 0
      ? []
      : ([...searchParams(text, 3), ["in", "title"]] as const)),
  ];
  const kinds =
    sigil === "#"
      ? (["issue"] as const)
      : sigil === "!"
        ? (["change-request"] as const)
        : (["issue", "change-request"] as const);
  return [
    ...(numeric ? kinds.map((kind) => ({ kind, params: [["iids[]", text]] as const })) : []),
    ...kinds.map((kind) => ({ kind, params: recent })),
  ];
}

export function mergeReferencePages(
  pages: ReadonlyArray<{
    readonly items: ReadonlyArray<PullRequestReferenceCandidate>;
    readonly rawCount: number;
  }>,
) {
  return {
    items: pages.flatMap((page) => page.items),
    truncated: pages.some((page) => page.rawCount >= REFERENCE_PAGE_SIZE),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
type DecodeFailure = Cause.Cause<Schema.SchemaError>;

const RawReferenceSchema = Schema.Struct({
  iid: Schema.Number,
  title: Schema.String,
  state: Schema.String,
});
const decodeReferenceEntry = Schema.decodeUnknownExit(RawReferenceSchema);

/** A list of issues (`#`) or merge requests (`!`), as composers reference them. */
export function decodeReferenceCandidatesJson(
  raw: string,
  kind: PullRequestReferenceCandidate["kind"],
): Result.Result<
  { readonly items: ReadonlyArray<PullRequestReferenceCandidate>; readonly rawCount: number },
  DecodeFailure
> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const items: PullRequestReferenceCandidate[] = [];
  for (const entry of decoded.success) {
    const reference = decodeReferenceEntry(entry);
    if (Exit.isFailure(reference) || !Number.isInteger(reference.value.iid)) continue;
    if (reference.value.iid < 1) continue;
    const { iid, title, state } = reference.value;
    items.push({
      reference: `${kind === "issue" ? "#" : "!"}${iid}`,
      kind,
      number: iid,
      title,
      state: state === "merged" ? "merged" : state === "opened" ? "open" : "closed",
    });
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export function makeReferenceSearch(
  api: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
  }) => ReturnType<GitLabCli.GitLabCli["Service"]["execute"]>,
) {
  const projectReferences = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly kind: PullRequestReferenceCandidate["kind"];
    readonly params: ReadonlyArray<readonly [string, string]>;
  }) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/${
        input.kind === "issue" ? "issues" : "merge_requests"
      }?${query([...input.params, ["per_page", String(REFERENCE_PAGE_SIZE)]])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeReferenceCandidatesJson(result.stdout.trim(), input.kind);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "searchProjectReferences",
                cause: decoded.failure,
              }),
            );
      }),
    );

  return Effect.fn("GitLabPullRequestCli.searchProjectReferences")(function* (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly search?: string | undefined;
    readonly sigil?: PullRequestReferenceSigil | undefined;
  }) {
    const answers = yield* Effect.forEach(
      referenceSearches(input.search, input.sigil),
      ({ kind, params }) => projectReferences({ ...input, kind, params }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const pages = [];
    let failure: GitLabPullRequestCliError | undefined;
    for (const answer of answers) {
      if (Result.isSuccess(answer)) {
        pages.push(answer.success);
      } else {
        const cause = answer.failure;
        if (
          cause._tag === "GitLabCliUnavailableError" ||
          cause._tag === "GitLabCliAuthenticationError" ||
          cause._tag === "GitLabCliRateLimitError"
        )
          return yield* cause;
        failure ??= cause;
      }
    }
    if (failure !== undefined && pages.length === 0) return yield* failure;
    if (failure !== undefined)
      yield* Effect.logWarning("GitLab reference search was incomplete", {
        repository: input.repository,
        reason: failure._tag,
      });
    const merged = mergeReferencePages(pages);
    return { ...merged, truncated: merged.truncated || failure !== undefined };
  });
}
