import { EnvironmentId, ProjectId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  readPullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";

it("retains environment, project, host and filters together across a reload", () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  };
  const preferences = {
    involvement: "reviewing" as const,
    state: "open" as const,
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("project"),
    host: "forge.example",
    author: "me",
    labels: ["urgent"],
    review: "approved" as const,
  };
  writePullRequestListPreferences(preferences, storage);
  expect(readPullRequestListPreferences(storage)).toEqual(preferences);
});
