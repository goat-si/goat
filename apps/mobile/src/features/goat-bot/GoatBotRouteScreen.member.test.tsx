import "./goatBotScreenTestHarness";
import {
  buildGoatBotTimeline,
  goatBotItemReaders,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import {
  BotProfile,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { act, useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));

// A member's chat opened through its route and read, then its roster row: the route, the real
// GoatBotScreen, the visit snapshot, the preview and the app state run as the app runs them. Only
// the transport stands in: the thread shells and items the server syncs, the visit write (which
// moves the shell's read position, as the server's echo does), the member lookup and its status.
const server = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    shells: new Map<string, { lastVisitedAt: string | null; updatedAt: string }>(),
    items: new Map<string, ReadonlyArray<unknown>>(),
    visits: [] as Array<{ threadId: string; visitedAt: string }>,
    version: 0,
    listeners,
    changed() {
      server.version += 1;
      for (const listener of listeners) listener();
    },
  };
});
const useServer = () =>
  useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.version,
  );
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) => {
    useServer();
    return ref === null ? null : (server.shells.get(ref.threadId) ?? null);
  },
}));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: (ref: { threadId: string | null }) => {
    useServer();
    return ref.threadId === null ? [] : (server.items.get(ref.threadId) ?? []);
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (args: { input: { threadId: string; visitedAt: string } }) => {
    server.visits.push(args.input);
    const shell = server.shells.get(args.input.threadId);
    if (shell) shell.lastVisitedAt = args.input.visitedAt;
    server.changed();
  },
}));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: { environmentId: "env", threadId: "main" } }),
}));
vi.mock("./useMobileBotRoster", () => ({
  useMobileGoatBotMember: () => ({ member: scout, main: null, missing: false }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          connection: { phase: "connected" },
          serverConfig: { environment: { capabilities: { goatBotMembers: true } } },
        },
      ],
    ]),
  }),
}));
// The member's status as the server reads it: its newest message.
vi.mock("../../state/channels", () => ({
  channelEnvironment: { botStatus: (args: { input: { botId: string } }) => args.input },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (read: { botId: string } | null) => {
    useServer();
    const items = (server.items.get("scout") ?? []) as OrchestrationV2ProjectedTurnItem[];
    const newest = items.at(-1)?.item;
    return {
      data:
        read === null || newest === undefined
          ? null
          : {
              waitingCount: 0,
              latest: {
                text: "text" in newest ? newest.text : "",
                at: DateTime.formatIso(newest.updatedAt),
                author: newest.type === "user_message" ? "person" : "bot",
              },
            },
      refresh: () => {},
    };
  },
}));
vi.mock("./MobileNeedsYouStrip", () => ({ MobileNeedsYouStrip: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string }) => <button>{props.label}</button>,
}));
vi.mock("../workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));

import { device, list, render, screenSession } from "./goatBotScreenTestHarness";
import { GoatBotRouteScreen } from "./GoatBotRouteScreen";
import { MobileBotRosterView } from "./MobileBotRosterView";

const scout = Schema.decodeUnknownSync(BotProfile)({
  botId: "scout",
  role: "member",
  name: "Scout",
  avatar: null,
  purpose: "Finds sources",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "scout",
  createdAt: "2026-11-11T09:00:00.000Z",
  updatedAt: "2026-11-11T09:00:00.000Z",
});
const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
function reply(id: string, minute: number, text: string): OrchestrationV2ProjectedTurnItem {
  const time = DateTime.makeUnsafe(at(minute));
  const item = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("scout"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: minute,
    status: "completed" as const,
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    messageId: MessageId.make("m-" + id),
    text,
    type: "assistant_message" as const,
    streaming: false,
  };
  return {
    position: minute,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}
// What the server sends: Scout's conversation, which the chat's rows are built from as the session
// builds them.
function conversation(items: OrchestrationV2ProjectedTurnItem[]) {
  server.items.set("scout", items);
  screenSession.rows = buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
    taskId: null,
    answerReferences: true,
  });
  server.changed();
}
const shownIds = () =>
  ((list.props?.data ?? []) as GoatBotRow[])
    .filter((row) => row.kind !== "day")
    .map((row) => row.id);
const roster = (
  <MobileBotRosterView
    bots={[{ kind: "member", profile: scout }]}
    slackEnabled={false}
    onOpenBot={() => {}}
  />
);
const route = { route: { params: { botId: "scout" } } } as unknown as Parameters<
  typeof GoatBotRouteScreen
>[0];

it("reading a member's chat clears its roster dot, and a reply under Control Center stays new", async () => {
  vi.useFakeTimers({ now: Date.parse(at(10)) });
  device.focused = true;
  device.setAppState("active");
  server.visits.length = 0;
  server.shells.set("main", { lastVisitedAt: at(0), updatedAt: at(0) });
  server.shells.set("scout", { lastVisitedAt: at(1), updatedAt: at(5) });
  conversation([reply("hello", 1, "Hi, I'm Scout."), reply("found", 5, "Found the flaky test.")]);
  const scoutRow = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.includes("Scout"),
    );
  const view = await render(roster);
  try {
    // Scout spoke after the last read: its row says so.
    expect(scoutRow(view.container)?.getAttribute("aria-label")).toContain("unread");

    // The person opens Scout's chat: what came since the last read is marked, and read.
    await view.rerender(<GoatBotRouteScreen {...route} />);
    expect(shownIds()).toEqual(["hello", "unread-divider", "found"]);
    expect(server.visits).toEqual([{ threadId: "scout", visitedAt: at(5) }]);

    // Control Center opens; Scout replies under it. Nothing is read while the chat is not seen.
    await act(async () => device.setAppState("inactive"));
    await act(async () => vi.advanceTimersByTime(30_000));
    conversation([
      reply("hello", 1, "Hi, I'm Scout."),
      reply("found", 5, "Found the flaky test."),
      reply("fixed", 6, "Fixed it."),
    ]);
    await view.rerender(<GoatBotRouteScreen {...route} />);
    expect(server.visits).toHaveLength(1);

    // Back: the same "New" boundary, the reply from under Control Center inside it, and now read.
    await act(async () => device.setAppState("active"));
    await view.rerender(<GoatBotRouteScreen {...route} />);
    expect(shownIds()).toEqual(["hello", "unread-divider", "found", "fixed"]);
    expect(server.visits.at(-1)).toEqual({ threadId: "scout", visitedAt: at(6) });

    // Back on the roster, Scout's row no longer says unread.
    await view.rerender(roster);
    expect(scoutRow(view.container)?.getAttribute("aria-label")).not.toContain("unread");
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
