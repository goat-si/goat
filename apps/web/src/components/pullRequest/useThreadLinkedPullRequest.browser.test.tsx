import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type RepositoryIdentity,
} from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  branch: null as { projectId: string; repository?: string; number: number; url: string } | null,
  identity: null as RepositoryIdentity | null,
  writes: [] as Array<{ repository: string; number: number; url: string }>,
  persistedState: "closed" as "open" | "closed",
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({ branchPullRequest: state.branch })) as never,
  useProject: (() => ({ repositoryIdentity: state.identity })) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() =>
    async (command: {
      input: { linkedPullRequest: { repository: string; number: number; url: string } };
    }) => {
      state.writes.push(command.input.linkedPullRequest);
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("../ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: (() => ({ pr: { state: state.persistedState } })) as never,
}));

import { act, render } from "../../../test/render";
import { useThreadLinkedPullRequest } from "./useThreadLinkedPullRequest";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const serverThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const persisted = {
  projectId,
  repository: "upstream/project",
  number: 10,
  url: "https://github.com/upstream/project/pull/10",
};
const github: RepositoryIdentity = {
  canonicalKey: "github.com/upstream/project",
  provider: SourceControlProviderKind.make("github"),
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://github.com/upstream/project",
  },
  displayName: "upstream/project",
  owner: "upstream",
  name: "project",
  origin: {
    canonicalKey: "github.com/fork/project",
    remoteUrl: "https://github.com/fork/project",
    displayName: "fork/project",
  },
};
const azure: RepositoryIdentity = {
  canonicalKey: "dev.azure.com/acme/platform/_git/t3code",
  provider: SourceControlProviderKind.make("azure-devops"),
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://dev.azure.com/acme/platform/_git/t3code",
  },
  displayName: "acme/platform/_git/t3code",
  owner: "acme",
  name: "t3code",
  origin: {
    canonicalKey: "dev.azure.com/acme/forks/_git/forkcode",
    remoteUrl: "https://dev.azure.com/acme/forks/_git/forkcode",
    displayName: "acme/forks/_git/forkcode",
  },
};

function Harness({ url }: { url: string }) {
  const { linked } = useThreadLinkedPullRequest({
    serverThreadRef,
    environmentId,
    persisted,
    projectId,
    threadBranch: "feature",
    gitStatus: {
      refName: "feature",
      pr: { number: 11, title: "Work", url, state: "open", headRef: "feature", baseRef: "main" },
    } as never,
  });
  return <div>{linked?.repository}</div>;
}

it.each([
  {
    name: "GitHub fork",
    identity: github,
    url: "https://github.com/fork/project/pull/11",
    repository: "fork/project",
  },
  {
    name: "Azure fork",
    identity: azure,
    url: "https://dev.azure.com/acme/forks/_git/forkcode/pullrequest/11",
    repository: "forkcode",
  },
  {
    name: "Azure upstream",
    identity: azure,
    url: "https://dev.azure.com/acme/platform/_git/t3code/pullrequest/11",
    repository: "t3code",
  },
  {
    name: "older server upstream",
    identity: github,
    url: "https://github.com/upstream/project/pull/11",
    repository: undefined,
    expected: "upstream/project",
  },
])(
  "relinks $name using the validated repository selector (#2464)",
  async ({ identity, url, repository, expected }) => {
    state.identity = identity;
    state.branch = {
      projectId,
      number: 11,
      url,
      ...(repository === undefined ? {} : { repository }),
    };
    state.writes = [];
    state.persistedState = "closed";
    await using screen = await render(<Harness url={url} />);
    await act(async () => {});
    expect(screen.container.textContent).toContain(expected ?? repository);
    expect(state.writes).toEqual([
      { projectId, repository: expected ?? repository, number: 11, url },
    ]);
  },
);

it("does not relink an unrelated detected PR without a matching validated branch reference (#2464)", async () => {
  state.identity = github;
  state.branch = null;
  state.writes = [];
  state.persistedState = "closed";
  await using screen = await render(<Harness url="https://github.com/other/project/pull/11" />);
  await act(async () => {});
  expect(screen.container.textContent).toContain(persisted.repository);
  expect(state.writes).toEqual([]);
});

it("leaves an explicitly linked open PR unchanged (#2464)", async () => {
  state.identity = github;
  state.branch = {
    projectId,
    repository: "fork/project",
    number: 11,
    url: "https://github.com/fork/project/pull/11",
  };
  state.writes = [];
  state.persistedState = "open";
  await using screen = await render(<Harness url={state.branch.url} />);
  await act(async () => {});
  expect(screen.container.textContent).toContain(persisted.repository);
  expect(state.writes).toEqual([]);
});
