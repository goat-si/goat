import { EnvironmentId, type WorktreeCleanupPreview } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ toast: vi.fn() }));
const NOT_SENT = "Test computer reconnected before this ran, so it was not sent. Try again.";
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const failing = (label: string) => ({
    label,
    permissionAtom: () => Atom.make(true),
    run: async () =>
      AsyncResult.failure(
        Cause.fail(new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_SENT })),
      ),
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      respondWorktreeCleanupPreview: failing("respond") as never,
      updateSettings: failing("update") as never,
    },
  };
});

import { WorktreeCleanupPreviewPanel } from "./WorktreeCleanupPreviewPanel";

const preview = {
  id: "preview-1",
  plannedCount: 2,
  activatesAt: null,
} as unknown as WorktreeCleanupPreview;

it.each([
  { button: "Turn off", title: "Could not turn off worktree cleanup" },
  { button: "Clean up now", title: "Could not start worktree cleanup" },
])("shows why $button failed", async ({ button, title }) => {
  state.toast.mockReset();
  await using screen = await render(
    <WorktreeCleanupPreviewPanel environmentId={EnvironmentId.make("env")} preview={preview} />,
  );
  await userEvent.click(screen.getByRole("button", { name: button }));
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith({ type: "error", title, description: NOT_SENT }),
  );
});
