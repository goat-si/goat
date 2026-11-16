import "~/index.css";
import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { cloneElement, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import {
  createPrimarySessionCheck,
  type PrimarySessionCheck,
} from "~/environments/primary/sessionCheckSchedule";
import type { PrimarySessionAnswer } from "~/environments/primary/auth";

vi.unmock("./useGoatBotComputerReadable");

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;
type Failure = NonNullable<Connection["failure"]>;
const state = vi.hoisted(() => ({
  botRef: null as { environmentId: EnvironmentId; threadId: ThreadId } | null,
  items: [] as ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  presentation: null as null | {
    connection: Connection;
    serverConfig: { environment: { capabilities: object } };
  },
  primaryId: null as EnvironmentId | null,
  probe: (() => Promise.resolve("unknown")) as () => Promise<PrimarySessionAnswer>,
  probes: 0,
  check: null as PrimarySessionCheck | null,
  listeners: new Set<() => void>(),
  version: 0,
}));
function useTick() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
}
function notify() {
  state.version += 1;
  for (const listener of state.listeners) listener();
}

vi.mock("~/globalAgentStore", () => ({
  useGlobalAgentStore: (selector: (value: object) => unknown) => {
    useTick();
    return selector({ botRef: state.botRef });
  },
}));
vi.mock("~/globalAgentRoute", () => ({ GOAT_BOT_PATH: "/goat", isGoatBotRoute: () => false }));
vi.mock("~/threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("./useBotRoster", () => ({ useBotThreads: () => ({ rows: [], supported: false }) }));
vi.mock("./GoatBotMemberRows", () => ({ GoatBotMainMenu: () => null }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; search: object }) => unknown;
  }) => select({ pathname: "/fleet", search: {} }),
  useParams: () => ({}),
  Link: ({ children }: { children: ReactNode }) => <a href="/goat">{children}</a>,
}));
vi.mock("./GoatBotModeButton", () => ({ useGoatBotPreferred: () => true }));
vi.mock("./useGoatBotHome", () => ({ useGoatBotHome: () => undefined }));
vi.mock("./useGoatBotWaitingCount", () => ({
  useGoatBotWaitingCount: () => 2,
  useGoatBotSidebarWaiting: () => ({
    environmentId: state.botRef?.environmentId ?? null,
    governed: false,
    count: 2,
    state: "ready",
  }),
  useMarkGoatBotRead: () => null,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironment: () => {
    useTick();
    return state.presentation;
  },
  usePrimaryEnvironmentId: () => state.primaryId,
}));
// The real check, driven by this file's connection and auth/session answers.
vi.mock("~/environments/primary/sessionCheck", () => ({
  primarySessionCheck: {
    subscribe: (listener: () => void) => state.check?.subscribe(listener) ?? (() => {}),
    revoked: () => state.check?.revoked() ?? false,
  },
}));
vi.mock("~/state/channels", async (original) => ({
  ...(await original<typeof import("~/state/channels")>()),
  channelEnvironment: {
    homeCurrentOpenableWorkAtom: () => "main-work",
    homeCurrentUnreadAtom: () => "main-unread",
  },
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  const work = { eligible: true, list: "ready", work: { running: [], waiting: [], finished: [] } };
  return {
    ...actual,
    useAtomValue: (atom: unknown) => {
      if (atom === "main-unread") return 0;
      if (atom === "main-work") return work;
      return actual.useAtomValue(atom as never);
    },
  };
});
vi.mock("./goatBotChannelPort", async () => {
  const React = await import("react");
  return { GoatBotChannelContext: React.createContext(null) };
});
vi.mock("../ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ render: link, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(link, {}, children),
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <b data-testid="badge">{children}</b>,
}));
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: unknown) => {
    useTick();
    return ref
      ? { lastVisitedAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z" }
      : null;
  },
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: () => {
    useTick();
    return state.items;
  },
}));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (value: object) => unknown) =>
    selector({ threadLastVisitedAtById: {} }),
}));

import { GoatBotMainAvatar } from "./GoatBotAvatar";
import { GoatBotSidebarRow } from "./GoatBotSidebarRow";

const BOT_COMPUTER = EnvironmentId.make("bot-computer");
const OTHER_COMPUTER = EnvironmentId.make("other-computer");
const LINE = "The deploy finished";

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

function connection(phase: Connection["phase"], failure?: Failure) {
  return {
    connection: failure === undefined ? { phase } : { phase, failure },
    serverConfig: { environment: { capabilities: {} } },
  };
}

function setup({ primary = false }: { primary?: boolean } = {}) {
  state.botRef = { environmentId: BOT_COMPUTER, threadId: ThreadId.make("bot") };
  state.items = [projectedBot("b1", "2026-10-12T12:01:00.000Z", LINE)];
  state.presentation = connection("connected");
  state.primaryId = primary ? BOT_COMPUTER : OTHER_COMPUTER;
  state.probe = () => Promise.resolve("unknown");
  state.probes = 0;
  state.listeners = new Set();
  state.version = 0;
  state.check = null;
  if (!primary) return;
  state.check = createPrimarySessionCheck({
    connection: () => state.presentation?.connection ?? null,
    subscribeConnection: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    visible: () => true,
    subscribeVisible: () => () => {},
    eligible: () => true,
    probe: () => {
      state.probes += 1;
      return state.probe();
    },
  });
}

