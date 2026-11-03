import { assert, describe, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@goat/contracts";

import { projectRepositories, statTargets } from "./projectRepositories.ts";

function checkout(id: string, upstream: string, origin: string): OrchestrationProjectShell {
  return {
    id: id as ProjectId,
    title: id,
    workspaceRoot: `/${id}`,
    repositoryIdentity: {
      canonicalKey: upstream,
      locator: {
        source: "git-remote",
        remoteName: "upstream",
        remoteUrl: `https://${upstream}.git`,
      },
      provider: SourceControlProviderKind.make("github"),
      origin: { canonicalKey: origin, remoteUrl: `https://${origin}.git` },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

const listed = (id: string, host: string, repository: string) => ({
  cursorKey: `${host} ${repository}`,
  project: { id: id as ProjectId },
  repository,
  host,
});

describe("projectRepositories", () => {
  it("lists a fork's upstream but not a mirror of its own repository on another host", () => {
    const repositories = projectRepositories([
      checkout("fork", "github.com/pingdotgg/t3code", "github.com/goat-si/goat"),
      checkout("mirror", "github.com/goat-si/goat", "git.cafe/goat-si/goat"),
    ]);
    assert.deepStrictEqual(
      repositories.map(({ project, identity, upstream }) => [
        project.id,
        identity?.canonicalKey,
        upstream,
      ]),
      [
        ["fork", "github.com/goat-si/goat", false],
        ["mirror", "git.cafe/goat-si/goat", false],
        ["fork", "github.com/pingdotgg/t3code", true],
      ],
    );
  });
});

describe("statTargets", () => {
  it("leaves a name listed on two hosts unanswered unless the ref names the host", () => {
    const repositories = [
      listed("a", "github.com", "goat-si/goat"),
      listed("b", "git.cafe", "goat-si/goat"),
    ];
    const ref = { projectId: "c" as ProjectId, repository: "goat-si/goat", number: 7 };
    assert.deepStrictEqual(statTargets(repositories, [ref]), []);
    assert.deepStrictEqual(
      statTargets(repositories, [{ ...ref, host: "git.cafe" }]).map(({ project, projectIds }) => [
        project.host,
        projectIds,
      ]),
      [["git.cafe", ["c"]]],
    );
  });
});
