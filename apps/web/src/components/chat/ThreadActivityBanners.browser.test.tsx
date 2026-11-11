import { HELD_TURN_STOP_NOTE } from "@goat/client-runtime/state/thread-execution";
import { RunId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { startHoldBannerItem } from "./ThreadActivityBanners";

it("asks before stopping a held turn and explains the paused goal", async () => {
  const onStop = vi.fn();
  const item = startHoldBannerItem({
    threadId: ThreadId.make("thread"),
    hold: {
      runId: RunId.make("run"),
      reason: "unowned_turn",
      nativeTurnId: "turn",
      title: "Waiting for Codex",
      description: "A turn is still running.",
    },
    canStop: true,
    stopping: false,
    onStop,
  });
  await using screen = await render(<ComposerBannerStack items={[item]} />);

  await userEvent.click(screen.getByRole("button", { name: "Stop that turn" }));
  expect(onStop).not.toHaveBeenCalled();
  await expect.element(screen.getByText(HELD_TURN_STOP_NOTE)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onStop).not.toHaveBeenCalled();

  screen.getByRole("button", { name: "Stop that turn" }).element().focus();
  await userEvent.keyboard("{Enter}");
  const confirm = screen.getByRole("button", { name: "Stop turn", exact: true });
  await expect.element(confirm).toBeVisible();
  confirm.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onStop).toHaveBeenCalledOnce();
});
