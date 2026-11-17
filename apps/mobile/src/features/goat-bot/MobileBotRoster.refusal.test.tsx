import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

// The mocks are MobileBotRoster.test.tsx's: vi.mock and vi.hoisted do not reach across files.
const state = vi.hoisted(() => ({
  alert: vi.fn(),
  members: null as null | Record<string, unknown>,
  manage: {
    canCreate: true,
    canManage: true,
    canEdit: true,
    mayManage: true,
    create: vi.fn(async (..._args: unknown[]): Promise<object | string> => ({
      botId: "research",
      name: "Research",
      avatar: null,
      purpose: "",
      defaultModelSelection: null,
    })),
    update: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
    hide: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    restore: vi.fn(async () => true),
  },
  sheet: null as null | {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
    onClose: () => void;
    extraChanged?: boolean;
    colorEditable?: boolean;
  },
  modelEditable: true,
  colorEditable: true,
  pickModel: null as null | ((model: object | null) => void),
  // The roster's list, environment and reads; each test takes its own environment.
  roster: {
    environmentId: "env",
    listedBots: [] as Array<object> | null,
    refreshBots: vi.fn(),
    supportsMembers: true,
    membersUnknown: false,
    connected: true,
  },
  requests: 0,
  newBotRow: null as unknown,
  // Where the person is: the navigation state, the app's state, the bot's environment, and the
  // environments the app still has.
  navState: { index: 0, routes: [{ key: "home", name: "Home" }] } as {
    index: number;
    routes: Array<{ key: string; name: string; params?: object }>;
  },
  appState: "active",
  rosterError: null as string | null,
  mainUnreadable: false,
  view: { preview: undefined as string | undefined, mainEnvironmentId: null as string | null },
  // The open callbacks the panel last handed the list.
  open: null as null | {
    onOpenBot: (bot: object) => void;
    onOpenTask?: (bot: object, taskId: string) => void;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ getState: () => state.navState, getParent: () => undefined }),
}));
// The roster panel's Android row menu and its haptic; these tests run as iOS and never draw it.
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: () => null }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Medium: "medium" },
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Pressable: (props: { children: React.ReactNode; onPress?: () => void }) => (
    <button onClick={props.onPress}>{props.children}</button>
  ),
  Alert: { alert: state.alert },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return state.appState;
    },
  },
}));
// The computers this phone may no longer read; the main bot's saved computer is "env" unless a test moves it.
const readable = vi.hoisted(() => ({ refused: new Set(["old"]), botComputer: "env" }));
// As the real preview, nothing from a computer this phone may no longer read.
vi.mock("./useMobileBotPreview", () => ({
  useMobileBotPreview: (botRef: { environmentId: string } | null) =>
    botRef === null || readable.refused.has(botRef.environmentId)
      ? null
      : { text: "The build is waiting on you.", unread: false },
}));
// Readability is the real one, over the stand-ins below, narrowed by the computers a test refuses.
vi.mock("./useKeptPerComputer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useKeptPerComputer")>();
  return {
    ...actual,
    useComputerReadable: (environmentId: string | null) =>
      actual.useComputerReadable(environmentId as never) &&
      environmentId !== null &&
      !readable.refused.has(environmentId),
  };
});
// Every computer a test names is in the app's catalog.
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  class Everyone extends Map<string, object> {
    override has() {
      return true;
    }
  }
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({ isReady: true, entries: new Everyone() }),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
// The bot list every reader of a computer shares.
vi.mock("../../state/channels", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const read = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  return { channelEnvironment: { listBots: () => read } };
});
// Needs you's open asks read, refreshed when a computer refuses or leaves; idle here.
vi.mock("./openAsksRead", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const idle = Atom.make(AsyncResult.initial());
  return { openAsks: () => idle };
});
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({
    botRef: { environmentId: readable.botComputer, threadId: "bot" },
  }),
}));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: [],
    groups: { main: null, members: [], hidden: [], deleted: [] },
    supportsMembers: state.roster.supportsMembers,
    membersUnknown: state.roster.membersUnknown,
    connected: state.roster.connected,
    computerLabel: "Studio Mac",
    environmentId: state.roster.environmentId,
    slackEnabled: false,
    listedBots: state.roster.listedBots,
    refreshBots: state.roster.refreshBots,
    retryBots: state.roster.refreshBots,
    error: state.rosterError,
  }),
}));
// The list itself is the view's; this stand-in keeps what the panel gives it and draws its New bot row.
vi.mock("./MobileBotRosterView", () => ({
  MobileBotRosterView: (props: {
    members?: Record<string, unknown>;
    header?: React.ReactNode;
    newBotRow?: React.ReactNode;
    mainUnreadable?: boolean;
    preview?: string;
    mainEnvironmentId?: string | null;
    onOpenBot: (bot: object) => void;
    onOpenTask?: (bot: object, taskId: string) => void;
  }) => {
    state.members = props.members ?? null;
    state.mainUnreadable = props.mainUnreadable === true;
    state.view = { preview: props.preview, mainEnvironmentId: props.mainEnvironmentId ?? null };
    state.open = { onOpenBot: props.onOpenBot, onOpenTask: props.onOpenTask };
    return (
      <>
        {props.header}
        {props.newBotRow}
      </>
    );
  },
}));
vi.mock("./useMobileBotManage", () => ({ useMobileBotManage: () => state.manage }));
vi.mock("./useMobileGoatBotMemberModel", () => ({
  useMobileGoatBotMemberModelEditable: () => ({ editable: state.modelEditable }),
  useMobileGoatBotColorEditable: () => state.colorEditable,
}));
vi.mock("./MobileNewBotModel", () => ({
  MobileNewBotModel: (props: { onChange: (model: object | null) => void }) => {
    state.pickModel = props.onChange;
    return null;
  },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `request-${(state.requests += 1)}` }));
