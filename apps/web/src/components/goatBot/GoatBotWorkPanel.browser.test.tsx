import { EnvironmentId, ThreadId, type BotProfile } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  canEdit: false,
  tasks: [] as unknown[],
  routinesError: null as string | null,
  routinesLoaded: true,
  rows: [] as unknown[],
  threads: { loaded: true, failed: false },
  refreshThreads: vi.fn(),
  refreshRoutines: vi.fn(),
  setEnabled: vi.fn(),
  turnsWaiting: [] as string[],
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: "disconnected" },
    serverConfig: { environment: { capabilities: { goatBotProfileEdit: true } } },
  }),
}));
vi.mock("./GoatBotEditBotDialog", () => ({
  GoatBotEditBotDialog: () => <div role="dialog">Edit profile</div>,
}));
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({ rows: [] }),
  useBotThreads: () => ({
    rows: mocks.rows,
    remoteWork: [],
    supported: true,
    loaded: mocks.threads.loaded,
    failed: mocks.threads.failed,
    turnsWaiting: mocks.turnsWaiting,
    refresh: mocks.refreshThreads,
  }),
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => null,
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.routinesLoaded ? { tasks: mocks.tasks } : null,
    error: mocks.routinesError,
    failure: null,
    refresh: mocks.refreshRoutines,
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
vi.mock("./GoatBotTimeline", async () => ({
  GoatBotActivityContext: (await import("react")).createContext(null),
  GoatBotTimeline: () => <p>Task conversation</p>,
}));
vi.mock("./GoatBotAvatar", () => ({ GoatBotAvatar: () => null }));
vi.mock("./GoatBotComputer", () => ({ GoatBotComputer: () => <p>Machine list</p> }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { execute: typeof mocks.setEnabled }) => command.execute,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    updateBot: { permissionAtom: () => Atom.make(mocks.canEdit) },
    listBotNotes: () => null,
    listBotArtifacts: () => null,
    readBotArtifact: { execute: vi.fn() },
    listTasks: () => null,
  },
}));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";
import { GoatBotMainProfileContext, GoatBotMemberContext } from "./goatBotMemberContext";
import { navigationBlocked } from "~/lib/navigationHolds";

function setup(tasks: unknown[], turnsWaiting: string[] = [], rows: unknown[] = []) {
  mocks.canEdit = false;
  mocks.tasks = tasks;
  mocks.turnsWaiting = turnsWaiting;
  mocks.rows = rows;
  mocks.threads = { loaded: true, failed: false };
  mocks.routinesError = null;
  mocks.routinesLoaded = true;
  mocks.refreshThreads.mockReset();
  mocks.refreshRoutines.mockReset();
  mocks.setEnabled.mockReset();
}

const at = "2026-11-09T00:00:00.000Z";
const runningTask = {
  kind: "task",
  task: { taskId: "task-a", title: "Stop the port 3774 server", status: "running", updatedAt: at },
  view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
  lastActivityAt: at,
  unread: false,
  mainMessagesSinceQuiet: 0,
  worker: { environmentId: "env", threadId: "channel-worker:a" },
};
const digest = {
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
};

