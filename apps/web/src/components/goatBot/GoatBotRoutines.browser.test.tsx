import type { BotRoutineSource } from "@goat/client-runtime/scheduledTasks";
import { EnvironmentId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), setEnabled: vi.fn() }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({
    id: "bot",
    projectId: "bot-project",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: () => Atom.make(true), execute: mocks.upsert },
    setScheduledTaskEnabled: { permissionAtom: () => Atom.make(true), execute: mocks.setEnabled },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.upsert }) => command.execute,
}));
import { GoatBotRoutines } from "./GoatBotRoutines";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("bot");

function setup() {
  mocks.upsert.mockReset();
  mocks.setEnabled.mockReset();
}

const savedCheckIn: BotRoutineSource = {
  id: ScheduledTaskId.make("goat-bot-check-in:bot"),
  title: "Check in",
  prompt: "Look over my open work",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  threadId,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
};

it("Check in on me saves a weekday-morning routine in the bot's chat, then stops offering", async () => {
  setup();
  mocks.upsert.mockResolvedValue(AsyncResult.success({ task: savedCheckIn }));
  await using screen = await render(
    <GoatBotRoutines environmentId={environmentId} threadId={threadId} tasks={[]} error={null} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.upsert).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      title: "Check in",
      threadId: "bot",
      projectId: "bot-project",
      notificationPolicy: "important_updates",
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      creationSource: "web",
    }),
  });
  await expect
    .element(screen.getByRole("form", { name: "Check in on me" }))
    .not.toBeInTheDocument();
  await screen.rerender(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[savedCheckIn]}
      error={null}
    />,
  );
  await expect.element(screen.getByText("Weekdays at 09:00 · Not scheduled")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Check in on me" }))
    .not.toBeInTheDocument();
});

it("a refused save keeps the check-in form open and shows why", async () => {
  setup();
  mocks.upsert.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  await using screen = await render(
    <GoatBotRoutines environmentId={environmentId} threadId={threadId} tasks={[]} error={null} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't save the check-in: Denied");
  await expect.element(screen.getByRole("form", { name: "Check in on me" })).toBeVisible();
});
