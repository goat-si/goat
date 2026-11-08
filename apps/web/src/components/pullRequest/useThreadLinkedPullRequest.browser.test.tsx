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
  branch: null as { projectId: string; repository: string; number: number; url: string } | null,
  identity: null as RepositoryIdentity | null,
  writes: [] as Array<{ repository: string; number: number; url: string }>,
  persistedState: "closed" as "open" | "closed",
  server: "current" as "current" | "older" | "unknown",
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({ branchPullRequest: state.branch })) as never,
  useProject: (() => ({ repositoryIdentity: state.identity })) as never,
  useServerConfigs: (() =>
    new Map(
      state.server === "unknown"
        ? []
        : [
            [
              "environment",
              {
                environment: {
                  capabilities: state.server === "current" ? { forkBranchPullRequests: true } : {},
                },
              },
            ],
          ],
    )) as never,
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

function setup(input: {
  identity: RepositoryIdentity;
  branch: typeof state.branch;
  server?: typeof state.server;
  persistedState?: typeof state.persistedState;
}) {
  state.identity = input.identity;
  state.branch = input.branch;
  state.server = input.server ?? "current";
  state.persistedState = input.persistedState ?? "closed";
  state.writes = [];
}

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
    name: "older Azure server upstream",
    identity: azure,
    url: "https://dev.azure.com/acme/platform/_git/t3code/pullrequest/11",
    repository: "t3code",
  },
  {
    name: "older GitHub server upstream",
    identity: github,
    url: "https://github.com/upstream/project/pull/11",
    repository: "upstream/project",
  },
])(
  "relinks $name using the validated repository selector (#2464)",
  async ({ identity, url, repository }) => {
    setup({ identity, branch: { projectId, number: 11, url, repository } });
    await using screen = await render(<Harness url={url} />);
    await act(async () => {});
    expect(screen.container.textContent).toContain(repository);
    expect(state.writes).toEqual([{ projectId, repository, number: 11, url }]);
  },
);

it.each([
  { name: "no reference", branch: null },
  {
    name: "stale reference",
    branch: {
      projectId,
      repository: "fork/project",
      number: 11,
      url: "https://github.com/fork/project/pull/11",
    },
  },
  {
    name: "unrelated reference",
    branch: {
      projectId,
      repository: "other/project",
      number: 11,
      url: "https://github.com/other/project/pull/11",
    },
  },
])("does not relink an unrelated detected PR with $name (#2464, #2522)", async ({ branch }) => {
  for (const server of ["current", "older"] as const) {
    setup({ identity: github, branch, server });
    await using screen = await render(<Harness url="https://github.com/other/project/pull/11" />);
    await act(async () => {});
    expect(screen.container.textContent).toContain(persisted.repository);
    expect(state.writes).toEqual([]);
  }
});

it("waits for the matching server reference before relinking (#2464)", async () => {
  setup({ identity: github, branch: null });
  const url = "https://github.com/fork/project/pull/11";
  await using screen = await render(<Harness url={url} />);
  await act(async () => {});
  expect(screen.container.textContent).toContain(persisted.repository);
  expect(state.writes).toEqual([]);
  state.branch = { projectId, repository: "fork/project", number: 11, url };
  await screen.rerender(<Harness url={url} />);
  await act(async () => {});
  expect(state.writes).toEqual([{ projectId, repository: "fork/project", number: 11, url }]);
});

it("waits while the server's capabilities are unknown (#2522)", async () => {
  setup({ identity: github, branch: null, server: "unknown" });
  await using screen = await render(<Harness url="https://github.com/fork/project/pull/11" />);
  await act(async () => {});
  expect(screen.container.textContent).toContain(persisted.repository);
  expect(state.writes).toEqual([]);
});

const upstreamLeftover = {
  projectId,
  repository: "upstream/project",
  number: 9,
  url: "https://github.com/upstream/project/pull/9",
};

it.each([
  {
    name: "GitHub fork without a reference",
    identity: github,
    branch: null,
    url: "https://github.com/fork/project/pull/11",
    repository: "fork/project",
  },
  {
    name: "GitHub fork with a leftover upstream reference",
    identity: github,
    branch: upstreamLeftover,
    url: "https://github.com/fork/project/pull/11",
    repository: "fork/project",
  },
  {
    name: "Azure fork without a reference",
    identity: azure,
    branch: null,
    url: "https://dev.azure.com/acme/forks/_git/forkcode/pullrequest/11",
    repository: "forkcode",
  },
])(
  "relinks a $name from an older server that drops fork PRs (#2522)",
  async ({ identity, branch, url, repository }) => {
    setup({ identity, branch, server: "older" });
    await using screen = await render(<Harness url={url} />);
    await act(async () => {});
    expect(screen.container.textContent).toContain(repository);
    expect(state.writes).toEqual([{ projectId, repository, number: 11, url }]);
  },
);

it("leaves an explicitly linked open PR unchanged (#2464)", async () => {
  const url = "https://github.com/fork/project/pull/11";
  setup({
    identity: github,
    branch: { projectId, repository: "fork/project", number: 11, url },
    persistedState: "open",
  });
  await using screen = await render(<Harness url={url} />);
  await act(async () => {});
  expect(screen.container.textContent).toContain(persisted.repository);
  expect(state.writes).toEqual([]);
});
