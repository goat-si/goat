import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ action: string; input: unknown }>,
  read: null as null | (() => Promise<unknown>),
  refs: [
    {
      name: "old",
      current: false,
      isDefault: false,
      isRemote: false,
      worktreePath: "/other" as string | null,
    },
  ],
}));
const thread = {
  environmentId: EnvironmentId.make("env"),
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  worktreePath: "/current",
  branch: "main",
  runtime: null,
};
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: () => thread as never,
  readThreadShell: () => thread as never,
  useProject: () => ({ id: "project", workspaceRoot: "/repo" }) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../state/vcs"), async (original) => ({
  ...(await original()),
  vcsEnvironment: {
    status: () => null,
    listRefs: () => null,
    switchRef: "switch",
    readRefs: "read",
    createRef: "create",
    refreshLocalStatusForPicker: "refresh",
  } as never,
}));
vi.mock(import("../state/threads"), async (original) => ({
  ...(await original()),
  threadEnvironment: { stopSession: "stop", updateMetadata: "update" } as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((action: string) => async (request: { input: unknown }) => {
    state.calls.push({ action, input: request.input });
    if (action === "read" && state.read) return state.read();
    return AsyncResult.success(action === "switch" ? { refName: "old" } : undefined);
  }) as never,
}));
vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { refName: "main", refs: [], workingTree: { rootPath: "/repo" } },
    isPending: false,
  })) as never,
}));
vi.mock(import("../state/queries"), async (original) => ({
  ...(await original()),
  usePaginatedBranches: (() => ({
    refs: state.refs,
    data: { nextCursor: null },
    isPending: false,
    refresh: () => {},
    loadNext: () => {},
  })) as never,
}));
vi.mock(import("./ThreadStatusIndicators"), async (original) => ({
  ...(await original()),
  useLinkedThreadPullRequest: () => null,
}));
vi.mock(import("../lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenPrLink: () => vi.fn(),
}));
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

it("checks a listed worktree before switching to it", async () => {
  state.calls = [];
  state.refs = [
    { name: "old", current: false, isDefault: false, isRemote: false, worktreePath: "/other" },
  ];
  state.read = async () =>
    AsyncResult.success({ refs: [{ name: "different", current: true, isRemote: false }] });
  await using screen = await render(
    <BranchToolbarBranchSelector
      environmentId={thread.environmentId}
      threadId={thread.id}
      envLocked
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /old/ }));
  await vi.waitFor(() => expect(state.calls.some((call) => call.action === "switch")).toBe(true));
  expect(state.calls.find((call) => call.action === "read")?.input).toMatchObject({
    cwd: "/other",
  });
  expect(state.calls.find((call) => call.action === "switch")?.input).toMatchObject({
    cwd: "/current",
    refName: "old",
  });
});

it("ignores a ref confirmation that arrives after navigation", async () => {
  state.calls = [];
  state.refs = [
    { name: "old", current: false, isDefault: false, isRemote: false, worktreePath: "/other" },
  ];
  let finish!: (value: unknown) => void;
  state.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const view = (id: ThreadId) => (
    <BranchToolbarBranchSelector
      environmentId={thread.environmentId}
      threadId={id}
      envLocked
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
    />
  );
  await using screen = await render(view(thread.id));
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /old/ }));
  await vi.waitFor(() => expect(state.calls.some((call) => call.action === "read")).toBe(true));
  await screen.rerender(view(ThreadId.make("another-thread")));
  await act(async () =>
    finish(AsyncResult.success({ refs: [{ name: "old", current: true, isRemote: false }] })),
  );
  expect(
    state.calls.filter((call) => call.action === "switch" || call.action === "update"),
  ).toEqual([]);
});

it("reuses the selected worktree when its current ref is confirmed", async () => {
  state.calls = [];
  state.refs = [
    { name: "old", current: false, isDefault: false, isRemote: false, worktreePath: "/other" },
  ];
  state.read = async () =>
    AsyncResult.success({ refs: [{ name: "old", current: true, isRemote: false }] });
  await using screen = await render(
    <BranchToolbarBranchSelector
      environmentId={thread.environmentId}
      threadId={thread.id}
      envLocked
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /old/ }));
  await vi.waitFor(() => expect(state.calls.some((call) => call.action === "update")).toBe(true));
  expect(state.calls.find((call) => call.action === "update")?.input).toMatchObject({
    branch: "old",
    worktreePath: "/other",
  });
  expect(state.calls.some((call) => call.action === "switch")).toBe(false);
});

it("ignores an older confirmation after a newer selection", async () => {
  state.calls = [];
  state.refs = [
    { name: "old", current: false, isDefault: false, isRemote: false, worktreePath: "/other" },
    { name: "next", current: false, isDefault: false, isRemote: false, worktreePath: null },
  ];
  let finish!: (value: unknown) => void;
  state.read = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await using screen = await render(
    <BranchToolbarBranchSelector
      environmentId={thread.environmentId}
      threadId={thread.id}
      envLocked
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /old/ }));
  await vi.waitFor(() => expect(state.calls.some((call) => call.action === "read")).toBe(true));
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(screen.getByRole("option", { name: /next/ }));
  await vi.waitFor(() => expect(state.calls.some((call) => call.action === "switch")).toBe(true));
  await act(async () =>
    finish(AsyncResult.success({ refs: [{ name: "old", current: true, isRemote: false }] })),
  );
  expect(state.calls.filter((call) => call.action === "switch")).toHaveLength(1);
  expect(
    state.calls
      .filter((call) => call.action === "update")
      .every((call) => (call.input as { branch: string }).branch !== "old"),
  ).toBe(true);
});
