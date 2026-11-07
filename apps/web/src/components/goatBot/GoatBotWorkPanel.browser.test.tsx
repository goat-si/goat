import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  tasks: [] as unknown[],
  setEnabled: vi.fn(),
  turnsWaiting: [] as string[],
}));
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({ rows: [] }),
  useBotThreads: () => ({
    rows: [],
    supported: true,
    loaded: true,
    failed: false,
    turnsWaiting: mocks.turnsWaiting,
    refresh: () => {},
  }),
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { tasks: mocks.tasks },
    error: null,
    failure: null,
    refresh: () => {},
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => null,
    upsertScheduledTask: { permissionAtom: () => Atom.make(false), execute: vi.fn() },
    setScheduledTaskEnabled: { permissionAtom: () => Atom.make(true), execute: mocks.setEnabled },
    runScheduledTaskNow: { permissionAtom: () => Atom.make(true), execute: vi.fn() },
  },
}));
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.setEnabled }) => command.execute,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    listBotNotes: () => null,
    listBotArtifacts: () => null,
    readBotArtifact: { execute: vi.fn() },
    listTasks: () => null,
  },
}));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";

function setup(tasks: unknown[], turnsWaiting: string[] = []) {
  mocks.tasks = tasks;
  mocks.turnsWaiting = turnsWaiting;
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
  await userEvent.click(screen.getByRole("tab", { name: "Memory" }));
  await expect.element(screen.getByText("Notes need a newer GOAT server.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await expect.element(screen.getByText("Files need a newer GOAT server.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Computer" }));
  await expect.element(screen.getByText("No work is running right now.")).toBeVisible();
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

it("points to the chat when the bot asked a question there that no task thread shows", async () => {
  setup([], ["turn-1"]);
  const onShowChat = vi.fn();
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      onShowChat={onShowChat}
    />,
    { router: "/bot?task=old" },
  );
  await expect
    .element(screen.getByText("GOAT Bot is waiting for your answer in the chat", { exact: false }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("link", { name: "Open the chat" }));
  expect(onShowChat).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/bot"));
  expect(screen.router?.state.location.search).toEqual({});
});
