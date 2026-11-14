import {
  BotId,
  BotProfile,
  BotThreadRow,
  ChannelTaskId,
  type ChannelTaskStatus,
  EnvironmentId,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { type ReactNode } from "react";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  noRows: false,
  listTasks: [] as ReadonlyArray<string>,
  listEstablished: true,
  listLoaded: true,
  listFailed: false,
  listPending: false,
  canUpdate: true,
  canRead: true,
  lookupSupported: false,
  lookup: vi.fn(),
  showMenu: vi.fn(),
  send: vi.fn(() => true),
  // One command function serves both commands; a retry is told apart by its clientRequestId.
  update: vi.fn(async (call?: { readonly input?: { readonly clientRequestId?: string } }) =>
    call?.input?.clientRequestId === undefined ? { _tag: "Success" } : state.retryResult,
  ),
  retryResult: {
    _tag: "Success",
    value: { status: "started", taskId: "task-1", generation: 3 },
  } as { _tag: string; value: Record<string, unknown> },
  row: { status: "waiting_input", generation: undefined, unread: true } as {
    status: ChannelTaskStatus;
    generation: number | undefined;
    unread: boolean;
  },
  supportsRetry: true,
  refresh: vi.fn(),
  session: vi.fn(),
  lists: [] as Array<string | null>,
  rows: [] as ReadonlyArray<GoatBotRow>,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === "update-permission"
      ? state.canUpdate
      : atom === "read-permission"
        ? state.canRead
        : true,
}));
vi.mock("~/localApi", async (original) => ({
  ...(await original<typeof import("~/localApi")>()),
  readLocalApi: () => ({ contextMenu: { show: state.showMenu } }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    getBotTask: { permissionAtom: () => "read-permission" },
    updateTaskView: { permissionAtom: () => "update-permission" },
    retryTask: { permissionAtom: () => null },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === channelEnvironment.getBotTask ? state.lookup : state.update,
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "env",
        { environment: { capabilities: { goatBotTaskLookupSearch: state.lookupSupported } } },
      ],
      ["env-2", { environment: { capabilities: { goatBotTaskLookupSearch: true } } }],
    ]),
  useThreadShell: () => ({}),
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("~/hooks/useResizableWidth", () => ({
  RESIZABLE_WIDTH_PROPERTY: "--resizable-width",
  useResizableWidth: () => ({ width: 480, handlers: {} }),
}));
vi.mock("./GoatBotWorkDetails", () => ({
  GoatBotWorkDetails: () => null,
  GoatBotUnavailableWork: () => null,
}));
vi.mock("./GoatBotStepsProvider", () => ({
  GoatBotStepsProvider: ({ children }: { children: ReactNode }) => children,
  GoatBotStepsReader: ({ children }: { children: ReactNode }) => children,
}));
const decodeBotThreadRow = Schema.decodeSync(BotThreadRow);
// The task's questions keep their real card, so a pick goes through the pane's send.
vi.mock("./GoatBotTimeline", async () => {
  const { GoatBotQuestionCard } = await import("./GoatBotQuestionCard");
  return {
    GoatBotTimeline: (props: {
      readonly rows: ReadonlyArray<GoatBotRow>;
      readonly onPick?: (answer: string, taskId?: string, questionId?: string) => void;
    }) => (
      <div>
        Task timeline
        {props.rows.map((row) =>
          row.kind === "bot" ? (
            <GoatBotQuestionCard key={row.id} row={row} body={row.text} onPick={props.onPick} />
          ) : null,
        )}
      </div>
    ),
  };
});
// Each bot's own task list: main's, or the member's when a member's pane is open.
// The bot's last successful list holds exactly state.listTasks.
vi.mock("./useBotRoster", () => ({
  useBotThreads: () => ({
    rows: state.listTasks.map((taskId) => taskRow(taskId, `Listed ${taskId}`)),
    remoteWork: [],
    established: state.listEstablished,
    loaded: state.listLoaded,
    pending: state.listPending,
    failed: state.listFailed,
    refresh: state.refresh,
  }),
}));
vi.mock("./useGoatBotSession", () => ({
  useGoatBotSession: (_items: unknown, taskId: string) => {
    state.session(taskId);
    return {
      availability: { kind: "ready", bot: { environmentId: "env", threadId: "bot-thread" } },
      canOperate: true,
      supportsTaskRetry: state.supportsRetry,
      visibleTurnItems: [],
      rowsForTask: (id: string) => {
        state.session(id);
        return state.rows;
      },
      attachmentSupport: null,
      onSendToTask: state.send,
      onRetryInput: () => {},
      onDiscardInput: () => {},
    };
  },
}));
import { channelEnvironment } from "~/state/channels";
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { useBotTaskLookup } from "./useBotTaskLookup";
import { GoatBotTaskPane } from "./GoatBotTaskPane";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";
import { useGoatBotSession } from "./useGoatBotSession";

function Pane({
  onClose,
  taskId = "task-1",
  environmentId = "env",
}: {
  onClose: () => void;
  taskId?: string;
  environmentId?: string;
}) {
  const session = useGoatBotSession();
  return (
    <GoatBotTaskPane
      environmentId={EnvironmentId.make(environmentId)}
      session={session}
      taskId={ChannelTaskId.make(taskId)}
      narrow
      onClose={onClose}
    />
  );
}

/** Resets the shared acknowledgement record and the mocks this test reads. */
function setup() {
  state.noRows = false;
  state.listTasks = [];
  state.listEstablished = true;
  state.refresh.mockReset();
  calls.length = 0;
  state.lookupSupported = true;
  state.listLoaded = true;
  state.listPending = false;
  state.listFailed = false;
  state.canUpdate = true;
  state.canRead = true;
  state.lookup.mockReset();
  state.lookup.mockImplementation(
    (call: {
      readonly environmentId: string;
      readonly input: { readonly taskId: string; readonly botId: string };
    }) =>
      new Promise((resolve) =>
        calls.push({
          environmentId: call.environmentId,
          taskId: call.input.taskId,
          botId: call.input.botId,
          answer: (title, unread) => resolve(found(call.input.taskId, title, unread)),
          fail: () => resolve({ _tag: "Failure", cause: Cause.fail(new Error("offline")) }),
        }),
      ),
  );
  state.showMenu.mockReset();
  state.showMenu.mockResolvedValue(null);
  resetTaskReadAcknowledgementsForTests();
  state.send.mockClear();
  state.update.mockClear();
  state.session.mockClear();
}

const decodeProfile = Schema.decodeSync(BotProfile);

type Read = {
  environmentId: string;
  taskId: string;
  botId: string;
  answer: (title: string, unread?: boolean) => void;
  fail: () => void;
};
const calls: Array<Read> = [];

function taskRow(taskId: string, title: string, unread = false) {
  return decodeBotThreadRow({
    kind: "task",
    task: { taskId, title, status: "running", updatedAt: "2026-11-04T10:00:00.000Z" },
    view: { taskId, pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread,
    mainMessagesSinceQuiet: 0,
  });
}

function found(taskId: string, title: string, unread = false) {
  return {
    _tag: "Success",
    value: {
      task: { state: "known", row: taskRow(taskId, title, unread) },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  };
}

/** The pane on task-1, its lookup answered, and Pin starting a refresh that stays in flight. */
async function openOlderTask() {
  setup();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(<Pane onClose={() => {}} />));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Older task"));
  await expect.element(screen.getByRole("heading", { name: "Older task" })).toBeVisible();
  state.refresh.mockImplementation(() => {
    state.listPending = true;
  });
  return { screen, stack: stack.move() };
}

it("waits for a refresh before reading a task opened during it, then reads it once", async () => {
  const opened = await openOlderTask();
  await using _stack = opened.stack;
  state.listPending = true;
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  expect(calls.map((call) => call.taskId)).toEqual(["task-1"]);
  state.listPending = false;
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await vi.waitFor(() => expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-2"]));
  await act(() => calls[1]?.answer("Second task"));
  await expect.element(opened.screen.getByRole("heading", { name: "Second task" })).toBeVisible();
  expect(calls).toHaveLength(2);
});

it("uses the row for a task the refresh returns and never reads it", async () => {
  const opened = await openOlderTask();
  await using _stack = opened.stack;
  state.listPending = true;
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  state.listPending = false;
  state.listTasks = ["task-2"];
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await expect.element(opened.screen.getByRole("heading", { name: "Listed task-2" })).toBeVisible();
  expect(calls.map((call) => call.taskId)).toEqual(["task-1"]);
});

it("keeps the view through a failed refresh after an action and rereads once it settles", async () => {
  const opened = await openOlderTask();
  await using _stack = opened.stack;
  await userEvent.click(opened.screen.getByRole("button", { name: "Pin" }));
  await opened.screen.rerender(<Pane onClose={() => {}} />);
  expect(calls).toHaveLength(1);
  state.listPending = false;
  state.listFailed = true;
  await opened.screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(opened.screen.getByRole("heading", { name: "Older task" })).toBeVisible();
  await vi.waitFor(() => expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-1"]));
  await act(() => calls[1]?.answer("Older task, pinned"));
  await expect
    .element(opened.screen.getByRole("heading", { name: "Older task, pinned" }))
    .toBeVisible();
  expect(calls).toHaveLength(2);
});

it("does not carry an action's reread to a task opened before its refresh settled", async () => {
  const opened = await openOlderTask();
  await using _stack = opened.stack;
  await userEvent.click(opened.screen.getByRole("button", { name: "Pin" }));
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  state.listPending = false;
  await opened.screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await vi.waitFor(() => expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-2"]));
  await act(() => calls[1]?.answer("Second task"));
  await expect.element(opened.screen.getByRole("heading", { name: "Second task" })).toBeVisible();
  expect(calls).toHaveLength(2);
});

it("sends one read for two immediate presses of Try again", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.fail());
  const button = screen.getByRole("button", { name: "Try again" });
  await expect.element(button).toBeVisible();
  await act(() => {
    button.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(calls).toHaveLength(2);
});

it("lets the newer of two reads for one task win and stays loading until it ends", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() =>
    expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-2", "task-1"]),
  );
  await act(() => calls[0]?.answer("Older answer"));
  await expect.element(screen.getByText("Loading task…")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Older answer" }).query()).toBeNull();
  expect(calls).toHaveLength(3);
  await act(() => calls[2]?.answer("Newer answer"));
  await expect.element(screen.getByRole("heading", { name: "Newer answer" })).toBeVisible();
  expect(calls).toHaveLength(3);
});

function Lookup({ refreshing }: { refreshing: boolean }) {
  const lookup = useBotTaskLookup(
    EnvironmentId.make("env"),
    ChannelTaskId.make("task-1"),
    BotId.make("main"),
    { established: true, refreshing, holdsTask: false },
    true,
  );
  return (
    <>
      <button onClick={() => lookup.complete(lookup.key)}>Action completed</button>
      {lookup.error === "failed" && <button onClick={() => lookup.retry()}>Try again</button>}
    </>
  );
}

it("counts Try again during a refresh as the reread a pending action asked for", async () => {
  setup();
  await using screen = await render(<Lookup refreshing={false} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.fail());
  await screen.rerender(<Lookup refreshing />);
  await userEvent.click(screen.getByRole("button", { name: "Action completed" }));
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(calls).toHaveLength(2);
  await act(() => calls[1]?.answer("Older task"));
  await screen.rerender(<Lookup refreshing={false} />);
  expect(calls).toHaveLength(2);
});

it("ignores a read that outlived leaving the task for a listed one and coming back", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  state.listTasks = ["task-2"];
  await screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Listed task-2" })).toBeVisible();
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-1"]));
  await act(() => calls[0]?.answer("Answer from before"));
  await expect.element(screen.getByText("Loading task…")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Answer from before" }).query()).toBeNull();
  await act(() => calls[1]?.answer("Answer from now"));
  await expect.element(screen.getByRole("heading", { name: "Answer from now" })).toBeVisible();
});

it("ignores a read that outlived the task entering and leaving the list", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  state.listTasks = ["task-1"];
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Listed task-1" })).toBeVisible();
  state.listTasks = [];
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[0]?.answer("Answer from before"));
  expect(screen.getByRole("heading", { name: "Answer from before" }).query()).toBeNull();
  await act(() => calls[1]?.answer("Answer from now"));
  await expect.element(screen.getByRole("heading", { name: "Answer from now" })).toBeVisible();
});

it("reports no error when a read answers after the pane unmounted", async () => {
  setup();
  using errors = vi.spyOn(console, "error");
  {
    await using _screen = await render(<Pane onClose={() => {}} />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  }
  await act(() => calls[0]?.answer("Too late"));
  expect(errors).not.toHaveBeenCalled();
});

it("shows only dev's pane when the capability goes with a read pending, and reads once on return", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("Loading task…")).toBeVisible();
  state.lookupSupported = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect
    .element(screen.getByText("Status and actions for older work are in GOAT Bot's Home."))
    .toBeVisible();
  expect(screen.getByText("Loading task…").query()).toBeNull();
  await act(() => calls[0]?.answer("Answer from before"));
  expect(screen.getByRole("heading", { name: "Answer from before" }).query()).toBeNull();
  state.lookupSupported = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Answer from now"));
  await expect.element(screen.getByRole("heading", { name: "Answer from now" })).toBeVisible();
});

/** An update the test settles itself, for actions and acknowledgements still on their way. */
function holdUpdate() {
  let settle!: () => void;
  state.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = () => resolve({ _tag: "Success" });
      }),
  );
  return () => act(() => settle());
}