it.each(["main", "member"] as const)(
  "offers profile editing in the panel for an authorized %s bot",
  async (role) => {
    setup([]);
    mocks.canEdit = true;
    const bot = {
      botId: role,
      role,
      name: "Scout",
      environmentId: EnvironmentId.make("env"),
    } as BotProfile;
    const panel = (
      <GoatBotWorkPanel
        environmentId={bot.environmentId}
        threadId={ThreadId.make("bot")}
        onOpenFile={() => {}}
      />
    );
    await using screen = await render(
      role === "main" ? (
        <GoatBotMainProfileContext value={bot}>{panel}</GoatBotMainProfileContext>
      ) : (
        <GoatBotMemberContext value={bot}>{panel}</GoatBotMemberContext>
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    await expect.element(screen.getByRole("dialog", { name: "" })).toBeVisible();
  },
);

it("does not offer profile editing without permission", async () => {
  setup([]);
  const bot = {
    botId: "main",
    role: "main",
    name: "Scout",
    environmentId: EnvironmentId.make("env"),
  } as BotProfile;
  await using screen = await render(
    <GoatBotMainProfileContext value={bot}>
      <GoatBotWorkPanel
        environmentId={bot.environmentId}
        threadId={ThreadId.make("bot")}
        onOpenFile={() => {}}
      />
    </GoatBotMainProfileContext>,
  );
  expect(screen.container.querySelector("button[aria-label='Edit bot']")).toBeNull();
  expect(screen.container.textContent).not.toContain("Edit bot");
});

it("Home shows work and routines on one scroll, and Library holds files and memory", async () => {
  setup([]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("No tasks yet")).toBeVisible();
  await expect.element(screen.getByText("Ask GOAT Bot in chat to set up a routine.")).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await expect.element(screen.getByText("Notes need a newer GOAT server.")).toBeVisible();
  await expect.element(screen.getByText("Files need a newer GOAT server.")).toBeVisible();
});

it("keeps the machines on Home whether or not work runs", async () => {
  setup([]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByRole("heading", { name: "Machines" })).toBeVisible();
  await expect.element(screen.getByText("Machine list")).toBeVisible();
});

it("peeks at a task in the panel with one link to its thread, and Back returns to its row", async () => {
  setup([], [], [runningTask]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  const back = screen.getByRole("button", { name: /Back to Home from Stop the port 3774 server/ });
  await expect.element(back).toHaveFocus();
  await expect
    .element(screen.getByRole("link", { name: "Go to thread" }))
    .toHaveAttribute("href", expect.stringContaining("task=task-a"));
  await expect.element(screen.getByText("Working")).toBeVisible();
  await expect.element(screen.getByRole("tab", { name: "Home" })).not.toBeInTheDocument();
  await userEvent.click(back);
  await expect
    .element(screen.getByRole("button", { name: /Stop the port 3774 server/ }))
    .toHaveFocus();
  // The return applies once: coming back to Home from Library leaves focus on the tab.
  await userEvent.click(screen.getByRole("tab", { name: "Library" }));
  await userEvent.click(screen.getByRole("tab", { name: "Home" }));
  await expect.element(screen.getByRole("tab", { name: "Home" })).toHaveFocus();
});

it("a task peek holds back a New bot open until Back, since it has no URL of its own", async () => {
  setup([], [], [runningTask]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  expect(navigationBlocked()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  const back = screen.getByRole("button", { name: /Back to Home from Stop the port 3774 server/ });
  await expect.element(back).toBeVisible();
  expect(navigationBlocked()).toBe(true);
  await userEvent.click(back);
  expect(navigationBlocked()).toBe(false);
});

it("steps back from a peek to its row with Escape", async () => {
  setup([], [], [runningTask]);
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
      onOpenFile={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  await expect.element(screen.getByRole("button", { name: /Back to Home from/ })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("button", { name: /Stop the port 3774 server/ }))
    .toHaveFocus();
});

it("closes the peek when the task leaves the bot's work", async () => {
  setup([], [], [runningTask]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  setup([]);
  await screen.rerender(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  await expect.element(screen.getByRole("tab", { name: "Home" })).toBeVisible();
  await expect.element(screen.getByText("No tasks yet")).toBeVisible();
  // Focus was on Back, which is gone; it lands on Home instead of the page.
  await expect.element(screen.getByRole("tab", { name: "Home" })).toHaveFocus();
  // The task coming back does not reopen a peek nobody asked for.
  setup([], [], [runningTask]);
  await screen.rerender(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  await expect.element(screen.getByRole("tab", { name: "Home" })).toBeVisible();
});

it("leaves focus in the composer when a peeked task leaves the list", async () => {
  setup([], [], [runningTask]);
  const panel = () => (
    <>
      <textarea aria-label="Message GOAT Bot" />
      <GoatBotWorkPanel
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        peekRows={() => []}
        onOpenFile={() => {}}
      />
    </>
  );
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  const composer = screen.getByRole("textbox", { name: "Message GOAT Bot" });
  await userEvent.click(composer);
  await userEvent.keyboard("still typing");
  setup([]);
  await screen.rerender(panel());
  await expect.element(screen.getByText("No tasks yet")).toBeVisible();
  await expect.element(composer).toHaveFocus();
  await expect.element(composer).toHaveValue("still typing");
});

it("leaves focus where it was when a peeked task leaves the list after a click on chat text", async () => {
  setup([], [], [runningTask]);
  const panel = () => (
    <>
      <p>Here is what I found</p>
      <GoatBotWorkPanel
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        peekRows={() => []}
        onOpenFile={() => {}}
      />
    </>
  );
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: /Stop the port 3774 server/ }));
  await expect.element(screen.getByRole("button", { name: /Back to Home from/ })).toHaveFocus();
  // Text takes no focus, so the click leaves it on the page body, outside the peek.
  await userEvent.click(screen.getByText("Here is what I found"));
  expect(document.activeElement).toBe(document.body);
  setup([]);
  await screen.rerender(panel());
  await expect.element(screen.getByText("No tasks yet")).toBeVisible();
  await expect.element(screen.getByRole("tab", { name: "Home" })).not.toHaveFocus();
  expect(document.activeElement).toBe(document.body);
});

it("says the task list is loading, not empty, before the first read answers", async () => {
  setup([]);
  mocks.threads = { loaded: false, failed: false };
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Loading tasks…")).toBeVisible();
  await expect.element(screen.getByText("No tasks yet")).not.toBeInTheDocument();
});

it("a failed task read offers a retry and keeps the tasks it already knew", async () => {
  setup([], [], [runningTask]);
  mocks.threads = { loaded: false, failed: true };
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Couldn't load GOAT Bot's tasks.")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: /Stop the port 3774 server/ }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(mocks.refreshThreads).toHaveBeenCalledOnce();
});

it("a failed first task read never claims there are no tasks", async () => {
  setup([]);
  mocks.threads = { loaded: false, failed: true };
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Couldn't load GOAT Bot's tasks.")).toBeVisible();
  await expect.element(screen.getByText("No tasks yet")).not.toBeInTheDocument();
});

it("says routines are loading, not empty, before the first read answers", async () => {
  setup([]);
  mocks.routinesLoaded = false;
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Loading routines…")).toBeVisible();
  await expect.element(screen.getByText("No routines yet")).not.toBeInTheDocument();
});

it("a failed routine read offers a retry and keeps the routines it already knew", async () => {
  setup([digest]);
  mocks.routinesError = "Connection lost";
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Couldn't load routines.")).toBeVisible();
  await expect.element(screen.getByText("Daily at 09:00 · Not scheduled")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(mocks.refreshRoutines).toHaveBeenCalledOnce();
});

it("New routine stays offered while the routine list cannot be read", async () => {
  setup([]);
  mocks.routinesLoaded = false;
  mocks.routinesError = "Connection lost";
  const onDraft = vi.fn<(text: string) => void>();
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      onDraft={onDraft}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Couldn't load routines.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "New routine" }));
  expect(onDraft).toHaveBeenCalledWith("Set up a routine: ");
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
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={environmentId}
      threadId={ThreadId.make("bot")}
    />,
  );
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
      onOpenFile={() => {}}
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
it("opens the worker and the chores that thread lists leave to the bot from its task", async () => {
  const at = "2026-11-09T00:00:00.000Z";
  setup(
    [],
    [],
    [
      {
        kind: "task",
        task: {
          taskId: "task-a",
          title: "Stop the port 3774 server",
          status: "running",
          updatedAt: at,
        },
        view: { taskId: "task-a", pinnedAt: null, doneAt: null, readThrough: null },
        lastActivityAt: at,
        unread: false,
        mainMessagesSinceQuiet: 0,
        worker: { environmentId: "env", threadId: "channel-worker:a" },
      },
      {
        kind: "coding",
        taskId: "task-a",
        environmentId: "env",
        threadId: "channel-child-work:chore",
        title: "Stop goat serve",
        state: "bound",
        lastActivityAt: at,
        workKind: "chore",
      },
    ],
  );
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect
    .element(screen.getByRole("link", { name: /Stop the port 3774 server/ }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show work" }));
  const links = screen.getByRole("link", { name: "Open work thread" });
  await expect.element(links.nth(0)).toHaveAttribute("href", "/env/channel-worker%3Aa");
  await expect.element(links.nth(1)).toHaveAttribute("href", "/env/channel-child-work%3Achore");
});
