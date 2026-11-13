import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { GoatBotVisitSnapshot } from "./useGoatBotVisitSnapshot";

const route = vi.hoisted(() => ({
  focused: true,
  foreground: true,
  active: true,
  shell: null as null | { lastVisitedAt?: string | null },
  preview: null as null | { unread: boolean; at: string },
  visit: vi.fn(),
  snapshot: undefined as GoatBotVisitSnapshot | null | undefined,
  threadId: "bot-thread",
  member: null as null | { botId: string; environmentId: string; sessionThreadId: string },
  memberPreview: null as null | { unread: boolean; at: string },
  previewRefs: [] as unknown[],
  screenForeground: undefined as boolean | undefined,
  screenSeen: undefined as boolean | undefined,
  screenTask: undefined as string | undefined,
  screenMember: undefined as string | null | undefined,
}));
vi.mock("react-native", () => ({
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => route.focused }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => route.active && route.foreground,
  useAppForeground: () => route.foreground,
}));
vi.mock("@goat/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@goat/client-runtime/goatBot", () => ({ goatBotName: () => "GOAT Bot" }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => route.shell }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { visit: "visit" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => route.visit }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    botRef: { environmentId: "env", threadId: route.threadId },
  }),
}));
vi.mock("./useMobileBotPreview", () => ({
  useMobileBotPreview: (ref: { threadId: string } | null) => {
    route.previewRefs.push(ref);
    return route.member !== null && ref?.threadId === route.member.sessionThreadId
      ? route.memberPreview
      : route.preview;
  },
}));
vi.mock("./useMobileBotRoster", () => ({
  useMobileGoatBotMember: (botId?: string) => ({
    member: botId === undefined ? null : route.member,
    main: null,
    missing: false,
  }),
}));
vi.mock("./useMobileBotManage", () => ({ useMobileBotManage: () => ({ canManage: false }) }));
vi.mock("./GoatBotScreen", () => ({
  GoatBotScreen: (props: {
    readSnapshot?: GoatBotVisitSnapshot | null;
    foreground?: boolean;
    seen?: boolean;
    taskId?: string;
    member?: { botId: string } | null;
  }) => {
    route.snapshot = props.readSnapshot;
    route.screenForeground = props.foreground;
    route.screenSeen = props.seen;
    route.screenTask = props.taskId;
    route.screenMember = props.member === undefined ? undefined : (props.member?.botId ?? null);
    return null;
  },
}));

import { GoatBotRouteScreen } from "./GoatBotRouteScreen";

const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
type RouteProps = Parameters<typeof GoatBotRouteScreen>[0];
const props = { route: { params: {} } } as unknown as RouteProps;

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const show = () => act(async () => root.render(<GoatBotRouteScreen {...props} />));
  await show();
  return { show, unmount: () => act(async () => root.unmount()) };
}

it("does not count a reply that arrived while the app was in the background as read, and marks it on return", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "bg-thread" });
  route.visit.mockClear();
  route.shell = { lastVisitedAt: at(1) };
  route.preview = { unread: true, at: at(2) };
  const view = await mount();
  expect(route.visit).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: { threadId: "bg-thread", visitedAt: at(2) } }),
  );
  route.shell = { lastVisitedAt: at(2) };
  await view.show();
  route.visit.mockClear();
  // The app goes to the background; the bot replies there.
  route.foreground = false;
  await view.show();
  route.preview = { unread: true, at: at(9) };
  await view.show();
  expect(route.visit).not.toHaveBeenCalled();
  expect(route.snapshot).toBeNull();
  // Back in the app: a fresh read position, so the reply is new.
  route.foreground = true;
  await view.show();
  expect(route.snapshot).toMatchObject({ readUpTo: at(2), newestAtOpen: at(9) });
  await view.unmount();
});

it("keeps the unread boundary across a moment of inactivity, writes no visit then, and marks replies that came", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "cc-thread" });
  route.visit.mockClear();
  route.shell = { lastVisitedAt: at(1) };
  route.preview = { unread: true, at: at(2) };
  const view = await mount();
  const opened = route.snapshot;
  expect(opened).toMatchObject({ readUpTo: at(1), newestAtOpen: at(2) });
  // The visit is written, so the server's read position moves to the newest message.
  route.shell = { lastVisitedAt: at(2) };
  await view.show();
  route.visit.mockClear();
  // Control Center opens: the app is inactive but still in the foreground; the bot replies.
  route.active = false;
  await view.show();
  route.preview = { unread: true, at: at(9) };
  await view.show();
  expect(route.visit).not.toHaveBeenCalled();
  expect(route.snapshot).toMatchObject({ key: opened?.key, readUpTo: at(1) });
  // Back: the same visit and boundary, and the reply from the inactive moment is new too.
  route.active = true;
  await view.show();
  expect(route.snapshot).toMatchObject({
    key: opened?.key,
    readUpTo: at(1),
    newestAtOpen: at(2),
    away: [{ after: at(2), upTo: at(9) }],
  });
  await view.unmount();
});