vi.mock("./MobileBotProfileSheet", () => ({
  MobileBotProfileSheet: (props: {
    mode: string;
    onSubmit: (changes: object) => Promise<string | null>;
    onClose: () => void;
    extraChanged?: boolean;
    colorEditable?: boolean;
    children?: React.ReactNode;
  }) => {
    state.sheet = props;
    return (
      <>
        <p>{(props as { initial?: { name?: string } }).initial?.name}</p>
        {props.children}
      </>
    );
  },
}));
import { MobileBotRoster } from "./MobileBotRosterPanel";
import { channelEnvironment } from "../../state/channels";
import { environmentPresentations } from "../../state/presentation";
import { followKeptPerComputerCatalog } from "./useKeptPerComputer";

const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const botListAtom = channelEnvironment.listBots({
  environmentId: "env" as never,
  input: {},
}) as unknown as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>>;
const member = { botId: "research", name: "Research", hidden: false };
type Choice = { text: string; onPress?: () => void };
const choices = () => state.alert.mock.calls.at(-1)?.[2] as Array<Choice>;
const choose = (text: string) =>
  choices()
    .find((choice) => choice.text === text)
    ?.onPress?.();

const stored = (botId: string, name: string, extra: object = {}) => ({
  botId,
  role: "member",
  name,
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  ...extra,
});

