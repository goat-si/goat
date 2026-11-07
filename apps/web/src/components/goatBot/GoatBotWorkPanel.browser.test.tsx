import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ tasks: [] as unknown[], setEnabled: vi.fn() }));
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({ rows: [] }),
  useBotThreads: () => ({ rows: [], loaded: true, refresh: () => {} }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks }, error: null }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => null,
    setScheduledTaskEnabled: { permissionAtom: () => Atom.make(true), execute: mocks.setEnabled },
  },
}));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.setEnabled }) => command.execute,
}));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";

function setup(tasks: unknown[]) {
  mocks.tasks = tasks;
  mocks.setEnabled.mockReset();
}

it("shows the empty state for each work tab", async () => {
  setup([]);
  await using screen = await render(
    <GoatBotWorkPanel environmentId={EnvironmentId.make("env")} threadId={ThreadId.make("bot")} />,
  );
  await expect
    .element(screen.getByText("No task threads yet. Ask GOAT Bot to start work."))
    .toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Routines" }));
  await expect.element(screen.getByText("Ask GOAT Bot in chat to set up a routine.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await expect.element(screen.getByText("Files GOAT Bot saves will appear here.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Computer" }));
  await expect
    .element(screen.getByText("Machines GOAT Bot works on will appear here."))
    .toBeVisible();
});

it("a refused pause keeps the routine's stored state and shows why", async () => {
  setup([
    {
      id: "digest",
      title: "Daily digest",
      prompt: "Summarize the inbox",
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
      threadId: "bot",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
    },
  ]);
  mocks.setEnabled.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Denied"))));
  const environmentId = EnvironmentId.make("env");
  await using screen = await render(
    <GoatBotWorkPanel environmentId={environmentId} threadId={ThreadId.make("bot")} />,
  );
  await userEvent.click(screen.getByRole("tab", { name: "Routines" }));
  await expect.element(screen.getByText("Daily at 09:00 · Not scheduled")).toBeVisible();
  const toggle = screen.getByRole("switch", { name: "Pause Daily digest" });
  await userEvent.click(toggle);
  expect(mocks.setEnabled).toHaveBeenCalledWith({
    environmentId,
    input: { id: "digest", enabled: false },
  });
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Couldn't pause this routine: Denied");
  await expect.element(toggle).toHaveAttribute("aria-checked", "true");
});
