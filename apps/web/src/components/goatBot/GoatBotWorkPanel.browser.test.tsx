import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type BotProfile,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  canEdit: false,
  tasks: [] as unknown[],
  routinesError: null as string | null,
  routinesLoaded: true,
  rows: [] as unknown[],
  threads: { loaded: true, failed: false, failure: null as unknown },
  refreshThreads: vi.fn(),
  refreshRoutines: vi.fn(),
  setEnabled: vi.fn(),
  updateTaskView: vi.fn(),
  turnsWaiting: [] as string[],
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
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
    failure: mocks.threads.failure,
    turnsWaiting: mocks.turnsWaiting,
    refresh: mocks.refreshThreads,
  }),
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
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
vi.mock("~/state/server", async (original) => {
  const real = await original<typeof import("~/state/server")>();
  return {
    ...real,
    serverEnvironment: {
      ...real.serverEnvironment,
      scheduledTasksLive: () => null,
      upsertScheduledTask: { permissionAtom: () => Atom.make(false), execute: vi.fn() },
      setScheduledTaskEnabled: { permissionAtom: () => Atom.make(true), execute: mocks.setEnabled },
      runScheduledTaskNow: { permissionAtom: () => Atom.make(true), execute: vi.fn() },
    },
  };
});
vi.mock("./GoatBotStatusCard", () => ({ GoatBotStatusCard: () => null }));
vi.mock("./GoatBotTimeline", async () => ({
  GoatBotActivityContext: (await import("react")).createContext(null),
  GoatBotTimeline: () => <p>Task conversation</p>,
}));
// A member's hero is the real avatar, so its picture is what a person sees.
vi.mock("./GoatBotAvatar", async (original) => ({
  ...(await original<typeof import("./GoatBotAvatar")>()),
  GoatBotMainAvatar: () => <span data-goat-main-avatar />,
}));
vi.mock("./useGoatBotMemberStatus", () => ({
  useGoatBotMemberWaitingCount: () => 0,
  useGoatBotMemberStatus: () => ({ waitingCount: 0, latest: undefined }),
}));
vi.mock("./GoatBotSuggested", () => ({ GoatBotSuggested: () => null }));
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
    updateTaskView: {
      permissionAtom: () => Atom.make(true),
      execute: mocks.updateTaskView,
    },
    listChildWork: () => null,
    remoteWorkOpenable: () => Atom.make(false),
    slackSettings: () => null,
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
  mocks.threads = { loaded: true, failed: false, failure: null };
  mocks.routinesError = null;
  mocks.routinesLoaded = true;
  mocks.refreshThreads.mockReset();
  mocks.refreshRoutines.mockReset();
  mocks.setEnabled.mockReset();
  mocks.updateTaskView.mockReset();
  mocks.updateTaskView.mockResolvedValue({ _tag: "Success" });
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

const routine = (index: number) => ({
  ...digest,
  id: `routine-${index}`,
  title: `Routine ${index}`,
  threadId: "bot",
});

it("closes the pinned panel from its own Close button", async () => {
  setup([]);
  const onClose = vi.fn();
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      onOpenFile={() => {}}
      onClose={onClose}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps Home scrolled where it was through Show more and a peek", async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    ...runningTask,
    task: {
      ...runningTask.task,
      taskId: `task-${index}`,
      title: `Done ${index}`,
      status: "completed",
    },
  }));
  setup([], [], tasks);
  // A short window, so Home really overflows and keeps a scroll position to restore.
  await using screen = await render(
    <div className="flex h-64">
      <GoatBotWorkPanel
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        onOpenFile={() => {}}
        peekRows={() => []}
      />
    </div>,
  );
  const home = screen.getByRole("tabpanel").element();
  expect(home.scrollHeight).toBeGreaterThan(home.clientHeight);
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  await expect.element(screen.getByText("Done 6")).toBeVisible();
  const row = screen.getByRole("button", { name: /^Done 6/ }).element();
  if (!(row instanceof HTMLButtonElement)) throw new Error("Expected a task button");
  // Scrolled so the last row shows, as it must for a person to open it.
  row.scrollIntoView({ block: "nearest" });
  home.dispatchEvent(new Event("scroll", { bubbles: true }));
  const scrolled = home.scrollTop;
  expect(scrolled).toBeGreaterThan(0);
  row.click();
  await expect
    .element(screen.getByRole("button", { name: /Back to Home from Done 6/ }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Back to Home from Done 6/ }));
  // The expanded tail is still there, and Home comes back to the row the peek was opened from.
  await expect.element(screen.getByRole("button", { name: /^Done 6/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^Done 6/ })).toHaveFocus();
  const back = screen.getByRole("tabpanel").element();
  expect(back.scrollTop).toBe(scrolled);
});

