import { forgetNewBotEnvironment, newBotSlot, startNewBot } from "@goat/client-runtime/goatBot";
import { BotId, ChannelTaskId, EnvironmentId, OrchestrationV2TurnItemJson } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  narrow: false,
  beside: true,
  supported: true,
  task: undefined as string | undefined,
  sessions: [] as { marker: object }[],
  chatSession: null as object | null,
  paneSession: null as object | null,
  navigate: vi.fn(),
  bots: [] as Array<object>,
  botsLoaded: true,
  shellRefs: [] as Array<unknown>,
  memberArgs: [] as Array<unknown>,
  restore: vi.fn(async () => true),
  items: [] as Array<unknown>,
  sessionReads: [] as Array<string>,
  boundedSnapshots: true,
}));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => state.narrow }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => state.beside }));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: unknown) => {
    state.shellRefs.push(ref);
    return {};
  },
  resolveThreadDetailRef: () => null,
  useThreadVisibleTurnItems: () => state.items,
  // Activity lines read a session only from a server that sends a thread's newest part.
  useServerConfigs: () =>
    new Map([
      ["env", { environment: { capabilities: { goatBotOpenAsks: state.boundedSnapshots } } }],
    ]),
}));
// Records which threads' steps a view reads; reading one is what subscribes to it.
vi.mock("../state/threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const quiet = new Map<string, unknown>();
  const history = Atom.make({ hasMoreHistory: false });
  const actual = await importOriginal<typeof import("../state/threads")>();
  return {
    ...actual,
    environmentThreadDetails: {
      ...actual.environmentThreadDetails,
      quietVisibleTurnItemsAtom: (ref: { threadId: string }) => {
        if (!quiet.has(ref.threadId))
          quiet.set(
            ref.threadId,
            Atom.make(() => {
              state.sessionReads.push(ref.threadId);
              return [];
            }),
          );
        return quiet.get(ref.threadId);
      },
      historyAtom: () => history,
    },
  };
});
// The real chat reads its steps through GoatBotStepsReader around its conversation.
vi.mock("../components/goatBot/GoatBotChatView", async () => {
  const { GoatBotStepsReader } = await import("../components/goatBot/GoatBotStepsProvider");
  return {
    GoatBotChatView: (props: { removal?: string | null; onRestore?: () => void }) => {
      state.chatSession = props;
      return (
        <GoatBotStepsReader rows={[]}>
          <div>
            Main chat
            {props.removal === "deleted" ? <span>Chat removed</span> : null}
            {props.onRestore ? (
              <button type="button" onClick={props.onRestore}>
                Restore
              </button>
            ) : null}
          </div>
        </GoatBotStepsReader>
      );
    },
  };
});
vi.mock("../components/goatBot/useBotManage", () => ({
  useBotManage: () => ({ canManage: true, restore: state.restore }),
}));
vi.mock("../components/goatBot/GoatBotTaskPane", () => ({
  GoatBotTaskPane: ({ narrow, session }: { narrow: boolean; session: object }) => {
    state.paneSession = session;
    return <div>{narrow ? "Back to Tasks" : "Close"}</div>;
  },
}));
vi.mock("../components/goatBot/useGoatBotSession", () => ({
  useGoatBotSession: (items: unknown, _task: unknown, member: unknown) => {
    state.memberArgs.push(member ?? null);
    const session = {
      availability: { kind: "ready", bot: { environmentId: "env", threadId: "bot" } },
      supportsTaskThreads: state.supported,
      rows: [],
      visibleTurnItems: items,
      marker: {},
    };
    state.sessions.push(session);
    return session;
  },
}));
vi.mock("../components/goatBot/useBotRoster", () => ({
  useBotRoster: () => ({
    bots: state.bots,
    botsLoaded: state.botsLoaded,
    botsPending: false,
    environmentId: "env",
  }),
}));
vi.mock("../components/goatBot/goatBotHooks", () => ({ useLegacyGlobalAgentRoute: () => null }));
vi.mock("../components/goatBot/useGoatBotHome", () => ({ useGoatBotHomeSettings: () => ({}) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
import { GoatBotTaskRoute, Route } from "./_chat.bot";
import type { useGoatBotSession } from "../components/goatBot/useGoatBotSession";

it.each([
  { narrow: false, beside: true, overlay: false },
  { narrow: true, beside: true, overlay: true },
  { narrow: false, beside: false, overlay: true },
])(
  "chooses task layout for viewport and client preference %#",
  async ({ narrow, beside, overlay }) => {
    state.narrow = narrow;
    state.beside = beside;
    await using screen = await render(
      <GoatBotTaskRoute
        environmentId={EnvironmentId.make("env")}
        session={
          { visibleTurnItems: [], rows: [] } as unknown as ReturnType<typeof useGoatBotSession>
        }
        taskId={ChannelTaskId.make("task")}
      />,
      { router: false },
    ); // Navigation is not exercised here.
    await expect.element(screen.getByText(overlay ? "Back to Tasks" : "Close")).toBeVisible();
    if (overlay) expect(screen.getByText("Main chat").query()).toBeNull();
    else await expect.element(screen.getByText("Main chat")).toBeVisible();
  },
);

it("shares the entry session between main chat and task pane", async () => {
  state.narrow = false;
  state.beside = true;
  state.supported = true;
  state.sessions = [];
  state.chatSession = null;
  state.paneSession = null;
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
  await expect.element(screen.getByText("Main chat")).toBeVisible();
  expect(state.sessions).toHaveLength(1);
  expect(state.paneSession).toBe(state.sessions[0]);
  expect(state.chatSession).toMatchObject({ marker: state.sessions[0]?.marker });
});

it("ignores a task query when the server lacks task threads", async () => {
  state.supported = false;
  state.navigate.mockClear();
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
  await expect.element(screen.getByText("Main chat")).toBeVisible();
  expect(screen.getByText("Close").query()).toBeNull();
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/$environmentId/$threadId", replace: true }),
  );
});

it("opens a member's task with that member's own conversation, never the main bot's", async () => {
  state.supported = true;
  state.shellRefs = [];
  state.memberArgs = [];
  state.bots = [
    { botId: "research", role: "member", environmentId: "env", sessionThreadId: "thread-research" },
  ];
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task"), bot: BotId.make("research") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  try {
    await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
    await expect.element(screen.getByText("Main chat")).toBeVisible();
    expect(state.memberArgs.at(-1)).toMatchObject({ botId: "research" });
    expect(state.shellRefs.at(-1)).toMatchObject({ threadId: "thread-research" });
  } finally {
    state.bots = [];
  }
});

it("says a named bot isn't available instead of opening the main bot", async () => {
  state.memberArgs = [];
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task"), bot: BotId.make("unknown") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  await using screen = await render(<Component />);
  await expect.element(screen.getByText("This bot isn't available")).toBeVisible();
  expect(screen.getByText("Main chat").query()).toBeNull();
});

it("opens a bot the create just returned when the list read after it failed, instead of waiting", async () => {
  const environmentId = EnvironmentId.make("env");
  forgetNewBotEnvironment(environmentId);
  const fresh = {
    botId: "fresh",
    role: "member",
    name: "New bot",
    environmentId: "env",
    sessionThreadId: "thread-fresh",
  };
  startNewBot(
    environmentId,
    [],
    async () => fresh as never,
    () => {},
    {},
    () => "request-1",
  );
  await vi.waitFor(() => expect(newBotSlot(environmentId).created).toHaveLength(1));
  state.bots = [];
  state.botsLoaded = false;
  state.memberArgs = [];
  state.shellRefs = [];
  state.chatSession = null;
  using _search = vi.spyOn(Route, "useSearch").mockReturnValue({ bot: BotId.make("fresh") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  try {
    await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
    await expect.element(screen.getByText("Main chat")).toBeVisible();
    expect(state.memberArgs.at(-1)).toMatchObject({ botId: "fresh" });
    expect(state.shellRefs.at(-1)).toMatchObject({ threadId: "thread-fresh" });
    expect(state.chatSession).toMatchObject({ availability: { kind: "ready" } });
  } finally {
    state.botsLoaded = true;
    forgetNewBotEnvironment(environmentId);
  }
});

it("a deleted member's task beside its chat shows the chat as deleted and offers Restore", async () => {
  state.narrow = false;
  state.beside = true;
  state.supported = true;
  state.restore.mockClear();
  const deleted = {
    botId: "research",
    role: "member",
    name: "Research",
    state: "deleted",
    environmentId: "env",
    sessionThreadId: "thread-research",
  };
  state.bots = [deleted];
  using _search = vi
    .spyOn(Route, "useSearch")
    .mockReturnValue({ task: ChannelTaskId.make("task"), bot: BotId.make("research") });
  const Component = Route.options.component;
  if (!Component) throw new Error("missing route component");
  try {
    await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
    await expect.element(screen.getByText("Chat removed")).toBeVisible();
    await screen.getByRole("button", { name: "Restore" }).click();
    expect(state.restore).toHaveBeenCalledWith(deleted);
  } finally {
    state.bots = [];
  }
});

const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const turnChip = (() => {
  const at = "2026-11-12T03:00:00.000Z";
  const item = decodeItem({
    id: "chip",
    threadId: "bot",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "notification",
    source: { kind: "background_task" },
    outcome: "updated",
    summary: "Work updated",
    ledgerTask: {
      taskId: "turn-1",
      kind: "turn",
      conversationId: "conv-1",
      taskVersion: 1,
      title: "Turn",
      status: "running",
      originKind: "goat",
      requesterLabel: "Jun",
      createdAt: at,
      updatedAt: at,
      worker: { environmentId: "env", threadId: "goat-bot-session:s1", runId: "run-1" },
      openQuestionCount: 0,
    },
  });
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
})();

it.each([
  { narrow: true, bounded: true, reads: [] },
  { narrow: false, bounded: true, reads: ["goat-bot-session:s1"] },
  { narrow: false, bounded: false, reads: [] },
])(
  "reads the main chat's turn sessions only while that chat shows beside the task, from a bounded server %#",
  async ({ narrow, bounded, reads }) => {
    state.narrow = narrow;
    state.boundedSnapshots = bounded;
    state.beside = true;
    state.supported = true;
    state.bots = [];
    state.items = [turnChip];
    state.sessionReads = [];
    using _search = vi
      .spyOn(Route, "useSearch")
      .mockReturnValue({ task: ChannelTaskId.make("task") });
    const Component = Route.options.component;
    if (!Component) throw new Error("missing route component");
    try {
      await using screen = await render(<Component />, { router: false }); // Search and navigation are mocked.
      await expect.element(screen.getByText(narrow ? "Back to Tasks" : "Close")).toBeVisible();
      expect([...new Set(state.sessionReads)]).toEqual(reads);
    } finally {
      state.items = [];
      state.boundedSnapshots = true;
    }
  },
);
