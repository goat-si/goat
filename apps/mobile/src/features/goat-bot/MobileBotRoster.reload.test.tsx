// The roster's development reload, alone in this file: the test DevTools hook below must exist
// before react-dom loads, and Vitest isolates each test file, so it reaches no other test.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

// React DOM's development refresh entry points, the ones Fast Refresh's runtime calls; it must
// exist before react-dom loads.
const devtools = vi.hoisted(() => {
  type Family = { current: unknown };
  type Renderer = {
    setRefreshHandler: (handler: ((type: unknown) => Family | undefined) | null) => void;
    scheduleRefresh: (
      root: unknown,
      update: { staleFamilies: Set<Family>; updatedFamilies: Set<Family> },
    ) => void;
  };
  const hook = {
    renderer: null as Renderer | null,
    root: null as unknown,
    supportsFiber: true,
    inject(renderer: Renderer) {
      hook.renderer = renderer;
      return 1;
    },
    onCommitFiberRoot(_rendererId: number, root: unknown) {
      hook.root = root;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  const previous: unknown = Reflect.get(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
  Object.assign(globalThis, { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook });
  return { hook, previous };
});

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
  }) => {
    state.members = props.members ?? null;
    state.mainUnreadable = props.mainUnreadable === true;
    state.view = { preview: props.preview, mainEnvironmentId: props.mainEnvironmentId ?? null };
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
const member = { botId: "research", name: "Research", hidden: false };
type Choice = { text: string; onPress?: () => void };
const choices = () => state.alert.mock.calls.at(-1)?.[2] as Array<Choice>;
const choose = (text: string) =>
  choices()
    .find((choice) => choice.text === text)
    ?.onPress?.();

it("a menu choice still acts after a development reload re-runs the roster's effects (#3501)", async () => {
  state.alert.mockClear();
  state.manage.hide.mockClear();
  const { renderer } = devtools.hook;
  if (!renderer) throw new Error("react-dom loaded before the test DevTools hook");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  // A new version of the same component, as Fast Refresh swaps in an edited module.
  const reloaded = vi.fn();
  const Reloaded = (props: Parameters<typeof MobileBotRoster>[0]) => {
    reloaded();
    return MobileBotRoster(props);
  };
  const family = { current: Reloaded };
  renderer.setRefreshHandler((type) =>
    type === MobileBotRoster || type === Reloaded ? family : undefined,
  );
  try {
    await act(async () =>
      renderer.scheduleRefresh(devtools.hook.root, {
        staleFamilies: new Set(),
        updatedFamilies: new Set([family]),
      }),
    );
    expect(reloaded).toHaveBeenCalled();
    const members = state.members as { onLongPressBot: (entry: object) => void };
    await act(async () => members.onLongPressBot({ kind: "member", profile: member }));
    expect(state.alert).toHaveBeenCalledOnce();
    await act(async () => choose("Hide"));
    expect(state.manage.hide).toHaveBeenCalledWith(member, true);
  } finally {
    renderer.setRefreshHandler(null);
    await act(async () => root.unmount());
    if (devtools.previous === undefined)
      Reflect.deleteProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
    else Object.assign(globalThis, { __REACT_DEVTOOLS_GLOBAL_HOOK__: devtools.previous });
  }
});
