import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { PullRequestUnavailableError } from "./pullRequestErrors.ts";

it("presents missing-project diagnostics and the old-server fallback", () => {
  const decode = Schema.decodeUnknownSync(PullRequestUnavailableError);
  const base = { _tag: "PullRequestUnavailableError", reason: "provider-unsupported" };
  expect(decode({ ...base, detail: "repository-not-added" }).message).toBe(
    "Add this repository as a project to read its change requests.",
  );
  expect(decode({ ...base, detail: "no-project-on-host" }).message).toBe(
    "Add a project on this host to read its change requests.",
  );
  expect(decode(base).message).toBe(
    "Change requests cannot be browsed for this project's host yet.",
  );
});
