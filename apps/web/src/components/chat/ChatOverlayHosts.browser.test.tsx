import { MessageId, type OrchestrationV2Checkpoint } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { openRevertConfirm, RevertConfirmHost } from "./ChatOverlayHosts";
import "../../index.css";

it("only offers file restore for a ready checkpoint in an isolated worktree", async () => {
  const messageId = MessageId.make("rewind-message");
  const ready = {
    ordinalWithinScope: 0,
    appRunOrdinal: null,
    status: "ready",
  } as OrchestrationV2Checkpoint;
  const missing = { ...ready, status: "missing" } as const;
  const onConfirm = vi.fn();
  const view = (worktreePath: string | null, checkpoints: OrchestrationV2Checkpoint[]) => (
    <AppAtomRegistryProvider>
      <RevertConfirmHost
        threadKey="rewind-test"
        checkpoints={checkpoints}
        onConfirm={onConfirm}
        {...{ worktreePath }}
      />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(view(null, [ready]));
  await act(() => openRevertConfirm("rewind-test", { turnCount: 0, messageId }));
  const restore = page.getByRole("button", { name: "Revert files too" });
  await expect.element(restore).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Revert and keep changes" })).toBeEnabled();
  await screen.rerender(view("/tmp/worktree", []));
  await expect.element(restore).toBeDisabled();
  await screen.rerender(view("/tmp/worktree", [missing]));
  await expect.element(restore).toBeDisabled();
  await screen.rerender(view("/tmp/worktree", [ready]));
  await expect.element(restore).toBeEnabled();
  await screen.rerender(view(null, [ready]));
  await page.getByRole("button", { name: "Revert and keep changes" }).click();
  expect(onConfirm).toHaveBeenCalledWith(0, messageId, false);
});