/** The roster on its own computer, in a registry that follows refusals as the app's does. */
async function refusableRoster(environmentId: string) {
  state.alert.mockClear();
  state.manage.hide.mockClear();
  state.manage.restore.mockClear();
  state.roster.environmentId = environmentId;
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  const container = document.createElement("div");
  const root = createRoot(container);
  let visible = true;
  const opened = vi.fn();
  const openedTask = vi.fn();
  const draw = () =>
    act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <MobileBotRoster
            selectedKey={null}
            onOpenBot={opened}
            onOpenTask={openedTask}
            visible={visible}
          />
        </RegistryContext>,
      ),
    );
  await draw();
  const members = () =>
    state.members as {
      onLongPressBot: (entry: object) => void;
      onRestoreDeleted: (bot: object) => void;
    };
  const setLink = (connection: object) =>
    registry.set(
      presentationsAtom,
      new Map([
        [
          environmentId,
          {
            connection,
            serverConfig: { environment: { capabilities: { goatBotProfiles: true } } },
          },
        ],
      ]),
    );
  const link = (connection: object) => act(async () => setLink(connection));
  let left = false;
  return {
    container,
    opened,
    openedTask,
    members,
    open: () => state.open ?? { onOpenBot: () => {} },
    link,
    /** The connection changes in the store; React has not rendered it yet. */
    linkNow: setLink,
    /** The person navigates away: the roster unmounts while a native alert stays up. */
    leave: () => {
      left = true;
      return act(async () => root.unmount());
    },
    /** Home covers the roster: it stays mounted, hidden, while a native alert stays up. */
    cover: () => {
      visible = false;
      return draw();
    },
    /** Home's selection moves the roster to another computer, which this phone may read. */
    moveTo: (other: string) => {
      state.roster.environmentId = other;
      return draw();
    },
    answerList: (result: AsyncResult.AsyncResult<unknown, unknown>) =>
      act(async () => registry.set(botListAtom, result)),
    /** The bot list answers in the store; React has not rendered it yet. */
    answerListNow: (result: AsyncResult.AsyncResult<unknown, unknown>) =>
      registry.set(botListAtom, result),
    longPress: () => act(async () => members().onLongPressBot({ kind: "member", profile: member })),
    choose: (text: string) => act(async () => choose(text)),
    [Symbol.asyncDispose]: async () => {
      if (!left) await act(async () => root.unmount());
      stop();
    },
  };
}
const refusedList = AsyncResult.failure(
  Cause.fail({ _tag: "EnvironmentAuthorizationError", message: "Not allowed." }),
);

it("closes an open Edit sheet, and the bot's name in it, once the bot list or the connection refuses", async () => {
  await using view = await refusableRoster("env");
  await view.link({ phase: "connected" });
  await view.answerList(AsyncResult.success({ bots: [] }));
  await view.longPress();
  await view.choose("Edit");
  expect(view.container.textContent).toContain("Research");
  await view.answerList(refusedList);
  expect(view.container.textContent).not.toContain("Research");
  // Readable again, Edit opens again; then the connection refuses this phone.
  await view.answerList(AsyncResult.success({ bots: [] }));
  await view.longPress();
  await view.choose("Edit");
  expect(view.container.textContent).toContain("Research");
  await view.link({ phase: "error", failure: { kind: "blocked", reason: "authentication" } });
  expect(view.container.textContent).not.toContain("Research");
  // Closed, not hidden: connecting again does not bring the sheet back.
  await view.link({ phase: "connected" });
  expect(view.container.textContent).not.toContain("Research");
});

it("an action menu opened before a refusal does nothing when a choice is pressed after it, and no new one opens", async () => {
  await using view = await refusableRoster("env-menu");
  await view.longPress();
  await view.link({ phase: "error", failure: { kind: "blocked", reason: "permission" } });
  const menus = state.alert.mock.calls.length;
  await view.choose("Hide");
  expect(state.manage.hide).not.toHaveBeenCalled();
  await view.choose("Edit");
  expect(view.container.textContent).not.toContain("Research");
  await view.choose("Delete");
  // No confirmation follows, and a long press after the refusal opens no menu.
  expect(state.alert.mock.calls.length).toBe(menus);
  await view.longPress();
  expect(state.alert.mock.calls.length).toBe(menus);
});

it("a menu left open does nothing once the roster has left the screen", async () => {
  await using view = await refusableRoster("env-a");
  await view.longPress();
  await view.leave();
  await view.choose("Hide");
  expect(state.manage.hide).not.toHaveBeenCalled();
});

