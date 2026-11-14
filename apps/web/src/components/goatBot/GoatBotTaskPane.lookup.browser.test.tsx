import {
  BotProfile,
  ChannelGatewayError,
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
  listLoaded: true,
  listFailed: false,
  listPending: false,
  listEstablished: true,
  canUpdate: true,
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
  useAtomValue: (atom: unknown) => (atom === "update-permission" ? state.canUpdate : true),
}));
vi.mock("~/localApi", async (original) => ({
  ...(await original<typeof import("~/localApi")>()),
  readLocalApi: () => ({ contextMenu: { show: state.showMenu } }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    getBotTask: { permissionAtom: () => null },
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
vi.mock("./useBotRoster", () => ({
  useBotThreads: (_environmentId: string, bot: { botId: string } | null) => {
    state.lists.push(bot?.botId ?? null);
    return {
      rows: state.noRows
        ? []
        : [
            decodeBotThreadRow({
              kind: "task",
              task: {
                taskId: "task-1",
                title: bot === null ? "Review work" : "Find sources",
                status: state.row.status,
                updatedAt: "2026-11-04T10:00:00.000Z",
                ...(state.row.generation === undefined ? {} : { generation: state.row.generation }),
              },
              view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
              lastActivityAt: "2026-11-04T10:00:00.000Z",
              unread: state.row.unread,
              mainMessagesSinceQuiet: 0,
            }),
          ],
      remoteWork: [],
      established: state.listEstablished,
      loaded: state.listLoaded,
      pending: state.listPending,
      failed: state.listFailed,
      chips: new Map(),
      refresh: state.refresh,
    };
  },
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
import { GoatBotTaskPane } from "./GoatBotTaskPane";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";
import { useGoatBotSession } from "./useGoatBotSession";

function Pane({ onClose, taskId = "task-1" }: { onClose: () => void; taskId?: string }) {
  const session = useGoatBotSession();
  return (
    <GoatBotTaskPane
      environmentId={EnvironmentId.make("env")}
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
  state.listLoaded = true;
  state.listPending = false;
  state.listEstablished = true;
  state.listFailed = false;
  state.canUpdate = true;
  state.lookupSupported = false;
  state.lookup.mockReset();
  state.showMenu.mockReset();
  state.showMenu.mockResolvedValue(null);
  resetTaskReadAcknowledgementsForTests();
  state.send.mockClear();
  state.update.mockClear();
  state.session.mockClear();
}

const decodeProfile = Schema.decodeSync(BotProfile);

it("looks up an older task on a capable server and shows its actions", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: {
        state: "known",
        row: decodeBotThreadRow({
          kind: "task",
          task: {
            taskId: "task-1",
            title: "Recovered task",
            status: "completed",
            updatedAt: "2026-11-04T10:00:00.000Z",
          },
          view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
          lastActivityAt: "2026-11-04T10:00:00.000Z",
          unread: false,
          mainMessagesSinceQuiet: 0,
        }),
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: true,
      partial: false,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Recovered task" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark done" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark read" })).toBeDisabled();
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Some threads are listed in Threads.")).toBeVisible();
  await expect.element(screen.getByText("Show work")).toBeVisible();
  expect(state.lookup).toHaveBeenCalledWith({
    environmentId: "env",
    input: { taskId: "task-1", botId: "main" },
  });
});

it("disables view-dependent actions when a task view is unavailable", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: {
        state: "unavailable",
        task: {
          taskId: "task-1",
          title: "Unavailable view",
          status: "completed",
          updatedAt: "2026-11-04T10:00:00.000Z",
        },
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: true,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Unavailable view" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Pin" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Mark read" })).toBeDisabled();
  expect(state.update).not.toHaveBeenCalled();
});

it("does not look up a bare task on an older server", async () => {
  setup();
  state.noRows = true;
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Task thread" })).toBeVisible();
  expect(state.lookup).not.toHaveBeenCalled();
});

it("reports a task that cannot be found here", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new ChannelGatewayError({ reason: "not_found" })),
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("This task cannot be found here.")).toBeVisible();
});

it("rereads once more for an action made while a reread is running", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  const result = (title: string) => ({
    _tag: "Success",
    value: {
      task: {
        state: "known",
        row: decodeBotThreadRow({
          kind: "task",
          task: {
            taskId: "task-1",
            title,
            status: "completed",
            updatedAt: "2026-11-04T10:00:00.000Z",
          },
          view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
          lastActivityAt: "2026-11-04T10:00:00.000Z",
          unread: false,
          mainMessagesSinceQuiet: 0,
        }),
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  });
  let finish!: (value: ReturnType<typeof result>) => void;
  const late = new Promise<ReturnType<typeof result>>((resolve) => {
    finish = resolve;
  });
  state.lookup.mockResolvedValueOnce(result("First"));
  state.lookup.mockReturnValueOnce(late);
  state.lookup.mockResolvedValueOnce(result("Newest"));
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "First" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Pin" }));
  await vi.waitFor(() => expect(state.lookup).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
  expect(state.lookup).toHaveBeenCalledTimes(2);
  await act(() => finish(result("Outdated")));
  await expect.element(screen.getByRole("heading", { name: "Newest" })).toBeVisible();
  expect(state.lookup).toHaveBeenCalledTimes(3);
});

it("looks up a member's older task under that member", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: {
        state: "unavailable",
        task: {
          taskId: "task-1",
          title: "Member task",
          status: "running",
          updatedAt: "2026-11-04T10:00:00.000Z",
        },
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: true,
    },
  });
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
    <GoatBotMemberContext value={member}>
      <Pane onClose={() => {}} />
    </GoatBotMemberContext>,
  );
  await expect.element(screen.getByRole("heading", { name: "Member task" })).toBeVisible();
  expect(state.lookup).toHaveBeenCalledWith({
    environmentId: "env",
    input: { taskId: "task-1", botId: "research" },
  });
});

it("forgets the old lookup view when the task leaves and re-enters the list", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  const oldRow = decodeBotThreadRow({
    kind: "task",
    task: {
      taskId: "task-1",
      title: "Older lookup",
      status: "running",
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  if (oldRow.kind !== "task") throw new Error("Expected a task row");
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  state.lookup.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      task: { state: "known", row: oldRow },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  });
  state.lookup.mockReturnValueOnce(pending);
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Older lookup" })).toBeVisible();
  state.noRows = false;
  state.row.unread = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Review work" })).toBeVisible();
  state.noRows = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "Pin", exact: true }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Mark done" }).query()).toBeNull();
  const newRow = decodeBotThreadRow({
    ...oldRow,
    task: { ...oldRow.task, title: "New lookup" },
    view: {
      ...oldRow.view,
      pinnedAt: "2026-11-04T10:00:00.000Z",
      doneAt: "2026-11-04T10:00:00.000Z",
    },
  });
  await act(() =>
    finish({
      _tag: "Success",
      value: {
        task: { state: "known", row: newRow },
        codingRows: [],
        remoteWork: [],
        launchesTruncated: false,
        partial: false,
      },
    }),
  );
  await expect.element(screen.getByRole("heading", { name: "New lookup" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Unpin" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Reopen" })).toBeVisible();
});

it("deduplicates explicit Mark read while automatic acknowledgement is in flight", async () => {
  setup();
  state.lookupSupported = true;
  state.row.unread = true;
  let finish!: (value: { _tag: string }) => void;
  const pending = new Promise<{ _tag: string }>((resolve) => {
    finish = resolve;
  });
  state.update.mockImplementationOnce(() => pending);
  await using screen = await render(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
  expect(state.update).toHaveBeenCalledTimes(1);
  await act(() => finish({ _tag: "Success" }));
});

it("does not add Mark read to a listed task on an older server", async () => {
  setup();
  state.row.unread = false;
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Review work" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Mark read" }).query()).toBeNull();
});

