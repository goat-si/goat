import { forgetNewBotEnvironment, newBotSlot, startNewBot } from "@goat/client-runtime/goatBot";
import { BotId, ChannelTaskId, EnvironmentId, OrchestrationV2TurnItemJson } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Profiler, cloneElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { navigationBlocked } from "../lib/navigationHolds";
import { observeResize } from "../lib/observeResize";

const state = vi.hoisted(() => ({
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
  /** The chat shows Home docked beside its conversation. */
  homeDocked: false,
  homeListeners: new Set<() => void>(),
  /** The slot of a modal the chat stand-in opens: a sheet, a dialog or an alert dialog. */
  modalSlot: "dialog-popup",
}));
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
// The real chat reads its steps through GoatBotStepsReader around its conversation, paused while
// hidden, and its composer keeps a draft in its own state.
vi.mock("../components/goatBot/GoatBotChatView", async () => {
  const { GoatBotStepsReader } = await import("../components/goatBot/GoatBotStepsProvider");
  // A held draft, open file or edited name: the real surfaces render this hold.
  const { HoldsNavigation } = await import("../lib/navigationHolds");
  const { createPortal } = await import("react-dom");
  const { useContext, useState, useSyncExternalStore } = await import("react");
  const { GoatBotChatHidden, GoatBotHomeDockedRegistry } =
    await import("../components/goatBot/goatBotLayout");
  // The app's own sheet: Base UI empties its portal container before removing it.
  const { Sheet, SheetPopup, SheetTitle } = await import("../components/ui/sheet");
  // A draft, Home's memory wording or an edit in a dialog: the real editors hold while they hold text.
  function HeldInput({ label }: { label: string }) {
    const [value, setValue] = useState("");
    return (
      <>
        <input
          aria-label={label}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {value === "" ? null : <HoldsNavigation />}
      </>
    );
  }
  return {
    GoatBotChatView: (props: { removal?: string | null; onRestore?: () => void }) => {
      state.chatSession = props;
      const hidden = useContext(GoatBotChatHidden);
      const registerHomeDocked = useContext(GoatBotHomeDockedRegistry);
      // Home opens and closes inside the chat, without the route rendering again.
      const homeDocked = useSyncExternalStore(
        (listener) => {
          state.homeListeners.add(listener);
          return () => state.homeListeners.delete(listener);
        },
        () => state.homeDocked,
      );
      // Home's sheet or Edit bot: a modal Base UI portals out, open until the person closes it.
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <GoatBotStepsReader rows={[]} paused={hidden}>
          <div>
            <span>Main chat</span>
            <HeldInput label="Message" />
            <button type="button" onClick={() => setModalOpen(true)}>
              Open modal
            </button>
            {state.modalSlot === "base-ui-sheet" ? (
              <Sheet open={modalOpen} onOpenChange={setModalOpen}>
                <SheetPopup showCloseButton={false}>
                  <SheetTitle>Chat modal</SheetTitle>
                  <HeldInput label="In modal" />
                  <button type="button" onClick={() => setModalOpen(false)}>
                    Close modal
                  </button>
                </SheetPopup>
              </Sheet>
            ) : modalOpen ? (
              createPortal(
                <div role="dialog" aria-label="Chat modal" data-slot={state.modalSlot} data-open>
                  <HeldInput label="In modal" />
                  <button type="button" onClick={() => setModalOpen(false)}>
                    Close modal
                  </button>
                </div>,
                document.body,
              )
            ) : null}
            {homeDocked ? (
              <aside ref={registerHomeDocked} data-goat-bot-home-docked aria-label="Home">
                <HeldInput label="New wording" />
              </aside>
            ) : null}
            {/* A chat menu or Home's sheet renders outside the row, as Base UI portals do. */}
            {createPortal(
              <div role="dialog" aria-label="Chat popup">
                <button type="button">In popup</button>
              </div>,
              document.body,
            )}
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
vi.mock("../components/goatBot/GoatBotTaskPane", async () => {
  const { createPortal } = await import("react-dom");
  const { useGoatBotHiddenChatNotice } =
    await import("../components/goatBot/GoatBotHiddenChatNotice");
  return {
    GoatBotTaskPane: ({ narrow, session }: { narrow: boolean; session: object }) => {
      state.paneSession = session;
      const hiddenChat = useGoatBotHiddenChatNotice(narrow);
      return (
        <section>
          <h2 tabIndex={-1} data-goat-bot-task-heading>
            Task heading
          </h2>
          <button type="button" aria-describedby={hiddenChat.describedBy}>
            {narrow ? "Back to Tasks" : "Close"}
          </button>
          {hiddenChat.notice}
          {/* The task pane's own menus portal out of the row too. */}
          {createPortal(
            <div role="menu" aria-label="Task menu">
              <button type="button">In task menu</button>
            </div>,
            document.body,
          )}
        </section>
      );
    },
  };
});
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

/** The test window's width, which decides the 980px gate; restored on dispose. */
async function windowWidth(width: number) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 900);
  return { [Symbol.asyncDispose]: () => page.viewport(before.width, before.height) };
}

/** A container that sizes the route's row, as the sidebar leaves it. */
function row(width: number) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return container;
}

const taskRoute = (
  <GoatBotTaskRoute
    environmentId={EnvironmentId.make("env")}
    session={{ visibleTurnItems: [], rows: [] } as unknown as ReturnType<typeof useGoatBotSession>}
    taskId={ChannelTaskId.make("task")}
  />
);

it.each([
  { window: 1440, width: 720, setting: true, overlay: false },
  { window: 1440, width: 719, setting: true, overlay: true },
  { window: 960, width: 1600, setting: true, overlay: true },
  { window: 1440, width: 1128, setting: false, overlay: true },
])(
  "the task sits beside the chat only while the chat keeps 400px: window $window, row $width, setting $setting",
  async ({ window, width, setting, overlay }) => {
    state.beside = setting;
    await using _window = await windowWidth(window);
    // Navigation is not exercised here.
    await using screen = await render(taskRoute, { router: false, container: row(width) });
    await expect.element(screen.getByText(overlay ? "Back to Tasks" : "Close")).toBeVisible();
    if (overlay) await expect.element(screen.getByText("Main chat")).not.toBeVisible();
    else await expect.element(screen.getByText("Main chat")).toBeVisible();
  },
);

it("a draft in the chat survives the task replacing it and the chat coming back", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Keep this draft");
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  container.style.width = "1000px";
  await expect.element(screen.getByText("Close")).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "Message" }))
    .toHaveValue("Keep this draft");
});

