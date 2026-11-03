import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  branch: null as { projectId: string; repository: string; number: number; url: string } | null,
  answer: null as { entries: never[]; errors: never[]; truncated: boolean } | null,
  writes: [] as Array<{ repository: string; number: number; url: string }>,
  persistedState: "closed" as "open" | "closed",
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({ branchPullRequest: state.branch })) as never,
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
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.answer,
    isSuccess: state.answer !== null,
    isPending: state.answer === null,
  })) as never,
}));

import { act, render } from "../../../test/render";
import { useThreadLinkedPullRequest } from "./useThreadLinkedPullRequest";

it.each([
  { name: "listing pending on an older server", answer: null },
  { name: "empty listing", answer: { entries: [], errors: [], truncated: false } },
  {
    name: "listing error",
    answer: { entries: [], errors: [{ message: "unavailable" } as never], truncated: false },
  },
  { name: "truncated listing", answer: { entries: [], errors: [], truncated: true } },
])("relinks the fork URL regardless of $name (#2464)", async ({ answer }) => {
  state.branch = null;
  state.answer = answer;
  state.writes = [];
  state.persistedState = "closed";
  const environmentId = EnvironmentId.make("environment");
  const projectId = ProjectId.make("project");
  const serverThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
  const old = {
    projectId,
    repository: "upstream/project",
    number: 10,
    url: "https://github.com/upstream/project/pull/10",
  };
  const fork = {
    projectId,
    repository: "fork/project",
    number: 11,
    url: "https://github.com/fork/project/pull/11",
  };
  function Harness() {
    const { linked } = useThreadLinkedPullRequest({
      serverThreadRef,
      environmentId,
      persisted: old,
      projectId,
      threadBranch: "feature",
      gitStatus: {
        refName: "feature",
        pr: {
          number: 11,
          title: "Work",
          url: fork.url,
          state: "open",
          headRef: "feature",
          baseRef: "main",
        },
      } as never,
    });
    return <div>{linked?.repository}</div>;
  }
  await using screen = await render(<Harness />);
  await expect.element(screen.getByText("fork/project")).toBeVisible();
  await act(async () => {});
  expect(state.writes).toEqual([fork]);
});

it("does not relink an unparseable detected URL (#2464)", async () => {
  state.branch = null;
  state.answer = { entries: [], errors: [], truncated: false };
  state.writes = [];
  state.persistedState = "closed";
  const environmentId = EnvironmentId.make("environment");
  const projectId = ProjectId.make("project");
  const old = {
    projectId,
    repository: "upstream/project",
    number: 10,
    url: "https://github.com/upstream/project/pull/10",
  };
  function Harness() {
    const { linked } = useThreadLinkedPullRequest({
      serverThreadRef: scopeThreadRef(environmentId, ThreadId.make("thread")),
      environmentId,
      persisted: old,
      projectId,
      threadBranch: "feature",
      gitStatus: {
        refName: "feature",
        pr: {
          number: 11,
          title: "Work",
          url: "not-a-pr-url",
          state: "open",
          headRef: "feature",
          baseRef: "main",
        },
      } as never,
    });
    return <div>{linked?.repository}</div>;
  }
  await using screen = await render(<Harness />);
  await expect.element(screen.getByText("upstream/project")).toBeVisible();
  await act(async () => {});
  expect(state.writes).toEqual([]);
});

it("keeps an explicitly linked open upstream PR when the branch has a fork PR (#2464)", async () => {
  state.branch = null;
  state.answer = null;
  state.writes = [];
  state.persistedState = "open";
  const environmentId = EnvironmentId.make("environment");
  const projectId = ProjectId.make("project");
  const persisted = {
    projectId,
    repository: "upstream/project",
    number: 11,
    url: "https://github.com/upstream/project/pull/11",
  };
  function Harness() {
    const { linked } = useThreadLinkedPullRequest({
      serverThreadRef: scopeThreadRef(environmentId, ThreadId.make("thread")),
      environmentId,
      persisted,
      projectId,
      threadBranch: "feature",
      gitStatus: {
        refName: "feature",
        pr: {
          number: 11,
          title: "Work",
          url: "https://github.com/fork/project/pull/11",
          state: "open",
          headRef: "feature",
          baseRef: "main",
        },
      } as never,
    });
    return <div>{linked?.url}</div>;
  }
  await using screen = await render(<Harness />);
  await expect.element(screen.getByText(persisted.url)).toBeVisible();
  await act(async () => {});
  expect(state.writes).toEqual([]);
});
