import {
  PullRequestOperationError,
  type PullRequestActivity,
  type PullRequestRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { PullRequestError } from "./PullRequestService.ts";

// Hosts read commits from the repository; restrict reads to this change request's commits.
export const withListedCommit = <
  I extends PullRequestRef & { readonly commit?: string | undefined },
>(
  operation: string,
  input: I,
  read: (input: I) => Effect.Effect<PullRequestActivity, PullRequestError>,
): Effect.Effect<I, PullRequestError> => {
  const wanted = input.commit?.toLowerCase();
  if (wanted === undefined) return Effect.succeed(input);
  return read(input).pipe(
    Effect.flatMap(({ commits }) => {
      const listed = /^[0-9a-f]{7,64}$/.test(wanted)
        ? commits.filter((commit) => commit.oid.toLowerCase().startsWith(wanted))
        : [];
      const [commit] = listed;
      return commit !== undefined && listed.length === 1
        ? Effect.succeed({ ...input, commit: commit.oid })
        : Effect.fail(
            new PullRequestOperationError({
              operation,
              detail: "This commit is not part of the change request.",
              reason: "not-found",
            }),
          );
    }),
  );
};

type Service = import("./PullRequestService.ts").PullRequestService["Service"];
type FileInput = Parameters<Service["diffFileContents"]>[0];
export const guardDiffFileContents =
  (
    changesFile: (input: FileInput) => Effect.Effect<boolean, PullRequestError>,
    read: Service["diffFileContents"],
    activity: Service["activity"],
  ): Service["diffFileContents"] =>
  (input) =>
    withListedCommit("diffFileContents", input, activity).pipe(
      Effect.flatMap((ref) =>
        changesFile(ref).pipe(
          Effect.flatMap((changed) =>
            changed
              ? read(ref)
              : Effect.fail(
                  new PullRequestOperationError({
                    operation: "diffFileContents",
                    detail: "This file is not part of the change request.",
                    reason: "not-found",
                  }),
                ),
          ),
        ),
      ),
    );
