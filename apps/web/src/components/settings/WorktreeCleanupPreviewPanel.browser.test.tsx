import { EnvironmentId, type WorktreeCleanupPreview } from "@goat/contracts";
import { EnvironmentRpcUnavailableError } from "@goat/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ToastProvider } from "../ui/toast";

// The message a command gets when its computer has no session (rpc/client.ts currentSession).
const NOT_CONNECTED = "Test computer is not connected.";
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const failing = (label: string) => ({
    label,
    permissionAtom: () => Atom.make(true),
    run: async () =>
      AsyncResult.failure(
        Cause.fail(
          new EnvironmentRpcUnavailableError({ environmentId: "env", message: NOT_CONNECTED }),
        ),
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
  await using screen = await render(
    <ToastProvider timeout={0}>
      <WorktreeCleanupPreviewPanel environmentId={EnvironmentId.make("env")} preview={preview} />
    </ToastProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: button }));
  await expect.element(page.getByText(title)).toBeVisible();
  await expect.element(page.getByText(NOT_CONNECTED)).toBeVisible();
});
