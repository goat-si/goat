import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

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

it("hides a member, and deletes it only after the person confirms", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as { onLongPressBot: (entry: object) => void };
  await act(async () => members.onLongPressBot({ kind: "member", profile: member }));
  expect(choices().map((choice) => choice.text)).toEqual(["Edit", "Hide", "Delete", "Cancel"]);
  await act(async () => choose("Hide"));
  expect(state.manage.hide).toHaveBeenCalledWith(member, true);
  await act(async () => members.onLongPressBot({ kind: "member", profile: member }));
  await act(async () => choose("Delete"));
  expect(state.alert.mock.calls.at(-1)?.[1]).toBe(
    "Its conversation is archived; you can restore it.",
  );
  expect(state.manage.remove).not.toHaveBeenCalled();
  await act(async () => choose("Delete"));
  expect(state.manage.remove).toHaveBeenCalledWith(member);
  await act(async () => root.unmount());
});

it("restores a deleted member after the person confirms", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as {
    canRestore: boolean;
    onRestoreDeleted: (bot: object) => void;
  };
  expect(members.canRestore).toBe(true);
  await act(async () => members.onRestoreDeleted({ ...member, state: "deleted" }));
  await act(async () => choose("Restore"));
  expect(state.manage.restore).toHaveBeenCalledWith({ ...member, state: "deleted" });
  await act(async () => root.unmount());
});

it("changes a member's model from Edit only where its server takes the change", async () => {
  state.alert.mockClear();
  state.manage.update.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as { onLongPressBot: (entry: object) => void };
  const profile = { ...member, role: "member", defaultModelSelection: null };
  const luna = { instanceId: "codex", model: "luna" };
  const edit = async () => {
    state.pickModel = null;
    await act(async () => members.onLongPressBot({ kind: "member", profile }));
    await act(async () => choose("Edit"));
  };

  await edit();
  expect(state.sheet?.extraChanged).toBe(false);
  await act(async () => state.pickModel?.(luna));
  // A model alone is a change worth saving.
  expect(state.sheet?.extraChanged).toBe(true);
  await act(async () => {
    await state.sheet?.onSubmit({});
  });
  expect(state.manage.update).toHaveBeenLastCalledWith(profile, {}, luna);
  await act(async () => state.sheet?.onClose());

  // An older server drops the model, so the sheet neither offers nor sends one.
  state.modelEditable = false;
  await edit();
  expect(state.pickModel).toBeNull();
  await act(async () => {
    await state.sheet?.onSubmit({ name: "Research 2" });
  });
  expect(state.manage.update).toHaveBeenLastCalledWith(profile, { name: "Research 2" }, undefined);
  state.modelEditable = true;
  await act(async () => root.unmount());
});