it.each([
  ["Hide", "hide", (view: Awaited<ReturnType<typeof refusableRoster>>) => view.longPress()],
  [
    "Delete",
    "remove",
    async (view: Awaited<ReturnType<typeof refusableRoster>>) => {
      await view.longPress();
      await view.choose("Delete");
    },
  ],
  [
    "Restore",
    "restore",
    (view: Awaited<ReturnType<typeof refusableRoster>>) =>
      act(async () => view.members().onRestoreDeleted({ ...member, state: "deleted" })),
  ],
] as const)(
  "a %s choice does nothing once its roster is hidden but still mounted",
  async (choice, action, open) => {
    await using view = await refusableRoster("env-cover");
    await open(view);
    await view.cover();
    await view.choose(choice);
    expect(state.manage[action]).not.toHaveBeenCalled();
  },
);

it("a menu choice pressed after a refusal reaches the store, before the roster renders it, does nothing", async () => {
  await using view = await refusableRoster("env");
  await view.link({ phase: "connected" });
  await view.answerList(AsyncResult.success({ bots: [] }));
  await view.longPress();
  view.linkNow({ phase: "error", failure: { kind: "blocked", reason: "authentication" } });
  await view.choose("Hide");
  expect(state.manage.hide).not.toHaveBeenCalled();
});

it("a Restore confirmation opened before a refusal restores nothing when pressed after it", async () => {
  await using view = await refusableRoster("env-restore");
  await act(async () => view.members().onRestoreDeleted({ ...member, state: "deleted" }));
  await view.link({ phase: "error", failure: { kind: "blocked", reason: "authentication" } });
  await view.choose("Restore");
  expect(state.manage.restore).not.toHaveBeenCalled();
});

it("an Edit sheet opened on one computer closes once Home moves the roster to another and the first refuses", async () => {
  await using view = await refusableRoster("env-a");
  await view.longPress();
  await view.choose("Edit");
  expect(view.container.textContent).toContain("Research");
  await view.moveTo("env-b");
  await view.link({ phase: "error", failure: { kind: "blocked", reason: "authentication" } });
  expect(view.container.textContent).not.toContain("Research");
});

it("a menu opened on one computer does nothing once Home has moved the roster to another", async () => {
  await using view = await refusableRoster("env-a");
  await view.longPress();
  await view.moveTo("env-b");
  await view.choose("Hide");
  expect(state.manage.hide).not.toHaveBeenCalled();
  await view.moveTo("env-a");
  await view.longPress();
  await view.moveTo("env-b");
  const menus = state.alert.mock.calls.length;
  await view.choose("Delete");
  // No confirmation follows: the Delete pressed on the other computer opened nothing.
  expect(state.alert.mock.calls.length).toBe(menus);
});

it("Save in an open Edit sheet sends nothing once a bot-list refusal reaches the store, before it renders", async () => {
  await using view = await refusableRoster("env");
  await view.link({ phase: "connected" });
  await view.answerList(AsyncResult.success({ bots: [] }));
  await view.longPress();
  await view.choose("Edit");
  const sheet = state.sheet;
  expect(sheet).not.toBeNull();
  view.answerListNow(refusedList);
  await act(async () => {
    await sheet?.onSubmit({ name: "Research 2" });
  });
  expect(state.manage.update).not.toHaveBeenCalled();
});

/** A roster that may read its computer and lists no bots yet, with a create that records each send. */
async function creatableRoster(environmentId: string) {
  state.roster.listedBots = [];
  state.rosterError = null;
  state.appState = "active";
  state.navState = { index: 0, routes: [{ key: "home", name: "Home" }] };
  state.manage.create.mockReset();
  const view = await refusableRoster(environmentId);
  await view.link({ phase: "connected" });
  await view.answerList(AsyncResult.success({ bots: [] }));
  return view;
}

it("New bot sends no create once a bot-list refusal reaches the store, before it renders", async () => {
  await using view = await creatableRoster("env-new-refused");
  view.answerListNow(refusedList);
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.manage.create).not.toHaveBeenCalled();
});

it("Retry sends no create once a bot-list refusal reaches the store, before it renders", async () => {
  await using view = await creatableRoster("env-retry-refused");
  state.manage.create.mockResolvedValueOnce("The server could not create the bot.");
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.manage.create).toHaveBeenCalledOnce();
  const retry = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  view.answerListNow(refusedList);
  await act(async () => retry?.click());
  expect(state.manage.create).toHaveBeenCalledOnce();
});

