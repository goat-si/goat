import "~/index.css";
import { ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { backgroundWorkBannerItem } from "./ThreadActivityBanners";

it("opens a background command's details from the banner", async () => {
  const task = {
    taskId: "task-1",
    kind: "command" as const,
    description: "Audit",
    command: "python audit.py",
    startedAt: "2026-11-09T00:00:00.000Z",
  };
  const banner = backgroundWorkBannerItem({
    threadId: ThreadId.make("thread"),
    tasks: [task],
    stopDisabled: false,
    stopping: false,
    onStop: async () => {},
    onOpenThread: () => {},
  });
  if (!banner) throw new Error("Background banner missing");
  await using screen = await render(<ComposerBannerStack items={[banner]} />);
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByText("python audit.py", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/Started/)).toBeVisible();
});
