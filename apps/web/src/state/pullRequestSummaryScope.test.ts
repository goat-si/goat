import { EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { pullRequestSummaryKey } from "./pullRequests";

it("keeps shared pull request observations separate across hosts and selected accounts", () => {
  const environment = EnvironmentId.make("environment");
  const reference = {
    projectId: ProjectId.make("project"),
    host: "one.example",
    repository: "owner/repo",
    number: 1,
    expectedAccountId: "alice",
  };
  const key = pullRequestSummaryKey(environment, reference);
  expect(pullRequestSummaryKey(environment, { ...reference, host: "two.example" })).not.toBe(key);
  expect(pullRequestSummaryKey(environment, { ...reference, expectedAccountId: "bob" })).not.toBe(
    key,
  );
});
