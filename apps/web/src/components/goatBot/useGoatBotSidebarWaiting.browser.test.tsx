import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  h2: true,
  status: true,
  waitingRead: true,
  tracking: true,
  connected: true,
  getStatus: vi.fn(async (): Promise<{ bot: null; waitingCount: number }> => ({
    bot: null,
    waitingCount: 3,
  })),
  listTasks: vi.fn(async () => ({ tasks: [{ taskId: "legacy", status: "waiting_input" }] })),
}));
const environmentId = EnvironmentId.make("sidebar-waiting-test");
vi.mock("./useGoatBotSession", () => ({
  useGoatBotEnabled: () => ({
    enabled: true,
    generation: 1,
    port,
    environment: { environmentId, connected: state.connected, supportsBotStatus: state.status },
  }),
}));
const port = { getBotStatus: state.getStatus, listTasks: state.listTasks };
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () =>
    new Map([
      [
        environmentId,
        {
          environment: {
            capabilities: {
              goatBotTaskThreadsPaged: state.h2,
              goatBotTaskLookupSearch: state.h2,
              goatBotStatus: state.status,
              goatBotWaitingRead: state.waitingRead,
              threadVisitedTracking: state.tracking,
            },
          },
        },
      ],
    ]),
}));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("~/globalAgentStore", () => ({
  useGlobalAgentStore: Object.assign(
    (select: (value: object) => unknown) =>
      select({ botRef: { environmentId, threadId: ThreadId.make("bot") } }),
    { getState: () => ({ botRef: null }) },
  ),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
import {
  refreshGoatBotWaitingCount,
  useGoatBotSidebarWaiting,
  useMarkGoatBotRead,
} from "./useGoatBotWaitingCount";
function View() {
  const waiting = useGoatBotSidebarWaiting();
  const mark = useMarkGoatBotRead();
  return (
    <output>{`${waiting.state}:${waiting.count ?? "none"}:${mark === null ? "no-action" : "action"}`}</output>
  );
}
it("uses only successful visit-aware status for H2 and leaves older counts unchanged", async () => {
  state.h2 = true;
  state.status = true;
  state.waitingRead = true;
  state.tracking = true;
  state.connected = true;
  state.getStatus.mockResolvedValue({ bot: null, waitingCount: 3 });
  await using screen = await render(<View />);
  await expect.element(screen.getByText("ready:3:action")).toBeVisible();
  state.getStatus.mockRejectedValueOnce(new Error("offline"));
  await act(() => refreshGoatBotWaitingCount(environmentId, "failed"));
  await expect.element(screen.getByText("unavailable:none:action")).toBeVisible();
  state.waitingRead = false;
  await screen.rerender(<View />);
  await expect.element(screen.getByText("unavailable:none:no-action")).toBeVisible();
  state.waitingRead = true;
  state.tracking = false;
  await screen.rerender(<View />);
  await expect.element(screen.getByText("unavailable:none:no-action")).toBeVisible();
  state.status = false;
  await screen.rerender(<View />);
  await expect.element(screen.getByText("unavailable:none:no-action")).toBeVisible();
  state.h2 = false;
  await screen.rerender(<View />);
  await expect.element(screen.getByText("ready:1:no-action")).toBeVisible();
});
