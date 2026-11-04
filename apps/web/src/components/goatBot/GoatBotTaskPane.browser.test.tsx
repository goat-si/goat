import { BotThreadRow, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  send: vi.fn(() => true),
  update: vi.fn(async () => ({ _tag: "Success" })),
  refresh: vi.fn(),
  session: vi.fn(),
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
vi.mock("./useBotRoster", () => ({
  useBotRoster: () => ({
    rows: [
      decodeBotThreadRow({
        kind: "task",
        task: {
          taskId: "task-1",
          title: "Review work",
          status: "running",
          updatedAt: "2026-11-04T10:00:00.000Z",
        },
        view: { taskId: "task-1", pinnedAt: null, doneAt: null, readThrough: null },
        lastActivityAt: "2026-11-04T10:00:00.000Z",
        unread: true,
        mainMessagesSinceQuiet: 0,
      }),
    ],
    refresh: state.refresh,
  }),
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