it("keeps its own read position for a server that does not track visits", async () => {
  Object.assign(route, {
    focused: true,
    foreground: true,
    active: true,
    threadId: "old-server-thread",
  });
  route.visit.mockClear();
  route.shell = {};
  route.preview = { unread: true, at: at(3) };
  const view = await mount();
  expect(route.snapshot).toMatchObject({ readUpTo: null });
  route.focused = false;
  await view.show();
  route.preview = { unread: true, at: at(7) };
  await view.show();
  route.focused = true;
  await view.show();
  // Read up to what was there while the chat was open, so the later reply is marked.
  expect(route.snapshot).toMatchObject({ readUpTo: at(3), newestAtOpen: at(7) });
  expect(route.visit).not.toHaveBeenCalled();
  await view.unmount();
});
it("records a member chat's visit against the member's own conversation while it is seen", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "main-thread" });
  route.visit.mockClear();
  route.member = { botId: "scout", environmentId: "env", sessionThreadId: "scout-thread" };
  route.shell = { lastVisitedAt: at(1) };
  route.preview = { unread: true, at: at(3) };
  route.memberPreview = { unread: true, at: at(5) };
  const root = createRoot(document.createElement("div"));
  const member = { route: { params: { botId: "scout" } } } as unknown as RouteProps;
  await act(async () => root.render(<GoatBotRouteScreen {...member} />));
  // The member's own read position is taken before its visit is written, for its "New" marker.
  expect(route.snapshot).toMatchObject({ readUpTo: at(1), newestAtOpen: at(5) });
  // The member's newest message is read, in its own conversation; the main chat is not touched.
  expect(route.visit).toHaveBeenCalledTimes(1);
  expect(route.visit).toHaveBeenCalledWith(
    expect.objectContaining({ input: { threadId: "scout-thread", visitedAt: at(5) } }),
  );
  // Control Center opens (inactive, still in the foreground) and Scout replies: not read.
  route.visit.mockClear();
  route.active = false;
  route.memberPreview = { unread: true, at: at(6) };
  await act(async () => root.render(<GoatBotRouteScreen {...member} />));
  expect(route.visit).not.toHaveBeenCalled();
  // Back: the reply is read now.
  route.active = true;
  await act(async () => root.render(<GoatBotRouteScreen {...member} />));
  expect(route.visit).toHaveBeenCalledWith(
    expect.objectContaining({ input: { threadId: "scout-thread", visitedAt: at(6) } }),
  );
  // Not seen in the background, and nothing more to mark once read.
  route.visit.mockClear();
  route.foreground = false;
  route.memberPreview = { unread: true, at: at(7) };
  await act(async () => root.render(<GoatBotRouteScreen {...member} />));
  expect(route.visit).not.toHaveBeenCalled();
  route.foreground = true;
  route.memberPreview = { unread: false, at: at(7) };
  await act(async () => root.render(<GoatBotRouteScreen {...member} />));
  expect(route.visit).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  route.member = null;
  route.memberPreview = null;
});

it("tells the chat when the app is in the background, so it stops reading GOAT Bot's steps", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "fg-thread" });
  const view = await mount();
  expect(route.screenForeground).toBe(true);
  route.foreground = false;
  await view.show();
  expect(route.screenForeground).toBe(false);
  route.foreground = true;
  await view.show();
  expect(route.screenForeground).toBe(true);
  await view.unmount();
});

it("opens the task an ask names in its own bot's chat, whether or not the work list still has it", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "ask-thread" });
  route.member = { botId: "scout", environmentId: "env", sessionThreadId: "scout-thread" };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const asked = {
    route: { params: { botId: "scout", taskId: "task-s" } },
  } as unknown as RouteProps;
  await act(async () => root.render(<GoatBotRouteScreen {...asked} />));
  expect(route.screenTask).toBe("task-s");
  expect(route.screenMember).toBe("scout");
  await act(async () => root.unmount());
  route.member = null;
});

it("tells the chat what it shows is seen only while focused and the app is active", async () => {
  Object.assign(route, { focused: true, foreground: true, active: true, threadId: "seen-thread" });
  const view = await mount();
  expect(route.screenSeen).toBe(true);
  // Control Center: still in the foreground, but inactive, so a task is not marked read.
  route.active = false;
  await view.show();
  expect(route.screenSeen).toBe(false);
  route.active = true;
  await view.show();
  expect(route.screenSeen).toBe(true);
  route.foreground = false;
  await view.show();
  expect(route.screenSeen).toBe(false);
  route.foreground = true;
  route.focused = false;
  await view.show();
  expect(route.screenSeen).toBe(false);
  route.focused = true;
  await view.unmount();
});
