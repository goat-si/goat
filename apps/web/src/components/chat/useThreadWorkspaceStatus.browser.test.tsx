import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "missing" as string,
  itemCount: 0,
  refresh: vi.fn(),
}));
// The status query, the thread's shell and the live refresh are what the hook follows.
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: (() => ({
    data: { state: state.status },
    error: null,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: ((ref: unknown) =>
    ref === null ? null : { itemCount: state.itemCount }) as never,
}));
vi.mock(import("../../hooks/useLiveRefresh"), () => ({ useLiveRefresh: () => {} }));

import { render } from "../../../test/render";
import { useThreadWorkspaceStatus } from "./useThreadWorkspaceStatus";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread-1") };

function Banner() {
  const status = useThreadWorkspaceStatus(threadRef, "/worktrees/repo/feature", true, "run-1");
  return <p>{status.data?.state === "missing" ? "Worktree missing" : "Worktree here"}</p>;
}

function setup() {
  state.status = "missing";
  state.itemCount = 4;
  state.refresh.mockReset();
}

// A terminal-triggered restore starts no run; its notice is what the banner refreshes on.
it("refreshes the missing-worktree status when the thread gets an item, and stops once healthy", async () => {
  setup();
  await using screen = await render(<Banner />);
  await expect.element(screen.getByText("Worktree missing")).toBeVisible();
  // Only the run key's first refresh: the status that just came back missing is current.
  expect(state.refresh).toHaveBeenCalledTimes(1);
  // The server answers the next refresh: a terminal brought the folder back.
  state.refresh.mockImplementation(() => {
    state.status = "present";
  });
  state.itemCount = 5;
  await screen.rerender(<Banner />);
  expect(state.refresh).toHaveBeenCalledTimes(2);
  await screen.rerender(<Banner />);
  await expect.element(screen.getByText("Worktree here")).toBeVisible();
  state.itemCount = 6;
  await screen.rerender(<Banner />);
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
