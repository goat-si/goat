import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabPullRequestCli } from "./GitLabPullRequestCli.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import { projectPath } from "./gitLabInput.ts";
import { query } from "./gitLabQuery.ts";
import { decodeOwnAwardIdJson, gitLabAwardName } from "./gitLabMergeRequestJson.ts";
import type { makeGitLabViewer } from "./gitLabViewer.ts";

const MAX_AWARD_PAGES = 100;
const AWARDS_PER_PAGE = 100;

export function makeGitLabAwards(
  api: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
    readonly method?: string;
  }) => ReturnType<GitLabCli.GitLabCli["Service"]["execute"]>,
  viewerUsername: ReturnType<typeof makeGitLabViewer>,
): {
  awardSubjectPath: (input: {
    readonly repository: string;
    readonly number: number;
    readonly noteId?: string | undefined;
  }) => string;
  setReaction: GitLabPullRequestCli["Service"]["setReaction"];
} {
  const awardSubjectPath = (input: {
    readonly repository: string;
    readonly number: number;
    readonly noteId?: string | undefined;
  }) => {
    const mergeRequest = `projects/${projectPath(input.repository)}/merge_requests/${input.number}`;
    return input.noteId === undefined
      ? `${mergeRequest}/award_emoji`
      : `${mergeRequest}/notes/${encodeURIComponent(input.noteId)}/award_emoji`;
  };

  return {
    awardSubjectPath,
    setReaction: Effect.fn("GitLabPullRequestCli.setReaction")(function* (input) {
      const subject = awardSubjectPath(input);
      if (input.reacted) {
        yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
          method: "POST",
        });
        return;
      }
      // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
      // award of that name is looked up first.
      const viewer = yield* viewerUsername(input);
      for (let page = 1; page <= MAX_AWARD_PAGES; page++) {
        const listed = yield* api({
          cwd: input.cwd,
          host: input.host,
          path: `${subject}?${query([
            ["per_page", String(AWARDS_PER_PAGE)],
            ["page", String(page)],
          ])}`,
        });
        const own = decodeOwnAwardIdJson(listed.stdout.trim(), { content: input.content, viewer });
        if (!Result.isSuccess(own))
          return yield* new GitLabMergeRequestReadError({
            command: "glab",
            cwd: input.cwd,
            operation: "setReaction",
            cause: own.failure,
          });
        if (own.success.id !== null) {
          yield* api({
            cwd: input.cwd,
            host: input.host,
            path: `${subject}/${own.success.id}`,
            method: "DELETE",
          });
          return;
        }
        if (own.success.empty) return;
      }
      return yield* new GitLabMergeRequestReadError({
        command: "glab",
        cwd: input.cwd,
        operation: "setReaction",
        cause: "Award pages exceeded the read limit",
      });
    }),
  };
}
