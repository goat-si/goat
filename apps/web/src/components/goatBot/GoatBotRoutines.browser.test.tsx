import type { BotRoutineSource } from "@goat/client-runtime/scheduledTasks";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ScheduledTaskId,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), setEnabled: vi.fn(), runNow: vi.fn() }));
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
    runScheduledTaskNow: { permissionAtom: () => Atom.make(true), execute: mocks.runNow },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.upsert }) => command.execute,
}));
import { GoatBotRoutines } from "./GoatBotRoutines";
import { navigationBlocked } from "~/lib/navigationHolds";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("bot");

function setup() {
  mocks.upsert.mockReset();
  mocks.setEnabled.mockReset();
  mocks.runNow.mockReset();
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
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
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
      onRetry={() => {}}
    />,
  );
  await expect.element(screen.getByText("Weekdays at 09:00 · Not scheduled")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Check in on me" }))
    .not.toBeInTheDocument();
});

it("the check-in form holds back a New bot open while it is open", async () => {
  setup();
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
  );
  expect(navigationBlocked()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await expect.element(screen.getByRole("form", { name: "Check in on me" })).toBeVisible();
  expect(navigationBlocked()).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(navigationBlocked()).toBe(false);
});

it("a refused save keeps the check-in form open and shows why", async () => {
  setup();
  mocks.upsert.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Check in on me" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't save the check-in: Denied");
  await expect.element(screen.getByRole("form", { name: "Check in on me" })).toBeVisible();
});

const failedRoutine: BotRoutineSource = {
  ...savedCheckIn,
  id: ScheduledTaskId.make("routine:failed"),
  title: "Morning digest",
  lastRunAt: "2026-11-07T08:00:00.000Z",
  lastRunStatus: "failed",
  lastRunError: "Provider exited with code 1",
};
const fineRoutine: BotRoutineSource = {
  ...savedCheckIn,
  id: ScheduledTaskId.make("routine:fine"),
  title: "Evening digest",
  lastRunAt: "2026-11-07T08:00:00.000Z",
  lastRunStatus: "succeeded",
};

it("offers Run now only for a routine whose last run failed, one run per tap", async () => {
  setup();
  mocks.runNow.mockResolvedValue(AsyncResult.success({ task: failedRoutine }));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[failedRoutine, fineRoutine]}
      error={null}
      onRetry={() => {}}
    />,
  );
  const runNow = screen.getByRole("button", { name: "Run now" });
  await expect.element(runNow).toBeVisible();
  expect(screen.getByRole("button", { name: "Run now" }).elements()).toHaveLength(1);
  await userEvent.click(runNow);
  await vi.waitFor(() => expect(mocks.runNow).toHaveBeenCalledOnce());
  expect(mocks.runNow).toHaveBeenCalledWith({
    environmentId,
    input: { id: "routine:failed" },
  });
});

it("a refused Run now says why", async () => {
  setup();
  mocks.runNow.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Busy"))));
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={[failedRoutine]}
      error={null}
      onRetry={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Run now" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't run this routine: Busy");
});

it("explains denied and offline routine reads without offering retry", async () => {
  setup();
  const denied = new EnvironmentAuthorizationError({
    message: "no",
    requiredScope: "orchestration:read",
  });
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={null}
      error="denied"
      failure={denied}
      onRetry={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("This device can't read GOAT Bot's routines."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("explains offline routine reads without offering retry", async () => {
  setup();
  await using screen = await render(
    <GoatBotRoutines
      environmentId={environmentId}
      threadId={threadId}
      tasks={null}
      error="offline"
      offline
      onRetry={() => {}}
    />,
  );
  await expect
    .element(screen.getByText("Routines are unavailable while GOAT Bot's computer is offline."))
    .toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});
