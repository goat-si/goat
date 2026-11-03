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

const listed = (id: string, host: string, repository: string, upstream = false) => ({
  cursorKey: `${host} ${repository}`,
  project: { id: id as ProjectId },
  repository,
  host,
  upstream,
});

const answered = (targets: ReturnType<typeof statTargets<ReturnType<typeof listed>>>) =>
  targets.map(({ project, projectIds }) => [project.host, projectIds.join(",")]);

describe("projectRepositories", () => {
  it("lists every fork's own repository before any upstream, a same-path one on another host too", () => {
    const repositories = projectRepositories([
      checkout("fork", "github.com/pingdotgg/t3code", "github.com/goat-si/goat"),
      checkout("cafe", "github.com/goat-si/goat", "git.cafe/goat-si/goat"),
    ]);
    assert.deepStrictEqual(
      repositories.map(({ project, identity, upstream }) => [
        project.id,
        identity?.canonicalKey,
        upstream,
      ]),
      [
        ["fork", "github.com/goat-si/goat", false],
        ["cafe", "git.cafe/goat-si/goat", false],
        ["fork", "github.com/pingdotgg/t3code", true],
        ["cafe", "github.com/goat-si/goat", true],
      ],
    );
  });
});

describe("statTargets", () => {
  it("reads a project's own repository or the host its ref names when one path is on two hosts", () => {
    const repositories = [
      listed("cafe", "git.cafe", "goat-si/goat"),
      listed("cafe", "github.com", "goat-si/goat", true),
    ];
    const ref = { projectId: "cafe" as ProjectId, repository: "goat-si/goat", number: 7 };
    assert.deepStrictEqual(answered(statTargets(repositories, [ref])), [["git.cafe", "cafe"]]);
    assert.deepStrictEqual(
      answered(
        statTargets(repositories, [
          { ...ref, host: "github.com" },
          { ...ref, host: "git.cafe" },
        ]),
      ),
      [
        ["github.com", "cafe"],
        ["git.cafe", "cafe"],
      ],
    );
  });

  it("leaves a name other projects list on two hosts unanswered unless the ref names the host", () => {
    const repositories = [
      listed("a", "github.com", "goat-si/goat"),
      listed("b", "git.cafe", "goat-si/goat"),
    ];
    const ref = { projectId: "c" as ProjectId, repository: "goat-si/goat", number: 7 };
    assert.deepStrictEqual(statTargets(repositories, [ref]), []);
    assert.deepStrictEqual(answered(statTargets(repositories, [{ ...ref, host: "git.cafe" }])), [
      ["git.cafe", "c"],
    ]);
  });
});
