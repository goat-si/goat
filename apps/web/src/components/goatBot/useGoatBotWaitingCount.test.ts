import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { GoatBotChannelPort } from "./goatBotChannelPort";
import { useGlobalAgentStore } from "~/globalAgentStore";

import { readGoatBotWaiting, rememberGoatBotFromStatus } from "./useGoatBotWaitingCount";

const environmentId = EnvironmentId.make("env");
const bot = {
  environmentId,
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("bot"),
};

const task = (taskId: string, kind: "goat" | "slack") =>
  ({ taskId, status: "waiting_input", originAddress: { kind } }) as never;

function makePort(overrides: Partial<GoatBotChannelPort>): GoatBotChannelPort {
  return {
    ensureBot: vi.fn(),
    getBotStatus: vi.fn(),
    ingest: vi.fn(),
    listTasks: vi.fn(),
    useCanSend: () => true,
    ...overrides,
  };
}

describe("readGoatBotWaiting", () => {
  it("asks a status-capable server once and learns the bot without paging", async () => {
    const port = makePort({
      getBotStatus: vi.fn(async () => ({ bot, waitingCount: 3 })),
    });
    await expect(
      readGoatBotWaiting({ port, environmentId, supportsStatus: true, alive: () => true }),
    ).resolves.toEqual({ count: 3, bot });
    expect(port.getBotStatus).toHaveBeenCalledTimes(1);
    expect(port.listTasks).not.toHaveBeenCalled();
  });

  it("pages an older server and counts only GOAT-origin tasks", async () => {
    const listTasks = vi
      .fn<GoatBotChannelPort["listTasks"]>()
      .mockResolvedValueOnce({ tasks: [task("a", "goat"), task("b", "slack")], nextCursor: "1" })
      .mockResolvedValueOnce({ tasks: [task("c", "goat")] });
    const port = makePort({ listTasks });
    await expect(
      readGoatBotWaiting({ port, environmentId, supportsStatus: false, alive: () => true }),
    ).resolves.toEqual({ count: 2, bot: null });
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(port.getBotStatus).not.toHaveBeenCalled();
  });
});

describe("rememberGoatBotFromStatus", () => {
  const other = { ...bot, threadId: ThreadId.make("replacement") };
  it("records the bot a status read names", () => {
    useGlobalAgentStore.setState({ botRef: null });
    rememberGoatBotFromStatus(bot, null);
    expect(useGlobalAgentStore.getState().botRef).toEqual(bot);
  });

  it("ignores a read that an ensure answered over while it was in flight", () => {
    useGlobalAgentStore.setState({ botRef: bot });
    const seenAtRequest = useGlobalAgentStore.getState().botRef;
    useGlobalAgentStore.getState().setBotRef(other);
    rememberGoatBotFromStatus(bot, seenAtRequest);
    expect(useGlobalAgentStore.getState().botRef).toEqual(other);
  });
});
