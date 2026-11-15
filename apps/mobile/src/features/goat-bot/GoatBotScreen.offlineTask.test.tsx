import "./goatBotScreenTestHarness";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { act } from "react";
import { expect, it, vi } from "vite-plus/test";

import {
  navigation,
  remote,
  render,
  screenSession,
  setupTaskNavigation,
} from "./goatBotScreenTestHarness";
import { GoatBotScreen } from "./GoatBotScreen";
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));

const card = (target: Extract<GoatBotRow, { kind: "task" }>["card"]["target"]): GoatBotRow => ({
  kind: "task",
  id: "card",
  createdAt: "2026-10-12T09:40:00Z",
  firstInGroup: true,
  groupPosition: "single",
  card: {
    key: "task-1",
    revision: 1,
    updatedAt: "2026-10-12T09:40:00Z",
    title: "Check disks",
    statusLabel: "Done",
    tone: "success",
    sourceLabel: null,
    summary: null,
    attentionLabel: null,
    pullRequests: [],
    target,
  },
});
const scout = {
  botId: "scout",
  name: "Scout",
  role: "member",
  color: null,
  avatar: null,
  environmentId: "env",
  sessionThreadId: "scout-thread",
  state: "active",
} as unknown as BotProfile;
const cardButton = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Check disks."),
  );

it.each([
  ["main bot", null],
  ["member bot", scout],
] as const)(
  "%s: offline, a task card in the chat stays listed with Open task closed and says why; reconnecting reopens it without a remount (#3427)",
  async (_name, member) => {
    setupTaskNavigation();
    screenSession.supportsTaskThreads = true;
    screenSession.rows = [card({ kind: "none", label: "Unavailable" })];
    const element = () => <GoatBotScreen visible {...(member ? { member } : {})} />;
    const view = await render(element());
    const pushed = { taskId: "task-1", ...(member ? { botId: "scout" } : {}) };
    await act(async () => cardButton(view.container)?.click());
    expect(navigation.dispatch).toHaveBeenCalledWith({ name: "GoatBot", params: pushed });
    navigation.dispatch.mockClear();
    screenSession.homeConnected = false;
    await view.rerender(element());
    const closed = cardButton(view.container);
    expect(closed?.disabled).toBe(true);
    expect(closed?.getAttribute("aria-label")).toMatch(/Open task, unavailable while offline$/);
    expect(closed?.textContent).toContain("Open task");
    await act(async () => closed?.click());
    expect(navigation.dispatch).not.toHaveBeenCalled();
    screenSession.homeConnected = true;
    await view.rerender(element());
    const open = cardButton(view.container);
    expect(open?.disabled).toBe(false);
    expect(open?.getAttribute("aria-label")).toMatch(/Open task$/);
    await act(async () => open?.click());
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).toHaveBeenCalledWith({ name: "GoatBot", params: pushed });
    await view.unmount();
  },
);

it("offline, a card without Open task still opens its reachable work thread", async () => {
  setupTaskNavigation();
  remote.connected = ["remote"];
  screenSession.homeConnected = false;
  screenSession.rows = [
    card({ kind: "thread", environmentId: "remote", threadId: "worker", host: "mini" } as never),
  ];
  const onSelectThread = vi.fn();
  const view = await render(<GoatBotScreen visible onSelectThread={onSelectThread} />);
  const button = cardButton(view.container);
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(onSelectThread).toHaveBeenCalledWith({ environmentId: "remote", id: "worker" });
  await view.unmount();
});