it("opens the routine a chip names even when it sits behind Show more", async () => {
  setup([routine(1), routine(2), routine(3), routine(4), routine(5), routine(6), routine(7)]);
  const landing = { routineId: "routine-7", seq: 1, from: null };
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      onOpenFile={() => {}}
      routineLanding={landing}
    />,
  );
  await expect.element(screen.getByText("Routine 7")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: /Routine 7/ })).toHaveFocus();
});

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
        onClose={() => {}}
      />
    );
    await using screen = await render(
      role === "main" ? (
        <GoatBotMainProfileContext value={bot}>{panel}</GoatBotMainProfileContext>
      ) : (
        <GoatBotMemberContext value={bot}>{panel}</GoatBotMemberContext>
      ),
    );
    await expect.element(screen.getByRole("button", { name: "Close" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Edit bot" }));
    await expect.element(screen.getByRole("dialog", { name: "" })).toBeVisible();
  },
);

it("shows a member's own initial on its colour in the Home hero, not the main bot's face", async () => {
  setup([]);
  const bot = {
    botId: "rose",
    role: "member",
    name: "New bot 2",
    avatar: null,
    color: "#BE185D",
    environmentId: EnvironmentId.make("env"),
    sessionThreadId: ThreadId.make("member-thread"),
  } as unknown as BotProfile;
  await using screen = await render(
    <GoatBotMemberContext value={bot}>
      <GoatBotWorkPanel
        environmentId={bot.environmentId}
        threadId={ThreadId.make("member-thread")}
        onOpenFile={() => {}}
      />
    </GoatBotMemberContext>,
  );
  await expect.element(screen.getByRole("heading", { name: "New bot 2" })).toBeVisible();
  await expect.element(screen.getByText("N", { exact: true })).toBeVisible();
});

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
  await expect.element(screen.getByText("No recent tasks")).toBeVisible();
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
  const back = screen.getByRole("button", { name: /Back to Home from Stop the port 3774 server/ });
  await expect.element(back).toHaveFocus();
  await expect
    .element(screen.getByRole("link", { name: "Go to thread" }))
    .toHaveAttribute("href", expect.stringContaining("task=task-a"));
  await expect.element(screen.getByText("Working")).toBeVisible();
  await expect.element(screen.getByRole("tab", { name: "Home" })).not.toBeInTheDocument();
  await userEvent.click(back);
  await expect
    .element(screen.getByRole("button", { name: /^Stop the port 3774 server/ }))
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
  await expect.element(screen.getByRole("button", { name: /Back to Home from/ })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("button", { name: /^Stop the port 3774 server/ }))
    .toHaveFocus();
});

