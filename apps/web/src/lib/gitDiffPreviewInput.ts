import type { ReviewDiffPreviewInput, ReviewDiffPreviewSourceKind } from "@goat/contracts";

/** One key order for every git diff read: the query cache keys on the serialized input. */
export function gitDiffPreviewInput(input: {
  readonly cwd: string;
  readonly scope: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null | undefined;
  readonly ignoreWhitespace: boolean;
}): ReviewDiffPreviewInput {
  return {
    cwd: input.cwd,
    scope: input.scope,
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ignoreWhitespace: input.ignoreWhitespace,
    metadataOnly: true,
  };
}