it("focus in the chat moves to the task heading when the task replaces it; focus elsewhere stays", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(
    <>
      <button type="button">Search</button>
      {taskRoute}
    </>,
    { router: false, container }, // No navigation.
  );
  const message = screen.getByRole("textbox", { name: "Message" });
  await userEvent.click(message);
  container.style.width = "700px";
  await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();

  container.style.width = "1000px";
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Search" })).toHaveFocus();
});

it("a chat the task replaces holds no navigation, and holds again once shown", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Draft");
  expect(navigationBlocked()).toBe(true);
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  expect(navigationBlocked()).toBe(false);
  container.style.width = "1000px";
  await expect.element(screen.getByText("Close")).toBeVisible();
  expect(navigationBlocked()).toBe(true);
});

it("focus in a popup the chat portalled out moves to the task heading when the task replaces the chat", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "In popup" }));
  container.style.width = "700px";
  await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();
});

it.each(["dialog", "menu"] as const)(
  "focus in a %s the chat does not own (the command palette, a sidebar menu) stays when the task replaces the chat",
  async (role) => {
    state.beside = true;
    await using _window = await windowWidth(1440);
    const container = row(1000);
    await using screen = await render(
      <>
        {taskRoute}
        <div role={role} aria-label="Elsewhere">
          <button type="button">Outside the chat</button>
        </div>
      </>,
      { router: false, container }, // No navigation.
    );
    await expect.element(screen.getByText("Close")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Outside the chat" }));
    container.style.width = "700px";
    await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Outside the chat" })).toHaveFocus();
  },
);

it("the window narrowing past 980px alone also replaces the chat and hands focus to the task", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  await using screen = await render(taskRoute, { router: false, container: row(925) }); // No navigation.
  await userEvent.click(screen.getByRole("textbox", { name: "Message" }));
  await page.viewport(979, 900);
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();
});

it("turning the beside setting off while the task sits beside replaces the chat, and on brings it back", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  // Navigation is not exercised here.
  await using screen = await render(taskRoute, { router: false, container: row(1000) });
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.click(screen.getByRole("textbox", { name: "Message" }));
  state.beside = false;
  // A fresh element: the setting is read through a mock, not a subscription.
  await screen.rerender(cloneElement(taskRoute));
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await expect.element(screen.getByText("Main chat")).not.toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();
  state.beside = true;
  // A fresh element: the setting is read through a mock, not a subscription.
  await screen.rerender(cloneElement(taskRoute));
  await expect.element(screen.getByText("Close")).toBeVisible();
  await expect.element(screen.getByText("Main chat")).toBeVisible();
});

