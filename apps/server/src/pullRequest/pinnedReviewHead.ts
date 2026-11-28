import { PullRequestOperationError } from "@goat/contracts";
import type { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import type { SupportedProject, PullRequestError } from "./PullRequestService.ts";

export const pinnedReviewHead = (
  project: SupportedProject,
  input: { readonly number: number; readonly expectedHeadSha?: string | undefined },
  mapError: (error: PullRequestProviderError) => PullRequestError,
): Effect.Effect<string | undefined, PullRequestError> => {
  const expected = input.expectedHeadSha;
  if (expected === undefined) return Effect.succeed(undefined);
  return project.api
    .getChangeRequest({
      cwd: project.project.workspaceRoot,
      repository: project.repository,
      host: project.host,
      number: input.number,
    })
    .pipe(
      Effect.mapError(mapError),
      Effect.flatMap(({ headSha }) => {
        const wanted = expected.toLowerCase();
        const matches =
          typeof headSha === "string" &&
          (/^[0-9a-f]{7,}$/.test(wanted)
            ? headSha.toLowerCase().startsWith(wanted)
            : headSha === expected);
        return matches
          ? Effect.succeed(headSha)
          : Effect.fail(
              new PullRequestOperationError({
                operation: "submitReview",
                detail: `The head is now ${headSha ?? "unknown"}, not ${expected}. Review the new commits first.`,
              }),
            );
      }),
    );
};
