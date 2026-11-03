import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  branch: null as { projectId: string; repository: string; number: number; url: string } | null,
  answer: null as { entries: never[]; errors: never[]; truncated: boolean } | null,
  writes: [] as Array<{ repository: string; number: number }>,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({ branchPullRequest: state.branch })) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), async (original) => ({
  ...(await original()),
  useOrchestrationCommand: (() =>
    async (command: { input: { linkedPullRequest: { repository: string; number: number } } }) => {
      state.writes.push(command.input.linkedPullRequest);
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("../ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: (() => ({ pr: { state: "closed" } })) as never,
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

it("waits for the branch repository before relinking a fork PR (#2464)", async () => {
  state.branch = null;
  state.answer = null;
  state.writes = [];
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
      projectRepository: "upstream/project",
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
  await act(async () => {});
  expect(state.writes).toEqual([]);
  state.branch = fork;
  await screen.rerender(<Harness />);
  await expect.element(screen.getByText("fork/project")).toBeVisible();
  expect(state.writes).toEqual([
    expect.objectContaining({ repository: "fork/project", number: 11 }),
  ]);
  state.branch = null;
  state.answer = null;
  state.writes = [];
  await screen.rerender(<Harness />);
  await act(async () => {});
  expect(state.writes).toEqual([]);
  state.answer = { entries: [fork as never], errors: [], truncated: false };
  await screen.rerender(<Harness />);
  await act(async () => {});
  expect(state.writes).toEqual([
    expect.objectContaining({ repository: "fork/project", number: 11 }),
  ]);
  state.answer = { entries: [], errors: [], truncated: true };
  state.writes = [];
  await screen.rerender(<Harness />);
  await act(async () => {});
  expect(state.writes).toEqual([]);
  state.answer = { entries: [], errors: [{ message: "unavailable" } as never], truncated: false };
  await screen.rerender(<Harness />);
  await act(async () => {});
  expect(state.writes).toEqual([]);
  state.answer = { entries: [], errors: [], truncated: false };
  await screen.rerender(<Harness />);
  await act(async () => {});
  expect(state.writes).toEqual([
    expect.objectContaining({ repository: "upstream/project", number: 11 }),
  ]);
});