/** A finished task whose last activity is the given hour of 9 November. */
const finishedTask = (id: string, hour: number) => {
  const when = `2026-11-09T${String(hour).padStart(2, "0")}:00:00.000Z`;
  return {
    ...runningTask,
    task: { taskId: id, title: `Finished ${id}`, status: "completed", updatedAt: when },
    view: { taskId: id, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: when,
  };
};

it("Back returns focus to a peeked row that newer finished work pushed behind Show more, and shows it", async () => {
  setup([], [], [finishedTask("target", 10)]);
  const panel = () => (
    // A short panel, so the row's new place is below the scroll Home returns to.
    <div className="flex h-96 flex-col">
      <GoatBotWorkPanel
        onOpenFile={() => {}}
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        peekRows={() => []}
      />
    </div>
  );
  await using screen = await render(panel());
  await userEvent.click(screen.getByRole("button", { name: /^Finished target/ }));
  const back = screen.getByRole("button", { name: /Back to Home from Finished target/ });
  await expect.element(back).toHaveFocus();
  // Five tasks finish while the peek is open, so the peeked one is now sixth.
  mocks.rows = [11, 12, 13, 14, 15]
    .map((hour) => finishedTask(`newer-${hour}`, hour))
    .concat([finishedTask("target", 10)]);
  await screen.rerender(panel());
  await userEvent.click(screen.getByRole("button", { name: /Back to Home from Finished target/ }));
  const target = screen.getByRole("button", { name: /^Finished target/ });
  await expect.element(target).toHaveFocus();
  await expect.element(target).toBeInViewport();
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
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
  await expect.element(screen.getByText("No recent tasks")).toBeVisible();
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
  const composer = screen.getByRole("textbox", { name: "Message GOAT Bot" });
  await userEvent.click(composer);
  await userEvent.keyboard("still typing");
  setup([]);
  await screen.rerender(panel());
  await expect.element(screen.getByText("No recent tasks")).toBeVisible();
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
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
  await expect.element(screen.getByRole("button", { name: /Back to Home from/ })).toHaveFocus();
  // Text takes no focus, so the click leaves it on the page body, outside the peek.
  await userEvent.click(screen.getByText("Here is what I found"));
  expect(document.activeElement).toBe(document.body);
  setup([]);
  await screen.rerender(panel());
  await expect.element(screen.getByText("No recent tasks")).toBeVisible();
  await expect.element(screen.getByRole("tab", { name: "Home" })).not.toHaveFocus();
  expect(document.activeElement).toBe(document.body);
});

it("says the task list is loading, not empty, before the first read answers", async () => {
  setup([]);
  mocks.threads = { loaded: false, failed: false, failure: undefined };
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Loading tasks…")).toBeVisible();
  await expect.element(screen.getByText("No recent tasks")).not.toBeInTheDocument();
});

it("a failed task read offers a retry and keeps the tasks it already knew", async () => {
  setup([], [], [runningTask]);
  mocks.threads = { loaded: false, failed: true, failure: undefined };
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
  mocks.threads = { loaded: false, failed: true, failure: undefined };
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
    />,
  );
  await expect.element(screen.getByText("Couldn't load GOAT Bot's tasks.")).toBeVisible();
  await expect.element(screen.getByText("No recent tasks")).not.toBeInTheDocument();
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
  const rowActions = screen.getByRole("button", { name: "Actions for Stop the port 3774 server" });
  await userEvent.click(rowActions);
  await userEvent.click(page.getByRole("menuitem", { name: "Show work" }));
  // The menu hands focus back to the button that opened it.
  await expect.element(rowActions).toHaveFocus();
  const links = screen.getByRole("link", { name: "Open work thread" });
  await expect.element(links.nth(0)).toHaveAttribute("href", "/env/channel-worker%3Aa");
  await expect.element(links.nth(1)).toHaveAttribute("href", "/env/channel-child-work%3Achore");
});

it("shows a denied task read from the roster without retry", async () => {
  setup([]);
  mocks.threads = {
    loaded: false,
    failed: true,
    failure: new EnvironmentAuthorizationError({
      message: "denied",
      requiredScope: "orchestration:read",
    }),
  };
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      onOpenFile={() => {}}
    />,
  );
  await expect.element(screen.getByText("This device can't read GOAT Bot's work.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("offers Back to chat on the sheet's Home and inside a peek", async () => {
  setup([], [], [runningTask]);
  const onShowChat = vi.fn();
  await using screen = await render(
    <GoatBotWorkPanel
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      onOpenFile={() => {}}
      onShowChat={onShowChat}
      peekRows={() => []}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Back to chat" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port/ }));
  await userEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  expect(onShowChat).toHaveBeenCalledOnce();
});
