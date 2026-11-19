import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { PullRequestUnavailableError as PreviousPullRequestUnavailableError } from "./pullRequestErrors.base-7898e25ad0a.testkit.ts";
import { PullRequestUnavailableError } from "./pullRequestErrors.ts";

it("keeps missing-project errors decodable by the previous and current contracts", () => {
  const decodePrevious = Schema.decodeUnknownSync(PreviousPullRequestUnavailableError);
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
