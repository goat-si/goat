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

it("turns the routine a line names into a chip that opens that routine by id", async () => {
  const open = vi.fn();
  const onOpenRoutine = vi.fn(() => open);
  const named: GoatBotRow = {
    ...event,
    subject: { kind: "routine", id: "routine-1", name: "Check in" },
  };
  await using screen = await render(
    <GoatBotTimeline
      environmentId={EnvironmentId.make("env")}
      rows={[named]}
      onRetry={() => {}}
      onOpenRoutine={onOpenRoutine}
    />,
  );
  await expect
    .element(screen.getByRole("note").filter({ hasText: "Routine Check in paused" }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open routine Check in" }));
  expect(onOpenRoutine).toHaveBeenCalledWith("routine-1");
  expect(open).toHaveBeenCalledOnce();
});

it("a task chip opens the task with its title, so an older task's pane can name it", async () => {
  const named: GoatBotRow = {
    ...event,
    text: "Task Draft notes finished",
    subject: { kind: "task", id: "task-1", name: "Draft notes" },
  };
  await using screen = await render(
    <GoatBotTimeline environmentId={EnvironmentId.make("env")} rows={[named]} onRetry={() => {}} />,
  );
  const link = screen.getByRole("link", { name: "Open task Draft notes" });
  await expect.element(link).toHaveAttribute("href", expect.stringContaining("taskTitle=Draft"));
});

it("a routine named like the line's first word gets its chip on the name, not the first word", async () => {
  const named: GoatBotRow = {
    ...event,
    text: "Routine Routine paused",
    subject: { kind: "routine", id: "routine-1", name: "Routine" },
  };
  await using screen = await render(
    <GoatBotTimeline
      environmentId={EnvironmentId.make("env")}
      rows={[named]}
      onRetry={() => {}}
      onOpenRoutine={() => () => {}}
    />,
  );
  const note = screen.getByRole("note");
  await expect.element(note).toHaveTextContent("Routine Routine paused");
  const chip = screen.getByRole("button", { name: "Open routine Routine" });
  expect(chip.element().previousSibling?.textContent).toBe("Routine ");
  expect(chip.element().nextSibling?.textContent).toBe(" paused");
});