it("a create that answers after a bot-list refusal reaches the store, before it renders, opens nothing", async () => {
  await using view = await creatableRoster("env-open-refused");
  const answers: Array<(value: object | string) => void> = [];
  state.manage.create.mockImplementation(
    () => new Promise<object | string>((resolve) => answers.push(resolve)),
  );
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.manage.create).toHaveBeenCalledOnce();
  view.answerListNow(refusedList);
  await act(async () => answers.shift()?.(stored("research", "New bot")));
  expect(view.opened).not.toHaveBeenCalled();
});

it("a New bot refused before it renders claims no slot: pressed again once readable, it sends its create", async () => {
  await using view = await creatableRoster("env-refused-then-readable");
  view.answerListNow(refusedList);
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.manage.create).not.toHaveBeenCalled();
  await view.answerList(AsyncResult.success({ bots: [] }));
  await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
  expect(state.manage.create).toHaveBeenCalledOnce();
});
type Refusable = Awaited<ReturnType<typeof refusableRoster>>;
/** A control the roster hands out: made ready on a readable roster, then pressed; and what it does. */
type Control = readonly [
  name: string,
  ready: (view: Refusable) => Promise<() => unknown>,
  acted: (view: Refusable, menus: number) => void,
];
const controls: ReadonlyArray<Control> = [
  [
    "a member row",
    async (view) => {
      const { onOpenBot } = view.open();
      return () => onOpenBot({ kind: "member", profile: member });
    },
    (view) =>
      expect(view.opened).toHaveBeenCalledExactlyOnceWith({ kind: "member", profile: member }),
  ],
  [
    "a Needs you ask",
    async (view) => {
      const { onOpenTask } = view.open();
      expect(onOpenTask).toBeDefined();
      return () => onOpenTask?.({ kind: "member", profile: member }, "task-1");
    },
    (view) =>
      expect(view.openedTask).toHaveBeenCalledExactlyOnceWith(
        { kind: "member", profile: member },
        "task-1",
      ),
  ],
  [
    "a created bot's row",
    async (view) => {
      state.manage.create.mockResolvedValueOnce(stored("scout", "Scout"));
      await act(async () => (state.members as { onNewBot: () => void }).onNewBot());
      view.opened.mockClear();
      const row = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Scout",
      );
      expect(row).toBeDefined();
      return () => row?.click();
    },
    (view) =>
      expect(view.opened).toHaveBeenCalledExactlyOnceWith({
        kind: "member",
        profile: stored("scout", "Scout"),
      }),
  ],
  [
    "a long press",
    async (view) => {
      const { onLongPressBot } = view.members();
      return () => onLongPressBot({ kind: "member", profile: member });
    },
    (_view, menus) => expect(state.alert.mock.calls.length).toBe(menus + 1),
  ],
  [
    "Restore",
    async (view) => {
      const { onRestoreDeleted } = view.members();
      return () => onRestoreDeleted({ ...member, state: "deleted" });
    },
    (_view, menus) => expect(state.alert.mock.calls.length).toBe(menus + 1),
  ],
];

it.each(controls)(
  "%s opens nothing once a bot-list refusal reaches the store, before it renders",
  async (_name, ready) => {
    await using view = await creatableRoster("env-press-refused");
    const press = await ready(view);
    const menus = state.alert.mock.calls.length;
    const creates = state.manage.create.mock.calls.length;
    view.answerListNow(refusedList);
    await act(async () => press());
    expect(view.opened).not.toHaveBeenCalled();
    expect(view.openedTask).not.toHaveBeenCalled();
    expect(state.alert.mock.calls.length).toBe(menus);
    expect(state.manage.create.mock.calls.length).toBe(creates);
  },
);

it.each(controls)("%s still acts while its computer may be read", async (_name, ready, acted) => {
  await using view = await creatableRoster("env-press-readable");
  const press = await ready(view);
  const menus = state.alert.mock.calls.length;
  await act(async () => press());
  acted(view, menus);
});