it("does not reuse an old view when switching away from and back to a task", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  const row = decodeBotThreadRow({
    kind: "task",
    task: {
      taskId: "task-1",
      title: "Old view",
      status: "running",
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  state.lookup.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      task: { state: "known", row },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  });
  state.lookup.mockReturnValue(new Promise(() => {}));
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Old view" })).toBeVisible();
  await screen.rerender(<Pane taskId="task-2" onClose={() => {}} />);
  await screen.rerender(<Pane taskId="task-1" onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "Pin", exact: true }).query()).toBeNull();
});

it("waits for the current task list before looking up a task", async () => {
  setup();
  state.noRows = true;
  state.listLoaded = false;
  state.listEstablished = false;
  state.lookupSupported = true;
  state.lookup.mockReturnValue(new Promise(() => {}));
  await using screen = await render(<Pane onClose={() => {}} />);
  expect(state.lookup).not.toHaveBeenCalled();
  state.noRows = false;
  state.listLoaded = true;
  state.listEstablished = true;
  state.row.unread = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Review work" })).toBeVisible();
  expect(state.lookup).not.toHaveBeenCalled();
});

it("does not look up a task when its current list failed", async () => {
  setup();
  state.noRows = true;
  state.listLoaded = false;
  state.listEstablished = false;
  state.listFailed = true;
  state.lookupSupported = true;
  state.lookup.mockReturnValue(new Promise(() => {}));
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Task thread" })).toBeVisible();
  expect(state.lookup).not.toHaveBeenCalled();
});

