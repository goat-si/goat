import { ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  canEdit: false,
  historySupported: false,
  revision: 0,
  readHistory: vi.fn(),
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
    connection: { phase: mocks.historySupported ? "connected" : "disconnected" },
    serverConfig: {
      environment: {
        capabilities: { goatBotProfileEdit: true, goatBotTaskThreadsPaged: mocks.historySupported },
      },
    },
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
    revision: mocks.revision,
    supported: true,
    loaded: mocks.threads.loaded,
    failed: mocks.threads.failed,
    failure: mocks.threads.failure,
    turnsWaiting: mocks.turnsWaiting,
    chips: new Map(),
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
    listBotThreadsPage: { execute: mocks.readHistory },
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
    homeCurrentOpenableWorkAtom: () => Atom.make({ eligible: false, list: "pending", links: [] }),
    slackSettings: () => null,
  },
}));
import { GoatBotWorkPanel } from "./GoatBotWorkPanel";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";

function setup(tasks: unknown[], turnsWaiting: string[] = [], rows: unknown[] = []) {
  resetTaskReadAcknowledgementsForTests();
  mocks.canEdit = false;
  mocks.historySupported = false;
  mocks.revision = 0;
  mocks.readHistory.mockReset();
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
it("records the originating Home row in the history entry before opening its task", async () => {
  setup([], [], [runningTask]);
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      peekRows={() => []}
    />,
  );
  const router = screen.router;
  if (!router) throw new Error("missing router");
  await userEvent.click(screen.getByRole("button", { name: /^Stop the port 3774 server/ }));
  await userEvent.click(screen.getByRole("link", { name: "Go to thread" }));
  router.history.back();
  await vi.waitFor(() =>
    expect(router.state.location.state.goatBotOpenHome).toEqual({
      key: JSON.stringify(["env", null]),
      taskId: "task-a",
    }),
  );
});

it("marks and scrolls the returned row, restoring focus only when it has not moved", async () => {
  setup([], [], [runningTask]);
  const focusFrom = document.body;
  using scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      homeReturn={{ taskId: ChannelTaskId.make("task-a"), focusFrom }}
    />,
  );
  const row = screen.getByRole("link", { name: /^Stop the port 3774 server/ });
  await expect.element(row).toHaveFocus();
  expect(row.element().closest("[data-home-return]")?.getAttribute("data-home-return")).toBe(
    "true",
  );
  // A screen reader hears which row Back returned to, where a sighted person sees the highlight.
  await expect.element(row).toHaveAccessibleName(/Where you left off$/);
  expect(scroll).toHaveBeenCalled();
});
it("does not move focus after it leaves the Back location and falls back to the Work heading for a missing row", async () => {
  setup([], [], []);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  try {
    await using screen = await render(
      <GoatBotWorkPanel
        onOpenFile={() => {}}
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        homeReturn={{ taskId: ChannelTaskId.make("gone"), focusFrom: document.body }}
      />,
    );
    await expect.element(screen.getByRole("heading", { name: "Work" })).toBeVisible();
    expect(document.activeElement).toBe(outside);
  } finally {
    outside.remove();
  }
});

it("does not take focus that moved to the page after Back left it on an element", async () => {
  setup([], [], [runningTask]);
  const focusFrom = document.createElement("button");
  document.body.append(focusFrom);
  using _scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  try {
    focusFrom.focus();
    focusFrom.blur();
    expect(document.activeElement).toBe(document.body);
    await using screen = await render(
      <GoatBotWorkPanel
        onOpenFile={() => {}}
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        homeReturn={{ taskId: ChannelTaskId.make("task-a"), focusFrom }}
      />,
    );
    const row = screen.getByRole("link", { name: /^Stop the port 3774 server/ });
    await expect.element(row).toBeVisible();
    expect(document.activeElement).toBe(document.body);
  } finally {
    focusFrom.remove();
  }
});

it("uses Back's return once: a later peek of the same task returns focus to its row and drops the mark", async () => {
  setup([], [], [runningTask]);
  const focusFrom = document.createElement("button");
  document.body.append(focusFrom);
  using _scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const consumed = vi.fn();
  try {
    focusFrom.focus();
    await using screen = await render(
      <GoatBotWorkPanel
        onOpenFile={() => {}}
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("bot")}
        peekRows={() => []}
        homeReturn={{ taskId: ChannelTaskId.make("task-a"), focusFrom }}
        onHomeReturnConsumed={consumed}
      />,
    );
    const row = screen.getByRole("button", { name: /^Stop the port 3774 server/ });
    await expect.element(row).toHaveFocus();
    await userEvent.click(row);
    await userEvent.click(
      screen.getByRole("button", { name: "Back to Home from Stop the port 3774 server" }),
    );
    const again = screen.getByRole("button", { name: /^Stop the port 3774 server/ });
    await expect.element(again).toHaveFocus();
    expect(again.element().closest("[data-home-return]")).toBeNull();
    await expect.element(again).not.toHaveAccessibleName(/Where you left off/);
    expect(consumed).toHaveBeenCalledTimes(1);
  } finally {
    focusFrom.remove();
  }
});

it("focuses the Work heading if the returned task no longer exists", async () => {
  setup([], [], []);
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await using screen = await render(
    <GoatBotWorkPanel
      onOpenFile={() => {}}
      environmentId={EnvironmentId.make("env")}
      threadId={ThreadId.make("bot")}
      homeReturn={{ taskId: ChannelTaskId.make("gone"), focusFrom: document.body }}
    />,
  );
  await expect.element(screen.getByRole("heading", { name: "Work" })).toHaveFocus();
});