it("performance invariant: sweeping the window from 1440 to 960 commits the route once per threshold at most", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const sidebar = 312;
  const container = row(1440 - sidebar);
  let commits = 0;
  await using screen = await render(
    <Profiler id="task-route" onRender={() => commits++}>
      {taskRoute}
    </Profiler>,
    { router: false, container }, // No navigation.
  );
  await expect.element(screen.getByText("Close")).toBeVisible();
  let resized = () => {};
  const stop = observeResize(container, () => resized());
  try {
    commits = 0;
    for (let width = 1424; width >= 960; width -= 16) {
      await page.viewport(width, 900);
      const delivered = new Promise<void>((resolve) => (resized = resolve));
      container.style.width = `${width - sidebar}px`;
      await delivered;
    }
  } finally {
    stop();
  }
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  expect(commits).toBeGreaterThan(0);
  expect(commits).toBeLessThanOrEqual(2);
});

it("shares the entry session between main chat and task pane", async () => {
  state.beside = true;
  state.supported = true;
  state.sessions = [];
  state.chatSession = null;
  state.paneSession = null;
  await using _window = await windowWidth(1440);
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
  await using _window = await windowWidth(1440);
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
  state.beside = true;
  state.supported = true;
  state.restore.mockClear();
  await using _window = await windowWidth(1440);
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
  { width: 700, bounded: true, reads: [] },
  { width: 1128, bounded: true, reads: ["goat-bot-session:s1"] },
  { width: 1128, bounded: false, reads: [] },
])(
  "reads the main chat's turn sessions only while that chat shows beside the task, from a bounded server %#",
  async ({ width, bounded, reads }) => {
    state.boundedSnapshots = bounded;
    state.beside = true;
    state.supported = true;
    state.bots = [];
    state.items = [turnChip];
    state.sessionReads = [];
    await using _window = await windowWidth(1440);
    using _search = vi
      .spyOn(Route, "useSearch")
      .mockReturnValue({ task: ChannelTaskId.make("task") });
    const Component = Route.options.component;
    if (!Component) throw new Error("missing route component");
    try {
      // Search and navigation are mocked.
      await using screen = await render(<Component />, { router: false, container: row(width) });
      await expect.element(screen.getByText(width < 720 ? "Back to Tasks" : "Close")).toBeVisible();
      expect([...new Set(state.sessionReads)]).toEqual(reads);
    } finally {
      state.items = [];
      state.boundedSnapshots = true;
    }
  },
);

it("focus in a menu the task pane portalled out stays there when the task replaces the chat", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "In task menu" }));
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "In task menu" })).toHaveFocus();
});

it("the chat is beside the task after the first commit, not deferred to a timer", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  // Queued from the first commit. render() drains effects inside act() first, so this rules out a
  // timer, not a passive effect; the ref callback's layout-phase update is what precedes paint.
  let seen: string | null = null;
  const probe = (element: HTMLElement | null) => {
    if (element === null || seen !== null) return;
    queueMicrotask(() => {
      seen = container.querySelector("[hidden]") === null ? "beside" : "hidden";
    });
  };
  await using screen = await render(
    <>
      {taskRoute}
      <span ref={probe} />
    </>,
    { router: false, container }, // No navigation.
  );
  await expect.element(screen.getByText("Close")).toBeVisible();
  expect(seen).toBe("beside");
});

/** Docks or removes Home inside the chat stand-in; undone on dispose. */
async function dockHome(docked: boolean) {
  const set = (value: boolean) =>
    act(() => {
      state.homeDocked = value;
      for (const listener of state.homeListeners) listener();
    });
  await set(docked);
  return { [Symbol.asyncDispose]: () => set(false) };
}

it("with Home docked the task sits beside only while the row keeps 1072px; below it the task replaces chat and Home, which come back with their input", async () => {
  state.beside = true;
  await using _home = await dockHome(true);
  await using _window = await windowWidth(1366);
  // 1366 with the sidebar collapsed leaves the row 1310; opening the sidebar leaves 1054.
  const container = row(1310);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await expect.element(screen.getByText("Close")).toBeVisible();
  await userEvent.type(screen.getByRole("textbox", { name: "New wording" }), "Reply in English");
  container.style.width = "1054px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await expect.element(screen.getByText("Main chat")).not.toBeVisible();
  container.style.width = "1310px";
  await expect.element(screen.getByText("Close")).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "New wording" }))
    .toHaveValue("Reply in English");
});

