import {
  BotProfile,
  BotThreadRow,
  ChannelTaskId,
  type ChannelTaskStatus,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  noRows: false,
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
  realTimeline: false,
  sourceIdentity: "first" as string | null,
  baseline: new Set<string>(),
  sources: new Set<string>(),
}));
vi.mock("./useGoatBotSource", () => ({
  useGoatBotSource: () => ({ baselineIds: state.baseline, sourceIds: state.sources }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/localApi", async (original) => ({
  ...(await original<typeof import("~/localApi")>()),
  readLocalApi: () => ({ contextMenu: { show: state.showMenu } }),
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    updateTaskView: { permissionAtom: () => null },
    retryTask: { permissionAtom: () => null },
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () => new Map(),
  useThreadShell: () => ({}),
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("~/hooks/useResizableWidth", () => ({
  RESIZABLE_WIDTH_PROPERTY: "--resizable-width",
  useResizableWidth: () => ({ width: 480, handlers: {} }),
}));
vi.mock("./GoatBotWorkDetails", () => ({ GoatBotWorkDetails: () => null }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("./GoatBotAvatar", () => ({
  GoatBotAvatar: () => null,
  GoatBotMainAvatar: () => null,
  GoatBotSessionAvatar: () => null,
}));
vi.mock("./GoatBotStepsProvider", () => ({
  GoatBotStepsProvider: ({ children }: { children: ReactNode }) => children,
  GoatBotStepsReader: ({ children }: { children: ReactNode }) => children,
}));
const decodeBotThreadRow = Schema.decodeSync(BotThreadRow);
// The task's questions keep their real card, so a pick goes through the pane's send.
vi.mock("./GoatBotTimeline", async (original) => {
  const { GoatBotQuestionCard } = await import("./GoatBotQuestionCard");
  const actual = await original<typeof import("./GoatBotTimeline")>();
  return {
    GoatBotActivityContext: actual.GoatBotActivityContext,
    GoatBotTimeline: (props: {
      readonly rows: ReadonlyArray<GoatBotRow>;
      readonly onPick?: (answer: string, taskId?: string, questionId?: string) => void;
      readonly submissions?: ReadonlyArray<{ readonly key: string }>;
    }) =>
      state.realTimeline ? (
        <actual.GoatBotTimeline {...props} onRetry={() => {}} />
      ) : (
        <div data-submissions={props.submissions?.map((send) => send.key).join(",")}>
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
      source: {
        identity: state.sourceIdentity,
        baselineIds: state.baseline,
        sourceIds: state.sources,
      },
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
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotTaskPane } from "./GoatBotTaskPane";
import { goatBotHomeKey } from "./goatBotHomeRequest";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";
import { GoatBotChatView } from "./GoatBotChatView";
import { useGoatBotSession } from "./useGoatBotSession";

function Pane({ onClose }: { onClose: () => void }) {
  const session = useGoatBotSession();
  return (
    <GoatBotTaskPane
      environmentId={EnvironmentId.make("env")}
      session={session}
      taskId={ChannelTaskId.make("task-1")}
      narrow
      onClose={onClose}
    />
  );
}

it("does not pass an earlier source's submission to the same task in a new source", async () => {
  state.sourceIdentity = "first";
  state.send.mockReturnValueOnce("old-key" as never);
  using _cleanup = {
    [Symbol.dispose]: () => {
      state.sourceIdentity = "first";
    },
  };
  await using screen = await render(<Pane onClose={() => {}} />);
  await userEvent.type(screen.getByPlaceholder("Message GOAT Bot"), "hello{Enter}");
  expect(
    screen.container.querySelector("[data-submissions]")?.getAttribute("data-submissions"),
  ).toBe("old-key");
  state.sourceIdentity = "second";
  await screen.rerender(<Pane onClose={() => {}} />);
  expect(
    screen.container.querySelector("[data-submissions]")?.getAttribute("data-submissions"),
  ).toBe("");
});

it("does not jump a new source when an earlier task submission appears later", async () => {
  state.sourceIdentity = "first";
  state.realTimeline = true;
  state.send.mockReturnValueOnce("old-key" as never);
  using _cleanup = {
    [Symbol.dispose]: () => {
      state.sourceIdentity = "first";
      state.realTimeline = false;
      state.rows = [];
    },
  };
  const rows: Array<Extract<GoatBotRow, { kind: "user" }>> = Array.from({ length: 40 }, (_, i) => ({
    kind: "user",
    id: `history-${i}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${i}`,
    createdAt: "2026-11-04T10:00:00.000Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  state.rows = rows;
  const view = () => (
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <Pane onClose={() => {}} />
    </div>
  );
  await using screen = await render(view());
  await userEvent.type(screen.getByPlaceholder("Message GOAT Bot"), "hello{Enter}");
  state.sourceIdentity = "second";
  await screen.rerender(view());
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  state.rows = [
    ...rows,
    {
      ...rows[0]!,
      kind: "user",
      id: "pending:old-key",
      sendKey: "old-key",
      requestKey: null,
      text: "hello",
      delivery: { state: "sending" },
      showReceipt: false,
    },
  ];
  await screen.rerender(view());
  expect(scroll.scrollTop).toBe(0);
});

it("does not cue a historical result revealed in a task pane, but cues a new result", async () => {
  state.realTimeline = true;
  using _cleanup = {
    [Symbol.dispose]: () => {
      state.realTimeline = false;
      state.rows = [];
    },
  };
  const rows: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `m-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-11-04T10:00:00.000Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const bot = (id: string): GoatBotRow => ({
    kind: "bot",
    id,
    text: id,
    tone: "reply",
    proactive: false,
    replyTo: null,
    options: [],
    createdAt: "2026-11-04T10:00:00.000Z",
    firstInGroup: true,
    groupPosition: "single",
  });
  state.rows = rows;
  state.baseline = new Set([...rows.map((row) => row.id), "history"]);
  state.sources = new Set(state.baseline);
  await using screen = await render(
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <Pane onClose={() => {}} />
    </div>,
  );
  const scroll = screen.container.querySelector<HTMLElement>(".goat-timeline > div")!;
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  state.rows = [...rows, bot("history")];
  await screen.rerender(
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <Pane onClose={() => {}} />
    </div>,
  );
  expect(screen.container.textContent).not.toContain("Jump to latest");
  state.sources = new Set([...state.sources, "new"]);
  state.rows = [...state.rows, bot("new")];
  await screen.rerender(
    <div style={{ display: "flex", height: 400, width: 360 }}>
      <Pane onClose={() => {}} />
    </div>,
  );
  expect(screen.container.textContent).toContain("Jump to latest");
});

function TwoTaskPanes() {
  const [answered, setAnswered] = useState(false);
  const original = useGoatBotSession();
  const question: Extract<GoatBotRow, { kind: "bot" }> = {
    kind: "bot",
    id: "question",
    text: "Which option?",
    createdAt: "2026-11-04T10:00:00.000Z",
    tone: "question",
    proactive: false,
    replyTo: null,
    options: answered ? [] : ["Keep", "Change"],
    choices: ["Keep", "Change"],
    answerTaskId: "task-1",
    answerQuestionId: "q1",
    firstInGroup: true,
    groupPosition: "single",
    ...(answered
      ? {
          answer: "Keep",
          answerIndex: 0,
          answerSending: true,
          answerInputRowId: "pending:pane-send",
        }
      : {}),
  };
  const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `message-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-11-04T10:00:00.000Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const shown = [...messages.slice(0, 10), question, ...messages.slice(10)];
  const session = {
    ...original,
    rowsForTask: () => shown,
    onSendToTask: () => {
      setAnswered(true);
      return "pane-send";
    },
  } as unknown as ReturnType<typeof useGoatBotSession>;
  return (
    <div style={{ display: "flex", height: 400, width: 720 }}>
      <GoatBotTaskPane
        environmentId={EnvironmentId.make("env")}
        session={session}
        taskId={ChannelTaskId.make("task-1")}
        narrow
        onClose={() => {}}
      />
      <GoatBotTaskPane
        environmentId={EnvironmentId.make("env")}
        session={session}
        taskId={ChannelTaskId.make("task-1")}
        narrow
        onClose={() => {}}
      />
    </div>
  );
}

function MainAndTaskPane() {
  const [answered, setAnswered] = useState(false);
  const original = useGoatBotSession();
  const question: Extract<GoatBotRow, { kind: "bot" }> = {
    kind: "bot",
    id: "question",
    text: "Which option?",
    createdAt: "2026-11-04T10:00:00.000Z",
    tone: "question",
    proactive: false,
    replyTo: null,
    options: answered ? [] : ["Keep", "Change"],
    choices: ["Keep", "Change"],
    answerTaskId: "task-1",
    answerQuestionId: "q1",
    firstInGroup: true,
    groupPosition: "single",
    ...(answered
      ? {
          answer: "Keep",
          answerIndex: 0,
          answerSending: true,
          answerInputRowId: "pending:main-send",
        }
      : {}),
  };
  const messages: GoatBotRow[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "user",
    id: `message-${index}`,
    sendKey: null,
    requestKey: null,
    text: `Message ${index}`,
    createdAt: "2026-11-04T10:00:00.000Z",
    firstInGroup: true,
    groupPosition: "single",
    delivery: { state: "delivered" },
    showReceipt: false,
  }));
  const shown = [...messages.slice(0, 10), question, ...messages.slice(10)];
  const send = () => {
    setAnswered(true);
    return "main-send";
  };
  const session = {
    ...original,
    rowsForTask: () => shown,
    onSendToTask: send,
  } as unknown as ReturnType<typeof useGoatBotSession>;
  const environmentId = EnvironmentId.make("env");
  return (
    <div style={{ display: "flex", height: 400, width: 720 }}>
      <GoatBotChatView
        environmentId={environmentId}
        availability={{ kind: "ready", bot: { environmentId, threadId: ThreadId.make("bot") } }}
        canOperate
        rows={shown}
        onSend={send}
        onSendToTask={send}
        onRetryInput={() => {}}
        legacyAgentRoute={null}
      />
      <GoatBotTaskPane
        environmentId={environmentId}
        session={session}
        taskId={ChannelTaskId.make("task-1")}
        narrow
        onClose={() => {}}
      />
    </div>
  );
}

it("failing-first: answering a task question in main chat leaves its task pane in place", async () => {
  state.realTimeline = true;
  using _timeline = {
    [Symbol.dispose]: () => {
      state.realTimeline = false;
    },
  };
  await using screen = await render(<MainAndTaskPane />);
  const scrollers = [
    ...screen.container.querySelectorAll<HTMLElement>(".goat-timeline > div:first-child"),
  ];
  expect(scrollers).toHaveLength(2);
  await act(() => {
    for (const scroll of scrollers) {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    }
  });
  const questions = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-bot-row="question"]'),
  ];
  const pick = [...questions[0]!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Keep"),
  )!;
  await act(() => pick.click());
  expect(questions[0]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scrollers[0]!.getBoundingClientRect().bottom + 1,
  );
  expect(scrollers[1]!.scrollTop).toBe(0);
});

it("failing-first: a task-pane answer follows its own folded question without moving another pane", async () => {
  setup();
  state.realTimeline = true;
  using _timeline = {
    [Symbol.dispose]: () => {
      state.realTimeline = false;
    },
  };
  await using screen = await render(<TwoTaskPanes />);
  const panes = [...screen.container.querySelectorAll<HTMLElement>('[data-task-pane="task-1"]')];
  expect(panes).toHaveLength(2);
  const scrollers = panes.map((pane) => pane.querySelector<HTMLElement>(".goat-timeline > div")!);
  await act(() => {
    for (const scroll of scrollers) {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    }
  });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message GOAT Bot" }).nth(0),
    "Keep{Enter}",
  );
  const anchor = panes[0]!.querySelector<HTMLElement>('[data-bot-row="question"]')!;
  expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    scrollers[0]!.getBoundingClientRect().bottom + 1,
  );
  expect(scrollers[1]!.scrollTop).toBe(0);
  expect(document.activeElement).toBe(panes[0]!.querySelector("textarea"));
});

/** Resets the shared acknowledgement record and the mocks this test reads. */
function setup() {
  state.noRows = false;
  state.showMenu.mockReset();
  state.showMenu.mockResolvedValue(null);
  resetTaskReadAcknowledgementsForTests();
  state.send.mockClear();
  state.update.mockClear();
  state.session.mockClear();
}

it("opens the scoped task and acknowledges it, then sends and closes", async () => {
  setup();
  const close = vi.fn();
  await using screen = await render(<Pane onClose={close} />);
  await expect.element(screen.getByText("Review work")).toBeVisible();
  await expect.element(screen.getByText("Needs your input")).toBeVisible();
  expect(state.session).toHaveBeenCalledWith("task-1");
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "env",
    input: { taskId: "task-1", readThrough: "2026-11-04T10:00:00.000Z" },
  });
  await userEvent.type(screen.getByPlaceholder("Message GOAT Bot"), "hello{Enter}");
  expect(state.send).toHaveBeenCalledWith("task-1", "hello", []);
  await userEvent.click(screen.getByRole("button", { name: "Back to Tasks" }));
  expect(close).toHaveBeenCalledOnce();
});

/** The task view's rows while the test runs. */
const showingRows = (rows: ReadonlyArray<GoatBotRow>) => {
  state.rows = rows;
  return {
    [Symbol.dispose]: () => {
      state.rows = [];
    },
  };
};

it("answers its task's question with the question, picked or typed as something else (#2977)", async () => {
  state.send.mockClear();
  using _rows = showingRows([
    {
      kind: "bot",
      id: "b1",
      text: "Which cache should the build use?",
      createdAt: "2026-11-04T10:00:00.000Z",
      tone: "question",
      proactive: true,
      replyTo: null,
      options: ["Keep", "Clear"],
      choices: ["Keep", "Clear"],
      answerTaskId: "task-1",
      answerQuestionId: "q1",
      firstInGroup: true,
      groupPosition: "single",
    },
  ]);
  await using screen = await render(<Pane onClose={() => {}} />);
  await screen.getByRole("button", { name: "A. Keep" }).click();
  expect(state.send).toHaveBeenLastCalledWith("task-1", "Keep", [], "q1");
  await userEvent.type(screen.getByRole("textbox", { name: "Something else" }), "Both{Enter}");
  expect(state.send).toHaveBeenLastCalledWith("task-1", "Both", [], "q1");
});

const decodeProfile = Schema.decodeSync(BotProfile);
it("opens a member's task from that member's own list and marks it done there", async () => {
  state.update.mockClear();
  state.refresh.mockClear();
  state.lists = [];
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
      <Pane onClose={() => undefined} />
    </GoatBotMemberContext>,
  );
  await expect.element(screen.getByText("Find sources")).toBeVisible();
  await expect.element(screen.getByText("Review work")).not.toBeInTheDocument();
  expect(new Set(state.lists)).toEqual(new Set(["research"]));
  await expect.element(screen.getByPlaceholder("Message Research")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Mark done" }));
  await vi.waitFor(() =>
    expect(state.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { taskId: "task-1", done: true },
    }),
  );
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalled());
});

it("a deleted member's task link says it was deleted and sends nothing", async () => {
  state.send.mockClear();
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
    state: "deleted",
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
  });
  await using screen = await render(
    <GoatBotMemberContext value={member}>
      <Pane onClose={() => undefined} />
    </GoatBotMemberContext>,
  );
  const composer = screen.getByPlaceholder("Research was deleted");
  await expect.element(composer).toBeDisabled();
  expect(state.send).not.toHaveBeenCalled();
});

function resetRetry(status: ChannelTaskStatus, generation?: number) {
  state.update.mockClear();
  state.retryResult = {
    _tag: "Success",
    value: { status: "started", taskId: "task-1", generation: 3 },
  };
  state.refresh.mockClear();
  // Already read, so opening the pane refreshes nothing on its own.
  state.row = { status, generation, unread: false };
  state.supportsRetry = true;
}

it("retries a failed task from its pane, names the attempt and refreshes the list", async () => {
  resetRetry("failed", 2);
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("Failed · Attempt 2")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.update).toHaveBeenCalledOnce();
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "env",
    input: { taskId: "task-1", clientRequestId: expect.any(String) },
  });
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
});

