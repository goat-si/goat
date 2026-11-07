import { BotProfile, BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  send: vi.fn(() => true),
  update: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(),
  session: vi.fn(),
  lists: [] as Array<string | null>,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("~/state/channels", () => ({
  channelEnvironment: { updateTaskView: { permissionAtom: () => null } },
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
const decodeBotThreadRow = Schema.decodeSync(BotThreadRow);
vi.mock("./GoatBotTimeline", () => ({ GoatBotTimeline: () => <div>Task timeline</div> }));
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
            status: "waiting_input",
            updatedAt: "2026-11-04T10:00:00.000Z",
          },
          view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
          lastActivityAt: "2026-11-04T10:00:00.000Z",
          unread: true,
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
      rowsForTask: (id: string) => {
        state.session(id);
        return [];
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

it("opens the scoped task and acknowledges it, then sends and closes", async () => {
  state.send.mockClear();
  state.update.mockClear();
  state.session.mockClear();
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