it("a docked Home that mounts or unmounts (a reconnect) decides the layout again without a resize", async () => {
  state.beside = true;
  await using _window = await windowWidth(1366);
  await using screen = await render(taskRoute, { router: false, container: row(1054) }); // No navigation.
  await expect.element(screen.getByText("Close")).toBeVisible();
  {
    await using _home = await dockHome(true);
    await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  }
  await expect.element(screen.getByText("Close")).toBeVisible();
});

it("performance invariant: with Home docked, sweeping the window from 1440 to 960 commits the route once per threshold at most", async () => {
  state.beside = true;
  await using _home = await dockHome(true);
  await using _window = await windowWidth(1440);
  const sidebar = 312;
  const container = row(1440 - sidebar);
  let commits = 0;
  await using screen = await render(
    <Profiler id="task-route" onRender={() => commits++}>
      {taskRoute}
    </Profiler>,
    { router: false, container }, // No navigation.
  );
  await expect.element(screen.getByText("Close")).toBeVisible();
  let resized = () => {};
  const stop = observeResize(container, () => resized());
  try {
    commits = 0;
    for (let width = 1424; width >= 960; width -= 16) {
      await page.viewport(width, 900);
      const delivered = new Promise<void>((resolve) => (resized = resolve));
      container.style.width = `${width - sidebar}px`;
      await delivered;
    }
  } finally {
    stop();
  }
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  expect(commits).toBeGreaterThan(0);
  expect(commits).toBeLessThanOrEqual(2);
});

it.each(["sheet-popup", "dialog-popup", "alert-dialog-popup"])(
  "focus in a modal the chat opened (%s) stays in it when the task replaces the chat",
  async (slot) => {
    state.beside = true;
    state.modalSlot = slot;
    try {
      await using _window = await windowWidth(1440);
      const container = row(1000);
      await using screen = await render(taskRoute, { router: false, container }); // No navigation.
      await userEvent.click(screen.getByRole("button", { name: "Open modal" }));
      await userEvent.click(page.getByRole("textbox", { name: "In modal" }));
      container.style.width = "700px";
      await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
      await expect.element(page.getByRole("textbox", { name: "In modal" })).toHaveFocus();
    } finally {
      state.modalSlot = "dialog-popup";
    }
  },
);

it("a tooltip or popover closing while the task replaces the chat leaves focus where it was", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  // Focus rests on the page, as after a click on plain text in the task.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  expect(document.activeElement).toBe(document.body);
  // Base UI portals tooltips and popovers into the same kind of <body> child as its modals.
  const portal = document.createElement("div");
  portal.setAttribute("data-base-ui-portal", "");
  portal.append(Object.assign(document.createElement("div"), { role: "tooltip" }));
  await act(() => document.body.append(portal));
  // The removal's MutationObserver callback is a microtask, run before act() settles.
  await act(() => portal.remove());
  expect(document.activeElement).toBe(document.body);
});

it("a chat modal closed before the task replaced the chat does not move focus on a later tooltip", async () => {
  state.beside = true;
  state.modalSlot = "dialog-popup";
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await userEvent.click(screen.getByRole("button", { name: "Open modal" }));
  await userEvent.click(page.getByRole("textbox", { name: "In modal" }));
  await userEvent.click(page.getByRole("button", { name: "Close modal" }));
  await expect.element(page.getByRole("dialog", { name: "Chat modal" })).not.toBeInTheDocument();
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const portal = document.createElement("div");
  portal.setAttribute("data-base-ui-portal", "");
  portal.append(Object.assign(document.createElement("div"), { role: "tooltip" }));
  await act(() => document.body.append(portal));
  // The removal's MutationObserver callback is a microtask, run before act() settles.
  await act(() => portal.remove());
  expect(document.activeElement).toBe(document.body);
});

it("closing a modal the chat opened while the task replaces the chat sends focus to the task heading", async () => {
  state.beside = true;
  state.modalSlot = "dialog-popup";
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await userEvent.click(screen.getByRole("button", { name: "Open modal" }));
  await userEvent.click(page.getByRole("textbox", { name: "In modal" }));
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Close modal" }));
  await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();
});

