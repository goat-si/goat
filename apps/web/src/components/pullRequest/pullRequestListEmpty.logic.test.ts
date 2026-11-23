import { EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { pullRequestListAnsweredEmpty } from "./pullRequestList.logic";

it("counts a listing with no rows as empty even when a project could not be read", () => {
  const data = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [
      {
        environmentId: EnvironmentId.make("env-1"),
        projectId: ProjectId.make("project-1"),
        projectTitle: "Web",
        message: "acme/web could not be read.",
      },
    ],
    truncated: false,
    nextCursors: {},
    truncatedEnvironments: [],
  };
  expect(pullRequestListAnsweredEmpty({ data, isPending: false, error: null })).toBe(true);
  expect(pullRequestListAnsweredEmpty({ data, isPending: true, error: null })).toBe(false);
});
