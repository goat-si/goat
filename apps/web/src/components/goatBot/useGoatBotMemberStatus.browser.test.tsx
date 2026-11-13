import { BotId, EnvironmentId, ThreadId, type BotProfile } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  connected: true,
  waitingRead: true,
  status: true,
  success: true,
  error: null as string | null,
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: {
      environment: {
        capabilities: {
          goatBotMembers: true,
          goatBotStatus: state.status,
          goatBotWaitingRead: state.waitingRead,
        },
      },
    },
  }),
}));
vi.mock("~/state/channels", () => ({ channelEnvironment: { botStatus: () => "status" } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { waitingCount: 3 },
    isSuccess: state.success,
    error: state.error,
    refresh: () => {},
  }),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
import { useGoatBotMemberStatus } from "./useGoatBotMemberStatus";
const bot = {
  botId: BotId.make("member"),
  environmentId: EnvironmentId.make("env"),
  sessionThreadId: ThreadId.make("bot"),
} as BotProfile;
function View() {
  const status = useGoatBotMemberStatus(bot);
  return (
    <output>
      {status.sidebarWaitingCount === undefined
        ? status.sidebarWaitingState
        : status.sidebarWaitingCount}
    </output>
  );
}
it("exposes a waiting count only for a successful connected visit-aware status read", async () => {
  state.connected = true;
  state.waitingRead = true;
  state.status = true;
  state.success = true;
  state.error = null;
  await using screen = await render(<View key="success" />);
  await expect.element(screen.getByText("3")).toBeVisible();
  state.success = false;
  await screen.rerender(<View key="pending" />);
  await expect.element(screen.getByText("pending")).toBeVisible();
  state.error = "failed";
  await screen.rerender(<View key="failure" />);
  await expect.element(screen.getByText("unavailable")).toBeVisible();
  state.success = true;
  state.error = null;
  state.waitingRead = false;
  await screen.rerender(<View key="no-visit-count" />);
  await expect.element(screen.getByText("unavailable")).toBeVisible();
  state.waitingRead = true;
  state.status = false;
  await screen.rerender(<View key="no-status" />);
  await expect.element(screen.getByText("unavailable")).toBeVisible();
  state.status = true;
  state.connected = false;
  await screen.rerender(<View key="offline" />);
  await expect.element(screen.getByText("unavailable")).toBeVisible();
});