it("rereads once after a listed task action completes during a later refresh", async () => {
  setup();
  state.listTasks = ["task-1"];
  const pinned = holdUpdate();
  state.refresh.mockImplementation(() => {
    state.listPending = true;
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Pin" }));
  state.refresh();
  await screen.rerender(<Pane onClose={() => {}} />);
  state.listPending = false;
  state.listTasks = [];
  state.refresh();
  await screen.rerender(<Pane onClose={() => {}} />);
  await pinned();
  expect(state.refresh).toHaveBeenCalledTimes(3);
  expect(calls).toHaveLength(0);
  state.listPending = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Refreshed task"));
  await expect.element(screen.getByRole("heading", { name: "Refreshed task" })).toBeVisible();
  expect(calls).toHaveLength(1);
});

it("reads once when a refresh fails and the last list lacks the task", async () => {
  setup();
  state.listPending = true;
  await using screen = await render(<Pane onClose={() => {}} />);
  expect(calls).toHaveLength(0);
  state.listPending = false;
  state.listFailed = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Task after failure"));
  await expect.element(screen.getByRole("heading", { name: "Task after failure" })).toBeVisible();
  expect(calls).toHaveLength(1);
});

it("keeps the held new-period answer when an ended-period read answers later", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  state.listTasks = ["task-1"];
  await screen.rerender(<Pane onClose={() => {}} />);
  state.listTasks = [];
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Current answer"));
  await expect.element(screen.getByRole("heading", { name: "Current answer" })).toBeVisible();
  await act(() => calls[0]?.answer("Expired answer"));
  await expect.element(screen.getByRole("heading", { name: "Current answer" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Expired answer" }).query()).toBeNull();
  expect(calls).toHaveLength(2);
});

it("drops a late acknowledgement for the same task id in another environment", async () => {
  setup();
  const acknowledged = holdUpdate();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Unread task", true));
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  await screen.rerender(<Pane environmentId="env-2" onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Other environment's task"));
  await acknowledged();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(calls.map((call) => call.environmentId)).toEqual(["env", "env-2"]);
});

it("drops a late acknowledgement for the same task id under another bot", async () => {
  setup();
  const acknowledged = holdUpdate();
  const member = decodeProfile({
    botId: "research",
    role: "member",
    name: "Research",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: "thread-research",
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
  });
  await using screen = await render(
    <GoatBotMemberContext value={null}>
      <Pane onClose={() => {}} />
    </GoatBotMemberContext>,
  );
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Unread task", true));
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  await screen.rerender(
    <GoatBotMemberContext value={member}>
      <Pane onClose={() => {}} />
    </GoatBotMemberContext>,
  );
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Member's task"));
  await acknowledged();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(calls.map((call) => call.botId)).toEqual(["main", "research"]);
});

it("refreshes and rereads once when an acknowledgement for the open task completes", async () => {
  setup();
  const acknowledged = holdUpdate();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Unread task", true));
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  await acknowledged();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Read task"));
  await expect.element(screen.getByRole("heading", { name: "Read task" })).toBeVisible();
  expect(calls).toHaveLength(2);
});

it("drops an action that completes after the pane moved to another task", async () => {
  setup();
  const pinned = holdUpdate();
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await act(() => calls[0]?.answer("Older task"));
  await userEvent.click(screen.getByRole("button", { name: "Pin" }));
  await screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  await act(() => calls[1]?.answer("Second task"));
  await pinned();
  expect(state.refresh).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("heading", { name: "Second task" })).toBeVisible();
  expect(calls.map((call) => call.taskId)).toEqual(["task-1", "task-2"]);
});

it("shows no loading line when read permission goes with a read pending", async () => {
  setup();
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("Loading task…")).toBeVisible();
  state.canRead = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect
    .element(screen.getByText("Permission to read this task is unavailable."))
    .toBeVisible();
  expect(screen.getByText("Loading task…").query()).toBeNull();
  await act(() => calls[0]?.answer("Answer from before"));
  expect(screen.getByRole("heading", { name: "Answer from before" }).query()).toBeNull();
});

it("drops an acknowledgement that completes after the pane unmounted", async () => {
  setup();
  const acknowledged = holdUpdate();
  {
    await using _screen = await render(<Pane onClose={() => {}} />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await act(() => calls[0]?.answer("Unread task", true));
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  }
  await acknowledged();
  expect(state.refresh).not.toHaveBeenCalled();
});
