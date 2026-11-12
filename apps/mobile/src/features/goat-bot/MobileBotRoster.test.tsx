import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  alert: vi.fn(),
  members: null as null | Record<string, unknown>,
  manage: {
    canCreate: true,
    canManage: true,
    canEdit: true,
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
vi.mock("./useMobileBotPreview", () => ({ useMobileBotPreview: () => null }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));
vi.mock("./useMobileBotRoster", () => ({
  useMobileBotRoster: () => ({
    bots: [],
    groups: { main: null, members: [], hidden: [], deleted: [] },
    supportsMembers: true,
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
  }) => {
    state.members = props.members ?? null;
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
    return <>{props.children}</>;
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