it("retries a failed task lookup and shows its result", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
  state.lookup.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      task: {
        state: "unavailable",
        task: {
          taskId: "task-1",
          title: "Recovered after retry",
          status: "running",
          updatedAt: "2026-11-04T10:00:00.000Z",
        },
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: true,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Couldn't load this task.");
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  await expect
    .element(screen.getByRole("heading", { name: "Recovered after retry" }))
    .toBeVisible();
});

it("disables view actions for a looked-up task without mutation permission", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.canUpdate = false;
  const row = decodeBotThreadRow({
    kind: "task",
    task: {
      taskId: "task-1",
      title: "Read only",
      status: "running",
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread: true,
    mainMessagesSinceQuiet: 0,
  });
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: { state: "known", row },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Read only" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Pin" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Mark done" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Mark read" })).toBeDisabled();
  expect(state.update).not.toHaveBeenCalled();
});

it("returns to the older-server pane when lookup capability is withdrawn", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: {
        state: "unavailable",
        task: {
          taskId: "task-1",
          title: "Lookup title",
          status: "running",
          updatedAt: "2026-11-04T10:00:00.000Z",
        },
      },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: true,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Lookup title" })).toBeVisible();
  state.lookupSupported = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Task thread" })).toBeVisible();
  expect(state.lookup).toHaveBeenCalledOnce();
});

it("shows lookup loading and does not retry a permission refusal", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  let finish!: (value: unknown) => void;
  state.lookup.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading task…");
  await act(() =>
    finish({
      _tag: "Failure",
      cause: Cause.fail(new ChannelGatewayError({ reason: "forbidden" })),
    }),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Permission to read this task is unavailable.");
  expect(screen.getByRole("button", { name: "Try again" }).query()).toBeNull();
});

it("keeps an older task during a list refresh and rereads only after an action settles", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  const row = decodeBotThreadRow({
    kind: "task",
    task: {
      taskId: "task-1",
      title: "Older task",
      status: "running",
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
    lastActivityAt: "2026-11-04T10:00:00.000Z",
    unread: false,
    mainMessagesSinceQuiet: 0,
  });
  state.lookup.mockResolvedValue({
    _tag: "Success",
    value: {
      task: { state: "known", row },
      codingRows: [],
      remoteWork: [],
      launchesTruncated: false,
      partial: false,
    },
  });
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("heading", { name: "Older task" })).toBeVisible();
  state.lookup.mockClear();
  state.listPending = true;
  state.listLoaded = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  expect(screen.getByRole("heading", { name: "Older task" }).query()).not.toBeNull();
  expect(screen.getByRole("button", { name: "Pin" }).query()).not.toBeNull();
  state.listPending = false;
  state.listLoaded = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  expect(state.lookup).not.toHaveBeenCalled();
  state.refresh.mockImplementationOnce(() => {
    state.listPending = true;
    state.listLoaded = false;
  });
  await userEvent.click(screen.getByRole("button", { name: "Pin" }));
  await screen.rerender(<Pane onClose={() => {}} />);
  expect(state.lookup).not.toHaveBeenCalled();
  state.listPending = false;
  state.listLoaded = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  await vi.waitFor(() => expect(state.lookup).toHaveBeenCalledTimes(1));
});

it("retries a failed lookup when Try again is pressed during a list refresh", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.lookup.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
  state.lookup.mockReturnValue(new Promise(() => {}));
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Couldn't load this task.");
  state.listPending = true;
  await screen.rerender(<Pane onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.lookup).toHaveBeenCalledTimes(2);
});

it("shows Home guidance while the first list read is pending", async () => {
  setup();
  state.noRows = true;
  state.lookupSupported = true;
  state.listLoaded = false;
  state.listEstablished = false;
  state.listPending = true;
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect
    .element(screen.getByText("Status and actions for older work are in GOAT Bot's Home."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open Home" })).toBeVisible();
  expect(state.lookup).not.toHaveBeenCalled();
});
