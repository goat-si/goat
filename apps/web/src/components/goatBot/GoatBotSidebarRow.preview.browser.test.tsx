import "~/index.css";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  botRef: null as { environmentId: EnvironmentId; threadId: ThreadId } | null,
  items: [] as ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  preferred: true,
  active: false,
  detailCalls: vi.fn(),
  shellVisitedAt: "2026-10-12T12:00:00.000Z" as string | null | undefined,
  waiting: 2,
}));
const listeners = new Set<() => void>();
let version = 0;
function useTick() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

vi.mock("~/globalAgentStore", () => ({
  useGlobalAgentStore: (selector: (value: object) => unknown) => {
    useTick();
    return selector({ botRef: state.botRef });
  },
}));
vi.mock("~/globalAgentRoute", () => ({
  GOAT_BOT_PATH: "/goat",
  isGoatBotRoute: () => state.active,
}));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; search: object }) => unknown;
  }) => select({ pathname: "/goat", search: {} }),
  useParams: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="/goat">{children}</a>,
}));
vi.mock("./GoatBotModeButton", () => ({
  useGoatBotPreferred: () => {
    useTick();
    return state.preferred;
  },
}));
vi.mock("./useGoatBotHome", () => ({ useGoatBotHome: () => undefined }));
vi.mock("./useGoatBotWaitingCount", () => ({
  useGoatBotWaitingCount: () => state.waiting,
  useMarkGoatBotRead: () => null,
}));
vi.mock("./goatBotChannelPort", async () => {
  const React = await import("react");
  return { GoatBotChannelContext: React.createContext(null) };
});
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <b>{children}</b>,
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: unknown) => {
    useTick();
    return ref
      ? { lastVisitedAt: state.shellVisitedAt, updatedAt: "2026-10-12T12:00:00.000Z" }
      : null;
  },
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: (ref: unknown) => {
    useTick();
    state.detailCalls(ref);
    return state.items;
  },
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (value: object) => unknown) =>
    selector({ threadLastVisitedAtById: {} }),
}));

import { GoatBotSidebarRow } from "./GoatBotSidebarRow";

function projectedBot(id: string, at: string, text: string): OrchestrationV2ProjectedTurnItem {
  const time = DateTime.makeUnsafe(at);
  const item = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("bot"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    type: "assistant_message",
    messageId: MessageId.make(`m-${id}`),
    text,
    streaming: false,
  } satisfies OrchestrationV2TurnItem;
  return {
    item,
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.botRef = null;
  state.items = [];
  state.preferred = true;
  state.active = false;
  state.shellVisitedAt = "2026-10-12T12:00:00.000Z";
  state.waiting = 2;
  state.detailCalls.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("subscribes only with a supported bot and updates preview and unread dot as messages arrive", async () => {
  await act(() => root.render(<GoatBotSidebarRow />));
  expect(state.detailCalls).not.toHaveBeenCalledWith(expect.anything());
  expect(container.textContent).toContain("GOAT Bot");
  await act(() => {
    state.botRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };
    state.items = [projectedBot("b1", "2026-10-12T12:01:00.000Z", "First reply")];
    notify();
  });
  expect(container.textContent).toContain("First reply");
  expect(container.querySelector('[aria-label="Unread GOAT Bot messages"]')).not.toBeNull();
  expect(container.textContent).toContain("2");
  await act(() => {
    state.items = [...state.items, projectedBot("b2", "2026-10-12T12:02:00.000Z", "Second reply")];
    notify();
  });
  expect(container.textContent).toContain("Second reply");
  await act(() => {
    state.active = true;
    notify();
  });
  expect(container.querySelector('[aria-label="Unread GOAT Bot messages"]')).toBeNull();
});

it("skips detail on old servers and unmounts the row when bot mode is off", async () => {
  state.botRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };
  state.shellVisitedAt = undefined;
  await act(() => root.render(<GoatBotSidebarRow />));
  expect(state.detailCalls).not.toHaveBeenCalledWith(expect.anything());
  expect(container.querySelector('[data-slot="goat-bot-relative-time"]')).not.toBeNull();
  await act(() => {
    state.preferred = false;
    notify();
  });
  expect(container.textContent).toBe("");
});

it("keeps the bot name visible with badges in a 220px container", async () => {
  container.style.width = "220px";
  await act(() => root.render(<GoatBotSidebarRow name="GOAT Bot" slackEnabled />));
  const name = Array.from(container.querySelectorAll("span")).find(
    (element) => element.textContent === "GOAT Bot",
  );
  expect(name).toBeDefined();
  expect(name!.getBoundingClientRect().width).toBeGreaterThan(0);
});

it("shows the waiting face on the row while tasks wait for the person", async () => {
  state.botRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };
  await act(() => root.render(<GoatBotSidebarRow />));
  expect(container.querySelector('[role="img"][aria-label="Waiting for you"]')).not.toBeNull();
});

it("shows the working face while a task in the conversation runs", async () => {
  state.waiting = 0;
  state.botRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("bot") };
  const card = projectedBot("card", "2026-10-12T12:01:00.000Z", "");
  state.items = [
    {
      ...card,
      item: {
        ...card.item,
        type: "notification",
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Work updated",
        ledgerTask: {
          taskId: "task-1",
          conversationId: "conv-1",
          taskVersion: 1,
          title: "Check the disks",
          status: "running",
          originKind: "goat",
          requesterLabel: "Jun",
          createdAt: "2026-10-12T12:01:00.000Z",
          updatedAt: "2026-10-12T12:01:00.000Z",
          openQuestionCount: 0,
        },
      } as unknown as OrchestrationV2TurnItem,
    },
  ];
  await act(() => root.render(<GoatBotSidebarRow />));
  expect(container.querySelector('[role="img"][aria-label="Working"]')).not.toBeNull();
});
