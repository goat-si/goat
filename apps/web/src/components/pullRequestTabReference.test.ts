import { expect, it } from "vite-plus/test";
import { pullRequestTabReference } from "./pullRequestTabReference";

it("keeps the host in a pull request tab's shared-summary reference", () => {
  expect(
    pullRequestTabReference({
      id: "pull-request:pr",
      kind: "pull-request",
      projectId: "project",
      host: "forge.example",
      repository: "org/repo",
      number: 7,
    }),
  ).toEqual({ projectId: "project", host: "forge.example", repository: "org/repo", number: 7 });
});
