import {
  EnvironmentId,
  ThreadId,
  ThreadWorkspaceRestoreError,
  type ThreadWorkspaceStatus,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { restoreThreadWorkspace: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.restore }));
import { ThreadWorkspaceBanner } from "./ThreadWorkspaceBanner";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const status = (
  state: ThreadWorkspaceStatus["state"],
  extra: Partial<ThreadWorkspaceStatus> = {},
): ThreadWorkspaceStatus => ({
  threadId: threadRef.threadId,
  state,
  worktreePath: "/worktrees/feature",
  branch: "feature",
  snapshot: null,
  ...extra,
});

it("shows restore and fresh failures and sends fresh mode", async () => {
  const failure = new ThreadWorkspaceRestoreError({
    threadId: threadRef.threadId,
    reason: "snapshot-conflict",
    detail: "Snapshot conflict",
  });
  mocks.restore.mockReset().mockResolvedValue({ _tag: "Failure", cause: Cause.fail(failure) });
  await using screen = await render(
    <ThreadWorkspaceBanner threadRef={threadRef} status={status("cleaned")} refresh={() => {}} />,
  );
  await screen.getByRole("button", { name: "Restore" }).click();
  await expect.element(screen.getByText(/Snapshot conflict/)).toBeVisible();
  await screen.getByRole("button", { name: "Start in a new worktree" }).click();
  expect(mocks.restore).toHaveBeenLastCalledWith({
    environmentId: "env",
    input: { threadId: "thread", mode: "fresh" },
  });
  await expect.element(screen.getByText(/Snapshot conflict/)).toBeVisible();
});

it("refreshes after successful restore and hides when status is present", async () => {
  mocks.restore.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { restoredFrom: "branch", branch: "feature", setupScript: "none" },
  });
  const refresh = vi.fn();
  await using screen = await render(
    <ThreadWorkspaceBanner threadRef={threadRef} status={status("missing")} refresh={refresh} />,
  );
  await screen.getByRole("button", { name: "Recreate" }).click();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await screen.rerender(
    <ThreadWorkspaceBanner threadRef={threadRef} status={status("present")} refresh={refresh} />,
  );
  await expect.element(screen.getByRole("button", { name: "Recreate" })).not.toBeInTheDocument();
});

it("offers only to finish setup when an interrupted restore left the folder in place", async () => {
  mocks.restore.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { restoredFrom: "branch", branch: "feature", setupScript: "started" },
  });
  await using screen = await render(
    <ThreadWorkspaceBanner
      threadRef={threadRef}
      status={status("present", { setupIncomplete: true })}
      refresh={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Run setup now" }).click();
  expect(mocks.restore).toHaveBeenLastCalledWith({
    environmentId: "env",
    input: { threadId: "thread", mode: "restore" },
  });
  await expect
    .element(screen.getByRole("button", { name: "Start in a new worktree" }))
    .not.toBeInTheDocument();
});
