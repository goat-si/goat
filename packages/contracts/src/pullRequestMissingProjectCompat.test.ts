import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PullRequestListResult } from "./pullRequest.ts";
import { PullRequestUnavailableError, PullRequestUnavailableReason } from "./pullRequestErrors.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

// The fields from git show 7898e25ad0a:packages/contracts/src/pullRequestErrors.ts.
const previous = Schema.TaggedStruct("PullRequestUnavailableError", {
  reason: PullRequestUnavailableReason,
  provider: Schema.optional(SourceControlProviderKind),
  listResult: Schema.optional(PullRequestListResult),
  requirement: Schema.optional(TrimmedNonEmptyString),
  cause: Schema.optional(Schema.Defect()),
});

it("keeps missing-project errors decodable by the previous and current contracts", () => {
  const decodePrevious = Schema.decodeUnknownSync(previous);
  const decodeCurrent = Schema.decodeUnknownSync(PullRequestUnavailableError);
  const base = { _tag: "PullRequestUnavailableError", reason: "provider-unsupported" };
  for (const detail of ["repository-not-added", "no-project-on-host"]) {
    const wire = { ...base, detail };
    expect(decodePrevious(wire)).not.toHaveProperty("detail");
    expect(decodeCurrent(wire)).toHaveProperty("detail", detail);
  }
  expect(decodeCurrent(base).message).toBe(
    "Change requests cannot be browsed for this project's host yet.",
  );
});