it("offers a member's colour on Edit only where the server stores one, and never the main bot's", async () => {
  state.alert.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  const members = state.members as { onLongPressBot: (entry: object) => void };
  const edit = async (entry: object) => {
    await act(async () => members.onLongPressBot(entry));
    await act(async () => choose("Edit"));
  };
  await edit({
    kind: "member",
    profile: { ...member, role: "member", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(true);
  await act(async () => state.sheet?.onClose());
  await edit({
    kind: "main",
    profile: { botId: "main", role: "main", name: "GOAT Bot", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(false);
  await act(async () => state.sheet?.onClose());
  state.colorEditable = false;
  await edit({
    kind: "member",
    profile: { ...member, role: "member", defaultModelSelection: null },
  });
  expect(state.sheet?.colorEditable).toBe(false);
  state.colorEditable = true;
  await act(async () => root.unmount());
});

let environments = 0;
const stored = (botId: string, name: string, extra: object = {}) => ({
  botId,
  role: "member",
  name,
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  ...extra,
});
/** A roster on its own environment, with a create the test answers when it chooses. */
async function newBotRoster(options: { visible?: boolean; listed?: Array<object> | null } = {}) {
  environments += 1;
  state.roster.environmentId = `env-new-${environments}`;
  state.roster.listedBots = options.listed === undefined ? [] : options.listed;
  state.roster.refreshBots = vi.fn();
  state.navState = { index: 0, routes: [{ key: "home", name: "Home" }] };
  state.appState = "active";
  state.rosterError = null;
  const answers: Array<(value: object | string) => void> = [];
  state.manage.create.mockReset();
  state.manage.create.mockImplementation(
    () => new Promise<object | string>((resolve) => answers.push(resolve)),
  );
  const opened = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const draw = (visible = options.visible ?? true) =>
    act(async () =>
      root.render(<MobileBotRoster selectedKey={null} onOpenBot={opened} visible={visible} />),
    );
  const swap = (other: React.ReactNode) => act(async () => root.render(other));
  await draw();
  const members = () => state.members as { canCreate: boolean; onNewBot: () => void };
  return {
    container,
    opened,
    answers,
    draw,
    swap,
    members,
    tap: () => act(async () => members().onNewBot()),
    answer: (value: object | string) => act(async () => answers.shift()?.(value)),
    press: (label: string) =>
      act(async () =>
        [...container.querySelectorAll("button")]
          .find((item) => item.textContent === label)
          ?.click(),
      ),
    unmount: () => act(async () => root.unmount()),
  };
}

it("creates a bot with one tap under the first free generated name, shows it creating, and ignores a second tap", async () => {
  const view = await newBotRoster({
    listed: [
      stored("old", "New bot", { state: "deleted" }),
      stored("hid", "New bot 3", { hidden: true }),
    ],
  });
  // Two taps in the same frame: the second finds the slot taken.
  await act(async () => {
    view.members().onNewBot();
    view.members().onNewBot();
  });
  expect(state.manage.create).toHaveBeenCalledOnce();
  expect(state.manage.create).toHaveBeenCalledWith(
    { name: "New bot 2", avatar: null, purpose: "" },
    null,
    expect.stringMatching(/^request-/),
  );
  expect(view.container.textContent).toContain("New bot 2 · Creating…");
  expect(view.members().canCreate).toBe(false);
  await view.answer(stored("research", "New bot 2"));
  expect(view.opened).toHaveBeenCalledExactlyOnceWith({
    kind: "member",
    profile: stored("research", "New bot 2"),
  });
  await view.unmount();
});

it("opens nothing when the person has moved on by the time the create answers, and the bot is in the list", async () => {
  const moves: Array<[string, () => void]> = [
    // Split layout, the roster still on screen: another chat chosen in the detail pane.
    [
      "another chat in the detail pane",
      () => {
        state.navState = {
          index: 0,
          routes: [{ key: "home", name: "Home", params: { detail: "bot:scout" } }],
        };
      },
    ],
    // Phone: a route pushed over the roster, its transition still running.
    [
      "a route pushed",
      () => {
        state.navState = {
          index: 1,
          routes: [
            { key: "home", name: "Home" },
            { key: "thread-1", name: "Thread" },
          ],
        };
      },
    ],
    [
      "the app in the background",
      () => {
        state.appState = "background";
      },
    ],
  ];
  for (const [, move] of moves) {
    const view = await newBotRoster();
    await view.tap();
    move();
    await view.answer(stored("research", "New bot"));
    expect(view.opened).not.toHaveBeenCalled();
    await view.unmount();
  }
});

it("frees New bot as soon as the create answers, keeps the created bot's row until the list has it or it is dismissed, and offers the list's retry", async () => {
  const view = await newBotRoster();
  await view.tap();
  await view.answer(stored("research", "New bot"));
  // The list read failed: the created bot keeps its row, and New bot is free again.
  expect(state.roster.refreshBots).toHaveBeenCalledOnce();
  expect(view.members().canCreate).toBe(true);
  expect(view.container.textContent).toContain("New bot");
  await view.press("Dismiss");
  expect(view.container.textContent).toBe("");
  await view.unmount();
  state.rosterError = "Couldn't read the bot list.";
  const failed = await newBotRoster();
  state.rosterError = "Couldn't read the bot list.";
  await failed.draw();
  await failed.press("Retry");
  expect(state.roster.refreshBots).toHaveBeenCalledOnce();
  await failed.unmount();
});

it("opens nothing once the tapped roster has gone, is off screen, or shows another environment", async () => {
  // The Bots / Threads switch: the layout swaps the roster out for the thread list.
  const switched = await newBotRoster();
  await switched.tap();
  await switched.swap(<div>Threads</div>);
  await switched.answer(stored("research", "New bot"));
  expect(switched.opened).not.toHaveBeenCalled();
  await switched.unmount();
  // Still mounted under another page.
  const hidden = await newBotRoster();
  await hidden.tap();
  await hidden.draw(false);
  await hidden.answer(stored("research", "New bot"));
  expect(hidden.opened).not.toHaveBeenCalled();
  await hidden.unmount();
  // The roster now shows another environment's bots.
  const moved = await newBotRoster();
  await moved.tap();
  state.roster.environmentId = "env-elsewhere";
  await moved.draw();
  await moved.answer(stored("research", "New bot"));
  expect(moved.opened).not.toHaveBeenCalled();
  await moved.unmount();
});

it("opens nothing while the roster shows its own Edit sheet or action menu, nor later when it closes", async () => {
  const other = {
    kind: "member",
    profile: { ...member, role: "member", defaultModelSelection: null },
  };
  // Edit on another bot is open when the answer lands.
  const editing = await newBotRoster();
  await editing.tap();
  await act(async () =>
    (state.members as { onLongPressBot: (entry: object) => void }).onLongPressBot(other),
  );
  await act(async () => choose("Edit"));
  expect(state.sheet?.mode).toBe("edit");
  await editing.answer(stored("research", "New bot"));
  await act(async () => state.sheet?.onClose());
  expect(editing.opened).not.toHaveBeenCalled();
  await editing.unmount();
  // The row's action menu is up when the answer lands.
  const menu = await newBotRoster();
  await menu.tap();
  await act(async () =>
    (state.members as { onLongPressBot: (entry: object) => void }).onLongPressBot(other),
  );
  await menu.answer(stored("research", "New bot"));
  await act(async () => choose("Cancel"));
  expect(menu.opened).not.toHaveBeenCalled();
  await menu.unmount();
});

it("says why a create failed; Retry sends the same request and name, and Dismiss lets a later tap start anew", async () => {
  const view = await newBotRoster();
  await view.tap();
  const first = state.manage.create.mock.calls[0];
  await view.answer("Couldn't reach GOAT Bot's computer.");
  expect(view.container.textContent).toContain(
    "Couldn't create a bot: Couldn't reach GOAT Bot's computer.",
  );
  await view.press("Retry");
  expect(state.manage.create.mock.calls[1]).toEqual(first);
  await view.answer("Still offline.");
  await view.press("Dismiss");
  expect(view.container.textContent).toBe("");
  await view.tap();
  expect(state.manage.create.mock.calls[2]?.[2]).not.toBe(first?.[2]);
  await view.unmount();
});

it("keeps New bot off until the whole list has answered", async () => {
  const view = await newBotRoster({ listed: null });
  expect(view.members().canCreate).toBe(false);
  await view.tap();
  expect(state.manage.create).not.toHaveBeenCalled();
  await view.unmount();
});

it("keeps Creating… until the answer names the bot, even when the list shows a same-name bot or the new one first", async () => {
  const view = await newBotRoster();
  await view.tap();
  // Another device made a bot with the same name, then the new one arrives in the list early.
  state.roster.listedBots = [stored("elsewhere", "New bot")];
  await view.draw();
  expect(view.container.textContent).toContain("New bot · Creating…");
  state.roster.listedBots = [stored("elsewhere", "New bot"), stored("research", "New bot")];
  await view.draw();
  expect(view.container.textContent).toContain("New bot · Creating…");
  await view.answer(stored("research", "New bot"));
  expect(view.container.textContent).toBe("");
  expect(view.opened).toHaveBeenCalledOnce();
  await view.unmount();
});

it("opens nothing for a retried create that returns a bot already deleted", async () => {
  const view = await newBotRoster();
  await view.tap();
  await view.answer(stored("research", "New bot", { state: "deleted" }));
  expect(view.opened).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("");
  await view.unmount();
});

it("rests the main tile by the computer its saved bot lives on, not the one the roster lists", async () => {
  // The saved bot is on a computer this phone may no longer read; the roster still lists "env".
  readable.botComputer = "old";
  try {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
    expect(state.mainUnreadable).toBe(true);
    readable.botComputer = "env";
    await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
    expect(state.mainUnreadable).toBe(false);
    await act(async () => root.unmount());
  } finally {
    readable.botComputer = "env";
  }
});

it("once the roster's computer may no longer be read, the main tile has no line and Needs you no computer", async () => {
  state.roster.environmentId = "env";
  readable.botComputer = "env";
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
  expect(state.view).toEqual({ preview: "The build is waiting on you.", mainEnvironmentId: "env" });
  readable.refused.add("env");
  try {
    await act(async () => root.render(<MobileBotRoster selectedKey={null} onOpenBot={() => {}} />));
    expect(state.mainUnreadable).toBe(true);
    expect(state.view).toEqual({ preview: undefined, mainEnvironmentId: null });
  } finally {
    readable.refused.delete("env");
    await act(async () => root.unmount());
  }
});

it("shows no created bot's row once its computer may no longer be read", async () => {
  const view = await newBotRoster();
  await view.tap();
  await view.answer(stored("research", "New bot"));
  expect(view.container.textContent).toContain("New bot");
  const environmentId = state.roster.environmentId;
  readable.refused.add(environmentId);
  try {
    await view.draw();
    expect(view.container.textContent).toBe("");
  } finally {
    readable.refused.delete(environmentId);
    await view.unmount();
  }
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
  const draw = () =>
    act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <MobileBotRoster selectedKey={null} onOpenBot={() => {}} visible={visible} />
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
    members,
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

it("an action menu opened before a refusal does nothing when a choice is pressed after it", async () => {
  await using view = await refusableRoster("env-menu");
  await view.longPress();
  await view.link({ phase: "error", failure: { kind: "blocked", reason: "permission" } });
  await view.choose("Hide");
  expect(state.manage.hide).not.toHaveBeenCalled();
  await view.longPress();
  await view.choose("Edit");
  expect(view.container.textContent).not.toContain("Research");
  await view.longPress();
  const menus = state.alert.mock.calls.length;
  await view.choose("Delete");
  // No confirmation follows: the Delete pressed after the refusal opened nothing.
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