it("shows why the server refused a retry", async () => {
  resetRetry("cancelled");
  state.retryResult = {
    _tag: "Success",
    value: { status: "refused", taskId: "task-1", reason: "still_running" },
  };
  await using screen = await render(<Pane onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The last attempt is still stopping. Try again in a moment.");
  expect(state.refresh).not.toHaveBeenCalled();
});

it("offers no retry for work still going or on a server without it", async () => {
  resetRetry("waiting_input");
  await using screen = await render(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("Review work")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  state.row = { status: "failed", generation: undefined, unread: false };
  state.supportsRetry = false;
  await screen.rerender(<Pane onClose={() => {}} />);
  await expect.element(screen.getByText("Failed")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});

it("uses the title carried from a history row when the current list no longer contains it", async () => {
  setup();
  state.noRows = true;
  const session = useGoatBotSession();
  await using screen = await render(
    <GoatBotTaskPane
      environmentId={EnvironmentId.make("env")}
      session={session}
      taskId={ChannelTaskId.make("task-1")}
      narrow
      onClose={() => {}}
      taskTitle="Older task"
    />,
  );
  await expect.element(screen.getByText("Older task")).toBeVisible();
  await expect.element(screen.getByText("Task thread")).not.toBeInTheDocument();
});

it("explains where to find actions for older work absent from the current list", async () => {
  setup();
  state.noRows = true;
  const session = useGoatBotSession();
  const close = vi.fn();
  await using screen = await render(
    <GoatBotTaskPane
      environmentId={EnvironmentId.make("env")}
      session={session}
      taskId={ChannelTaskId.make("task-1")}
      taskTitle="Older task"
      narrow
      onClose={close}
    />,
  );
  await expect.element(screen.getByText("Older task")).toBeVisible();
  await expect
    .element(screen.getByText("Status and actions for older work are in GOAT Bot's Home."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Pin", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Mark done" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Back to Tasks" }));
  expect(close).toHaveBeenCalledOnce();
});

it("Open Home from an older task goes to the bot's chat with its Home named in history state", async () => {
  setup();
  state.noRows = true;
  const session = useGoatBotSession();
  const close = vi.fn();
  await using screen = await render(
    <GoatBotTaskPane
      environmentId={EnvironmentId.make("env")}
      session={session}
      taskId={ChannelTaskId.make("task-1")}
      taskTitle="Older task"
      narrow
      onClose={close}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open Home" }));
  expect(close).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/bot-thread"));
  expect(screen.router?.state.location.state.goatBotOpenHome).toBe(
    goatBotHomeKey(EnvironmentId.make("env"), null),
  );
});
