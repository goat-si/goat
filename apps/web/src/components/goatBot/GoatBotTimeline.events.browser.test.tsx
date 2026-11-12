import { EnvironmentId } from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
import { GoatBotTimeline } from "./GoatBotTimeline";

const event: GoatBotRow = {
  kind: "event",
  id: "event",
  text: "Routine Check in paused",
  createdAt: "2026-11-07T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
};

it("shows a bot event as a note line in the conversation", async () => {
  await using screen = await render(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[event]} onRetry={() => {}} />,
  );
  await expect
    .element(screen.getByRole("note").filter({ hasText: "Routine Check in paused" }))
    .toBeVisible();
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
});

it("turns the routine a line names into a chip that opens the bot's home", async () => {
  const onOpenHome = vi.fn();
  const named: GoatBotRow = {
    ...event,
    subject: { kind: "routine", id: "routine-1", name: "Check in" },
  };
  await using screen = await render(
    <GoatBotTimeline
      environmentId={EnvironmentId.make("env")}
      rows={[named]}
      onRetry={() => {}}
      onOpenHome={onOpenHome}
    />,
  );
  await expect
    .element(screen.getByRole("note").filter({ hasText: "Routine Check in paused" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  expect(onOpenHome).toHaveBeenCalledOnce();
});