async function renderRow() {
  await using stack = new AsyncDisposableStack();
  // The mocked router isolates the sidebar row.
  const screen = stack.use(await render(<GoatBotSidebarRow />, { router: false }));
  await expect.element(screen.getByText(LINE)).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "2 waiting for you" })).toBeVisible();
  expect(screen.container.querySelector("[data-slot=goat-bot-waiting-mark]")).not.toBeNull();
  stack.move();
  return screen;
}

function expectClosed(screen: Awaited<ReturnType<typeof render>>) {
  expect(screen.getByText(LINE).query()).toBeNull();
  expect(screen.container.querySelector("[data-slot=goat-bot-relative-time]")).toBeNull();
  expect(screen.getByRole("img", { name: "2 waiting for you" }).query()).toBeNull();
  expect(screen.container.querySelector("[data-slot=goat-bot-waiting-mark]")).toBeNull();
  // Only the fixed "Main" label is left; the count and Slack badges are gone.
  expect(
    screen
      .getByTestId("badge")
      .elements()
      .map((badge) => badge.textContent),
  ).toEqual(["Main"]);
  expect(screen.getByRole("link").query()).not.toBeNull();
  // The link's accessible name says the bot's name and "Main" only: no old line, time or count.
  expect(screen.getByRole("link", { name: /^GOAT Bot\s*Main$/ }).query()).not.toBeNull();
}

it.each([
  ["error", { kind: "blocked", reason: "authentication", detail: "Credential refused" }],
  ["reconnecting", { kind: "blocked", reason: "permission", detail: "Scope missing" }],
] as const)(
  "the main row shows no line, time or badges, and its face rests, once its computer refuses this client's credential or scope (%s); they come back once it connects",
  async (phase, failure) => {
    setup();
    await using screen = await renderRow();
    await act(async () => {
      state.presentation = connection(phase, failure);
      notify();
    });
    expectClosed(screen);
    await act(async () => {
      state.presentation = connection("connected");
      notify();
    });
    await expect.element(screen.getByText(LINE)).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "2 waiting for you" })).toBeVisible();
  },
);

it("the main row shows no line once its computer is removed from the app, though its messages are still cached", async () => {
  setup();
  await using screen = await renderRow();
  await act(async () => {
    state.presentation = null;
    notify();
  });
  expectClosed(screen);
});

it("the chat header's face rests while its computer refuses this client, even as the chat says the bot works", async () => {
  setup();
  // The avatar alone has no links, and this file mocks the router's hooks.
  await using screen = await render(
    <GoatBotMainAvatar chatOpen activity={{ state: "working" }} waitingOverride={0} />,
    { router: false },
  );
  await expect.element(screen.getByRole("img", { name: "Working" })).toBeVisible();
  await act(async () => {
    state.presentation = connection("error", {
      kind: "blocked",
      reason: "authentication",
      detail: "Credential refused",
    });
    notify();
  });
  expect(screen.getByRole("img").query()).toBeNull();
});

it.each([
  ["revoked", true],
  ["signed-in", false],
  ["unknown", false],
] as const)(
  "on this tab's own server, a dropped socket hides the main row's line only once auth/session says the session is gone (%s)",
  async (answer, hides) => {
    setup({ primary: true });
    state.probe = () => Promise.resolve(answer);
    await using screen = await renderRow();
    using _timers = fakeTimers();
    await act(async () => {
      state.presentation = connection("reconnecting", {
        kind: "retrying",
        reason: "transport",
        detail: "Socket closed",
      });
      notify();
    });
    // A dropped socket alone keeps the line: it looks the same as a network failure.
    expect(screen.getByText(LINE).query()).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    if (hides) expectClosed(screen);
    else expect(screen.getByText(LINE).query()).not.toBeNull();
    expect(state.probes).toBe(1);
  },
);

it.each([
  ["host-unreachable", false],
  ["transport", false],
  ["transport", true],
] as const)(
  "guard: a computer that cannot be reached (%s, its own server: %s) keeps the main row's line while nothing says its access ended",
  async (reason, primary) => {
    setup({ primary });
    await using screen = await renderRow();
    using _timers = fakeTimers();
    await act(async () => {
      state.presentation = connection("reconnecting", {
        kind: "retrying",
        reason,
        detail: "Unreachable",
      });
      notify();
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(LINE).query()).not.toBeNull();
    await expect.element(screen.getByRole("img", { name: "2 waiting for you" })).toBeVisible();
    // The check reads only this tab's own server.
    expect(state.probes).toBe(primary ? 3 : 0);
  },
);
