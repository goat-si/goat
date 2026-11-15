import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";

import { GitLabRevertUnavailableError } from "./gitLabPullRequestActionErrors.ts";
import { decodeCommitsJson, trimmed } from "./gitLabMergeRequestJson.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import { projectPath } from "./gitLabInput.ts";

const RawRevertTargetSchema = Schema.Struct({
  title: Schema.String,
  state: Schema.String,
  target_branch: Schema.String,
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  squash_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRevertTarget = decodeJsonResult(RawRevertTargetSchema);

export interface GitLabRevertTarget {
  readonly merged: boolean;
  readonly title: string;
  readonly targetBranch: string;
  /** Null for a fast-forward merge without squash, which records neither SHA. */
  readonly commitSha: string | null;
}

function decodeRevertTargetJson(raw: string) {
  const decoded = decodeRevertTarget(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const mr = decoded.success;
  return Result.succeed<GitLabRevertTarget>({
    merged: mr.state === "merged",
    title: mr.title,
    targetBranch: mr.target_branch,
    commitSha: trimmed(mr.merge_commit_sha) ?? trimmed(mr.squash_commit_sha),
  });
}

interface MergeRequestInput {
  readonly cwd: string;
  readonly host?: string | undefined;
  readonly repository: string;
  readonly number: number;
}

type GitLabApi<E> = (input: {
  readonly cwd: string;
  readonly host?: string | undefined;
  readonly path: string;
  readonly method?: string;
  readonly stdin?: string;
}) => Effect.Effect<{ readonly stdout: string }, E>;

export const makeRevertMergeRequest = <E>(api: GitLabApi<E>) => {
  /** GitLab reverts a fast-forward merge without squash only when it landed as one commit. */
  const soleCommitSha = (input: MergeRequestInput) =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/merge_requests/${input.number}/commits?per_page=2`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeCommitsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "runMergeRequestAction",
              cause: decoded.failure,
            }),
          );
        }
        const [only, ...rest] = decoded.success;
        return Effect.succeed(only !== undefined && rest.length === 0 ? only.oid : null);
      }),
    );

  /** What GitLab's own Revert button does: revert onto a new branch and open a merge request. */
  return Effect.fn("GitLabPullRequestCli.revertMergeRequest")(function* (input: MergeRequestInput) {
    const project = `projects/${projectPath(input.repository)}`;
    const write = (path: string, body: object) =>
      api({
        cwd: input.cwd,
        host: input.host,
        path: `${project}/${path}`,
        method: "POST",
        stdin: JSON.stringify(body),
      });
    const raw = yield* api({
      cwd: input.cwd,
      host: input.host,
      path: `${project}/merge_requests/${input.number}`,
    });
    const decoded = decodeRevertTargetJson(raw.stdout.trim());
    if (!Result.isSuccess(decoded)) {
      return yield* new GitLabMergeRequestReadError({
        command: "glab",
        cwd: input.cwd,
        operation: "runMergeRequestAction",
        cause: decoded.failure,
      });
    }
    const target = decoded.success;
    if (!target.merged) {
      return yield* new GitLabRevertUnavailableError({
        command: "glab",
        cwd: input.cwd,
        number: input.number,
        reason: "not-merged",
      });
    }
    const commitSha = target.commitSha ?? (yield* soleCommitSha(input));
    if (commitSha === null) {
      return yield* new GitLabRevertUnavailableError({
        command: "glab",
        cwd: input.cwd,
        number: input.number,
        reason: "several-commits",
      });
    }
    const branch = `revert-${commitSha.slice(0, 8)}`;
    yield* write("repository/branches", { branch, ref: target.targetBranch });
    yield* Effect.andThen(
      write(`repository/commits/${commitSha}/revert`, { branch }),
      write("merge_requests", {
        source_branch: branch,
        target_branch: target.targetBranch,
        title: `Revert "${target.title}"`,
        description: `This reverts merge request !${input.number}`,
        remove_source_branch: true,
      }),
    ).pipe(
      // Leaving the branch behind would make every retry fail on creating it again. Runs on
      // interruption too, which a cancelled request or a dropped socket causes.
      Effect.onError(() =>
        api({
          cwd: input.cwd,
          host: input.host,
          path: `${project}/repository/branches/${encodeURIComponent(branch)}`,
          method: "DELETE",
        }).pipe(Effect.ignore),
      ),
    );
  });
};
