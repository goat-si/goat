import {
  BotProfile,
  BotThreadRow,
  ChannelTaskId,
  type ChannelTaskStatus,
  EnvironmentId,
} from "@goat/contracts";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ReactNode } from "react";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
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
  useAtomValue: () => true,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: {
    updateTaskView: { permissionAtom: () => null },
    retryTask: { permissionAtom: () => null },
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({}),
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => [],
}));
vi.mock("~/hooks/useResizableWidth", () => ({
  RESIZABLE_WIDTH_PROPERTY: "--resizable-width",
  useResizableWidth: () => ({ width: 480, handlers: {} }),
}));
vi.mock("./GoatBotWorkDetails", () => ({ GoatBotWorkDetails: () => null }));
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
      rows: [
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
      refresh: state.refresh,
    };
  },
}));
vi.mock("./useGoatBotSession", () => ({
  useGoatBotSession: (_items: unknown, taskId: string) => {
    state.session(taskId);
    return {
      availability: { kind: "ready" },
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
import { GoatBotMemberContext } from "./goatBotMemberContext";
import { GoatBotTaskPane } from "./GoatBotTaskPane";
import { resetTaskReadAcknowledgementsForTests } from "./useAcknowledgeTaskRead";
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

/** Resets the shared acknowledgement record and the mocks this test reads. */
function setup() {
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