it("closing the app's own sheet of the chat while the task replaces the chat sends focus to the task heading", async () => {
  state.beside = true;
  state.modalSlot = "base-ui-sheet";
  try {
    await using _window = await windowWidth(1440);
    const container = row(1000);
    await using screen = await render(taskRoute, { router: false, container }); // No navigation.
    await userEvent.click(screen.getByRole("button", { name: "Open modal" }));
    // The sheet's initial focus is its first field.
    await expect.element(page.getByRole("textbox", { name: "In modal" })).toHaveFocus();
    container.style.width = "700px";
    await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "In modal" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Chat modal" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Task heading" })).toHaveFocus();
  } finally {
    state.modalSlot = "dialog-popup";
  }
});

it("with Home docked at a 20px interface size, the task sits beside only while the row keeps 1260px, and a size change decides again", async () => {
  state.beside = true;
  await using _home = await dockHome(true);
  await using _window = await windowWidth(1440);
  const container = row(1100);
  const before = document.documentElement.style.fontSize;
  using _restore = {
    [Symbol.dispose]: () => {
      document.documentElement.style.fontSize = before;
    },
  };
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  // 16px: 320 + 400 + 352 = 1072 fits in 1100.
  await expect.element(screen.getByText("Close")).toBeVisible();
  // 20px: 320 + 500 + 440 = 1260 does not.
  await act(() => {
    document.documentElement.style.fontSize = "20px";
  });
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  container.style.width = "1259px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  container.style.width = "1260px";
  await expect.element(screen.getByText("Close")).toBeVisible();
});

const UNSAVED_BEHIND =
  "The chat behind this task has open or unsaved work. Leaving this task closes it and discards unsaved changes.";

it("with Home docked at 1366, unsaved Home wording behind the task is named next to Back to Tasks and describes it", async () => {
  state.beside = true;
  await using _home = await dockHome(true);
  await using _window = await windowWidth(1366);
  // 1366 with the sidebar collapsed leaves the row 1310; opening the sidebar leaves 1054.
  const container = row(1310);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  await userEvent.type(screen.getByRole("textbox", { name: "New wording" }), "Reply in English");
  container.style.width = "1054px";
  const leave = screen.getByRole("button", { name: "Back to Tasks" });
  await expect.element(leave).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent(UNSAVED_BEHIND);
  await expect.element(leave).toHaveAccessibleDescription(UNSAVED_BEHIND);
  // The chat comes back with the wording: nothing is behind the task any more.
  container.style.width = "1310px";
  await expect.element(screen.getByRole("button", { name: "Close" })).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent("");
  await expect
    .element(screen.getByRole("textbox", { name: "New wording" }))
    .toHaveValue("Reply in English");
});

it("the line goes when the work behind the task is cleared, and never shows when nothing is unsaved", async () => {
  state.beside = true;
  state.modalSlot = "dialog-popup";
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  container.style.width = "700px";
  const leave = screen.getByRole("button", { name: "Back to Tasks" });
  await expect.element(leave).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent("");
  await expect.element(leave).not.toHaveAccessibleDescription(UNSAVED_BEHIND);
  // An edit in a dialog the chat opened (Home's sheet, Edit bot), which stays over the task.
  container.style.width = "1000px";
  await userEvent.click(screen.getByRole("button", { name: "Open modal" }));
  await userEvent.type(page.getByRole("textbox", { name: "In modal" }), "Ada");
  container.style.width = "700px";
  await expect.element(screen.getByRole("status")).toHaveTextContent(UNSAVED_BEHIND);
  await userEvent.clear(page.getByRole("textbox", { name: "In modal" }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("");
});

it("a command palette closing while the task replaces the chat leaves focus where it was", async () => {
  state.beside = true;
  await using _window = await windowWidth(1440);
  const container = row(1000);
  await using screen = await render(taskRoute, { router: false, container }); // No navigation.
  container.style.width = "700px";
  await expect.element(screen.getByText("Back to Tasks")).toBeVisible();
  // A modal outside the chat, portalled to <body> as the command palette is.
  const palette = document.createElement("div");
  palette.setAttribute("data-slot", "command-dialog-popup");
  const search = Object.assign(document.createElement("input"), { ariaLabel: "Search commands" });
  palette.append(search);
  await act(() => document.body.append(palette));
  search.focus();
  // Closing it drops focus to the page, as removing a focused element does.
  await act(() => palette.remove());
  expect(document.activeElement).toBe(document.body);
});
