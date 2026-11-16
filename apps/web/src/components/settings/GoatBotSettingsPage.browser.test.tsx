import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import {
  BotId,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ThreadId,
  type BotProfile,
} from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";

vi.unmock("../goatBot/useGoatBotComputerReadable");

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;
interface ListView {
  readonly data: { readonly bots: ReadonlyArray<BotProfile> } | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly dataUpdatedAt?: number;
  readonly failure?: unknown;
  /** The settled success; a new object only when a read succeeds. */
  readonly successResult?: object | null;
}

const state = vi.hoisted(() => ({
  persist: vi.fn(),
  environments: [] as ReadonlyArray<unknown>,
  homeId: "env-studio",
  presentation: null as null | {
    connection: Connection;
    serverConfig: { environment: { capabilities: Record<string, boolean> } };
  },
  primaryId: null as string | null,
  revoked: false,
  mayEdit: true,
  list: { data: null, error: null, isPending: false } as {
    data: unknown;
    error: string | null;
    isPending: boolean;
    dataUpdatedAt?: number;
    failure?: unknown;
    successResult?: object | null;
  },
  // The bot-list atom, made by the channels mock; a press reads its result from the registry.
  listAtom: null as unknown,
  listeners: new Set<() => void>(),
  version: 0,
}));

// The panel's children are memoized, so the mocks re-render their readers through a store.
function useTick() {
  useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.version,
  );
}
async function change(apply: () => void) {
  apply();
  await act(() => {
    state.version += 1;
    for (const listener of state.listeners) listener();
  });
}

const MAIN: BotProfile = {
  botId: BotId.make("bot-main"),
  role: "main",
  name: "Goatie",
  avatar: "🐐",
  purpose: "Keeps the studio running.",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: STUDIO,
  sessionThreadId: ThreadId.make("thread-main"),
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function environment(
  environmentId: EnvironmentId,
  label: string,
  primary: boolean,
  connected = true,
) {
  return {
    environmentId,
    connected,
    supportsChannelLedger: true,
    primary,
    label,
    settingsSnapshot: {},
    homeTarget: {
      environmentId,
      connected,
      supportsHome: true,
      supportsBot: true,
      settingsLoaded: true,
      home: { environmentId: STUDIO, claimedAt: 1_000, claimId: "claim-studio" },
    },
  } satisfies GoatBotEnvironmentInput;
}

vi.mock(import("../goatBot/goatBotHooks"), async (original) => ({
  ...(await original()),
  useGoatBotEnvironments: (() => {
    useTick();
    return state.environments;
  }) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.persist) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((entries: ReadonlyArray<{ environmentId: EnvironmentId }>) =>
    new Set(entries.map((entry) => entry.environmentId))) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((environmentId: string | null) => {
    useTick();
    return environmentId === state.homeId ? state.presentation : null;
  }) as never,
  readEnvironment: ((environmentId: string) =>
    environmentId === state.homeId ? state.presentation : null) as never,
  readPrimaryEnvironmentId: (() => state.primaryId) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: (() => {
    useTick();
    return state.primaryId;
  }) as never,
}));
vi.mock("~/environments/primary/sessionCheck", () => ({
  primarySessionCheck: {
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    revoked: () => state.revoked,
  },
}));
vi.mock(import("../../state/channels"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  // Kept alive as the row's subscription keeps it in the app; a press reads it from the registry.
  state.listAtom = Atom.make<unknown>(AsyncResult.initial()).pipe(Atom.keepAlive);
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    channelEnvironment: {
      ...actual.channelEnvironment,
      listBots: (() => state.listAtom) as never,
      updateBot: {
        ...actual.channelEnvironment.updateBot,
        permissionAtom: () => (state.mayEdit ? allowed : denied),
      },
    },
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentQuery: ((atom: unknown) => {
      useTick();
      if (atom === state.listAtom) {
        const settled = !state.list.isPending && state.list.error === null;
        return {
          ...state.list,
          failure: state.list.failure ?? null,
          successResult: settled ? (state.list.successResult ?? null) : null,
          refresh: () => {},
        };
      }
      if (atom === null) {
        return { data: null, error: null, isPending: false, refresh: () => {} };
      }
      return actual.useEnvironmentQuery(atom as never);
    }) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: ((options?: { select?: (location: unknown) => unknown }) => {
    const location = { pathname: "/settings/goat-bot", hash: "", state: {} };
    return options?.select ? options.select(location) : location;
  }) as never,
  useNavigate: (() => vi.fn()) as never,
}));

import { GoatBotSettingsPanel } from "./GoatBotSettingsPage";

// When each answer settled: one held before a refusal, one read after access returned.
const READ_BEFORE = 1_000;
const READ_AFTER = 3_000;

const kept = (bots: ReadonlyArray<BotProfile> = [MAIN]): ListView => ({
  data: { bots },
  error: null,
  isPending: false,
  dataUpdatedAt: READ_BEFORE,
  successResult: {},
});

/** The home's connection, the app's list and the bot list move together, as in the client. */
function home(connection: Connection, list: ListView = kept()) {
  const connected = connection.phase === "connected";
  state.presentation = {
    connection,
    serverConfig: { environment: { capabilities: { goatBotProfileEdit: true } } },
  };
  state.environments = [
    environment(STUDIO, "Mac Studio", true, connected),
    environment(LAPTOP, "MacBook", false),
  ];
  state.list = list;
}

const CONNECTED: Connection = { phase: "connected" };
const RECONNECTING: Connection = {
  phase: "reconnecting",
  failure: { kind: "retrying", reason: "transport", detail: "The connection closed." },
};

const BLOCKED: Connection = {
  phase: "error",
  failure: { kind: "blocked", reason: "authentication", detail: "Not accepted." },
};

function setup() {
  state.persist.mockReset().mockResolvedValue({ _tag: "Success" });
  state.primaryId = null;
  state.revoked = false;
  state.mayEdit = true;
  appAtomRegistry.set(state.listAtom as never, AsyncResult.initial() as never);
  home(CONNECTED);
}

const DENIED = { _tag: "EnvironmentAuthorizationError" };

async function expectNoKeptProfile(screen: Screen) {
  const section = screen.container.querySelector("section#goat-bot-profile") as HTMLElement;
  const named = [...section.querySelectorAll("*")].map((element) =>
    [element.getAttribute("aria-label"), element.getAttribute("title")].join(" "),
  );
  for (const old of ["Goatie", "🐐", "Keeps the studio running."]) {
    expect(section.textContent).not.toContain(old);
    expect(named.join(" ")).not.toContain(old);
  }
}

function profile(screen: Screen) {
  const section = screen.container.querySelector("section#goat-bot-profile");
  expect(section).not.toBeNull();
  return page.elementLocator(section as HTMLElement);
}

function status(screen: Screen) {
  const section = screen.container.querySelector("section#goat-bot-status");
  expect(section).not.toBeNull();
  return page.elementLocator(section as HTMLElement);
}

async function editWithDraft(screen: Screen) {
  await profile(screen).getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "Draft name");
  await userEvent.fill(dialog.getByRole("textbox", { name: "Purpose" }), "Draft purpose");
}

it("shows where GOAT Bot runs and every channel, and saves a new home to each computer", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);

  expect(screen.container.querySelector("section#goat-bot")).not.toBeNull();
  expect(screen.container.querySelector("section#slack-channel")).not.toBeNull();
  expect(screen.container.querySelector("section#imessage")).not.toBeNull();
  const trigger = page.getByRole("combobox", { name: "GOAT Bot runs on" });
  await expect.element(trigger).toHaveTextContent("Mac Studio");

  await trigger.click();
  await page.getByRole("option", { name: "MacBook" }).click();

  await vi.waitFor(() => expect(state.persist).toHaveBeenCalledTimes(2));
  const written = state.persist.mock.calls.map(([call]) => ({
    environmentId: call.environmentId,
    home: call.input.patch.goatBotHome.environmentId,
  }));
  expect(written).toEqual(
    expect.arrayContaining([
      { environmentId: STUDIO, home: LAPTOP },
      { environmentId: LAPTOP, home: LAPTOP },
    ]),
  );
});

it("the profile row keeps the last-read name and purpose, says Offline and turns Edit off while the home is offline (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await expect.element(profile(screen).getByRole("button", { name: "Edit" })).toBeEnabled();

  await change(() => home(RECONNECTING, { ...kept(), isPending: true }));

  const row = profile(screen);
  await expect.element(row.getByText("🐐 Goatie")).toBeVisible();
  await expect.element(row.getByText("Keeps the studio running.")).toBeVisible();
  await expect.element(row.getByText("Offline", { exact: true })).toBeVisible();
  await expect.element(row.getByRole("button", { name: "Edit" })).toBeDisabled();
});

it("an offline home whose read failed says Offline with the kept profile, not Could not load (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);

  await change(() =>
    home(
      {
        phase: "offline",
        failure: { kind: "retrying", reason: "host-unreachable", detail: "Asleep." },
      },
      { ...kept(), error: "The environment is offline." },
    ),
  );

  const row = profile(screen);
  await expect.element(row.getByText("Offline", { exact: true })).toBeVisible();
  await expect.element(row.getByText("🐐 Goatie")).toBeVisible();
  expect(row.getByText("Could not load the bot's profile.").query()).toBeNull();
});

it("an open Edit dialog survives the home going offline with the draft kept, Save off and the reason given, and sends nothing (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await editWithDraft(screen);

  await change(() => home(RECONNECTING, { ...kept(), isPending: true }));

  const dialog = page.getByRole("dialog");
  const name = dialog.getByRole("textbox", { name: "Name" });
  await expect.element(name).toHaveValue("Draft name");
  await expect
    .element(dialog.getByRole("textbox", { name: "Purpose" }))
    .toHaveValue("Draft purpose");
  const save = dialog.getByRole("button", { name: "Save" });
  await expect.element(save).toBeDisabled();
  await expect.element(save).toHaveAccessibleDescription("Goatie's computer isn't connected.");

  await userEvent.type(name, "{Enter}");
  expect(state.persist).not.toHaveBeenCalled();
});

it("the Edit dialog never reopens by itself on reconnect; the person's draft is what shows (#3504, regression)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await editWithDraft(screen);

  await change(() => home(RECONNECTING, { ...kept(), isPending: true }));
  await change(() => home(CONNECTED, kept([{ ...MAIN, updatedAt: "2026-11-02T00:00:00.000Z" }])));

  expect(page.getByRole("dialog").elements()).toHaveLength(1);
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Draft name");
  await expect.element(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
});

const REFUSALS = [
  {
    refusal: "this tab's own server says its session is gone",
    refuse: () => {
      state.primaryId = STUDIO;
      state.revoked = true;
      home(RECONNECTING, { ...kept(), isPending: true });
    },
  },
  {
    refusal: "a bearer home blocks this device",
    refuse: () =>
      home(
        {
          phase: "error",
          failure: { kind: "blocked", reason: "authentication", detail: "Not accepted." },
        },
        { ...kept(), error: "Not accepted." },
      ),
  },
];

it.each(REFUSALS)(
  "a refusal ($refusal) closes the dialog, hides the bot's name and says this device was not accepted, never Offline (#3504, access)",
  async ({ refuse }) => {
    setup();
    await using screen = await render(<GoatBotSettingsPanel />);
    await editWithDraft(screen);

    await change(refuse);

    expect(page.getByRole("dialog").query()).toBeNull();
    const row = profile(screen);
    await expect
      .element(row.getByText("GOAT on Mac Studio did not accept this device"))
      .toBeVisible();
    await expect.element(row.getByText("GOAT Bot", { exact: true })).toBeVisible();
    expect(row.getByText("Goatie").query()).toBeNull();
    expect(row.getByText("Keeps the studio running.").query()).toBeNull();
    expect(row.getByText("Offline", { exact: true }).query()).toBeNull();
    expect(row.getByRole("button", { name: "Edit" }).query()).toBeNull();

    await change(() => {
      state.revoked = false;
      home(CONNECTED, { ...kept(), dataUpdatedAt: READ_AFTER });
    });

    await expect.element(profile(screen).getByText("🐐 Goatie")).toBeVisible();
    expect(page.getByRole("dialog").query()).toBeNull();
  },
);

it("after a refusal, access coming back shows Loading… and nothing read before the refusal until a fresh read settles (#3504, access)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await expect.element(profile(screen).getByText("🐐 Goatie")).toBeVisible();

  await change(() => home(BLOCKED, { ...kept(), error: "Not accepted." }));
  await expect
    .element(profile(screen).getByText("GOAT on Mac Studio did not accept this device"))
    .toBeVisible();
  // Access is back; the query still holds its pre-refusal answer while the fresh read is pending.
  await change(() => home(CONNECTED, { ...kept(), isPending: true }));

  const row = profile(screen);
  await expect.element(row.getByText("Loading…")).toBeVisible();
  const section = screen.container.querySelector("section#goat-bot-profile") as HTMLElement;
  const named = [...section.querySelectorAll("*")].map((element) =>
    [element.getAttribute("aria-label"), element.getAttribute("title")].join(" "),
  );
  for (const old of ["Goatie", "🐐", "Keeps the studio running."]) {
    expect(section.textContent).not.toContain(old);
    expect(named.join(" ")).not.toContain(old);
  }
  expect(row.getByRole("button", { name: /Goatie/ }).query()).toBeNull();

  await change(() =>
    home(CONNECTED, {
      ...kept([{ ...MAIN, purpose: "Reads again after access." }]),
      dataUpdatedAt: READ_AFTER,
    }),
  );
  await expect.element(profile(screen).getByText("🐐 Goatie")).toBeVisible();
  await expect.element(profile(screen).getByText("Reads again after access.")).toBeVisible();
});

it.each([
  {
    change: "the home dropped",
    connection: RECONNECTING,
    why: "Goatie's computer isn't connected.",
  },
  {
    change: "the home refused this device",
    connection: BLOCKED,
    why: "GOAT on Mac Studio did not accept this device",
  },
])(
  "Save (Enter in the form) after $change reached the store, before the screen re-rendered, sends nothing and says why (#3504, access)",
  async ({ connection, why }) => {
    setup();
    await using screen = await render(<GoatBotSettingsPanel />);
    await editWithDraft(screen);

    // The store changes; no reader is told, so the dialog still shows Save on.
    home(connection, kept());
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "{Enter}");

    expect(state.persist).not.toHaveBeenCalled();
    await expect.element(dialog.getByRole("alert")).toHaveTextContent(why);
    await expect.element(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Draft name");
  },
);

it("once the screen catches up with a drop, the reason a press already gave is not repeated beside Save (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await editWithDraft(screen);
  home(RECONNECTING, kept());
  const dialog = page.getByRole("dialog");
  await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "{Enter}");
  await expect
    .element(dialog.getByRole("alert"))
    .toHaveTextContent("Goatie's computer isn't connected.");

  await change(() => {});

  const save = dialog.getByRole("button", { name: "Save" });
  await expect.element(save).toBeDisabled();
  expect(dialog.getByText("Goatie's computer isn't connected.").elements()).toHaveLength(1);
  await expect.element(save).toHaveAccessibleDescription("Goatie's computer isn't connected.");
});

it("a denied bot-list read while connected hides the kept profile, closes the dialog and refuses Save; a read that succeeds after it brings the profile back (#3504, access)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await editWithDraft(screen);

  // The denied refetch reaches the store before the screen re-renders.
  appAtomRegistry.set(state.listAtom as never, AsyncResult.fail(DENIED) as never);
  await userEvent.type(page.getByRole("dialog").getByRole("textbox", { name: "Name" }), "{Enter}");
  expect(state.persist).not.toHaveBeenCalled();

  await change(() => home(CONNECTED, { ...kept(), error: "Not allowed.", failure: DENIED }));
  expect(page.getByRole("dialog").query()).toBeNull();
  await expect
    .element(
      profile(screen).getByText(
        "GOAT on Mac Studio did not let this device read the bot's profile",
      ),
    )
    .toBeVisible();
  await expectNoKeptProfile(screen);
  expect(profile(screen).getByRole("button", { name: "Edit" }).query()).toBeNull();

  // The denial clears, but no read has succeeded since it.
  await change(() => home(CONNECTED, { ...kept(), isPending: true }));
  await expect.element(profile(screen).getByText("Loading…")).toBeVisible();
  await expectNoKeptProfile(screen);

  await change(() => home(CONNECTED, kept()));
  await expect.element(profile(screen).getByText("🐐 Goatie")).toBeVisible();
});

it("after a refusal, a fresh read that settles in the same millisecond as the held answer still shows (#3504, access)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await change(() => home(BLOCKED, { ...kept(), error: "Not accepted." }));

  await change(() =>
    home(CONNECTED, { ...kept([{ ...MAIN, purpose: "Read again." }]), dataUpdatedAt: READ_BEFORE }),
  );

  await expect.element(profile(screen).getByText("Read again.")).toBeVisible();
});

it("after a refusal, a fresh read that fails shows the load error, not Loading… (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await change(() => home(BLOCKED, { ...kept(), error: "Not accepted." }));

  await change(() => home(CONNECTED, { ...kept(), error: "The read failed." }));

  const row = profile(screen);
  await expect.element(row.getByText("Could not load the bot's profile.")).toBeVisible();
  expect(row.getByText("Loading…").query()).toBeNull();
  await expectNoKeptProfile(screen);
  await expect.element(row.getByRole("button", { name: "Edit" })).toBeDisabled();
});

it("two refusals in a row with no successful read between keep the answer held before them hidden (#3504, access)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await change(() => home(BLOCKED, { ...kept(), error: "Not accepted." }));
  await change(() => home(CONNECTED, { ...kept(), isPending: true }));
  await change(() => home(BLOCKED, { ...kept(), error: "Not accepted." }));

  await change(() => home(CONNECTED, { ...kept(), isPending: true }));

  await expect.element(profile(screen).getByText("Loading…")).toBeVisible();
  await expectNoKeptProfile(screen);
  await expect.element(profile(screen).getByRole("button", { name: "Edit" })).toBeDisabled();
});

it("the profile row reads Loading… while its first read is pending (#3504, behavior)", async () => {
  setup();
  home(CONNECTED, { data: null, error: null, isPending: true });
  await using screen = await render(<GoatBotSettingsPanel />);

  const row = profile(screen);
  await expect.element(row.getByText("Loading…")).toBeVisible();
  await expect.element(row.getByRole("button", { name: "Edit" })).toBeDisabled();
});

it("a refetch over an answer with no main bot keeps saying the profile appears once GOAT Bot has started, not Loading… (#3504, behavior)", async () => {
  setup();
  home(CONNECTED, kept([]));
  await using screen = await render(<GoatBotSettingsPanel />);
  await expect
    .element(profile(screen).getByText("The profile appears once GOAT Bot has started."))
    .toBeVisible();

  await change(() => home(CONNECTED, { ...kept([]), isPending: true }));

  const row = profile(screen);
  await expect
    .element(row.getByText("The profile appears once GOAT Bot has started."))
    .toBeVisible();
  expect(row.getByText("Loading…").query()).toBeNull();
});

it("a home still on its first connect reads Loading…, never Offline, with Edit off (#3504, behavior)", async () => {
  setup();
  home({ phase: "connecting" }, { data: null, error: null, isPending: false });
  await using screen = await render(<GoatBotSettingsPanel />);

  const row = profile(screen);
  await expect.element(row.getByText("Loading…")).toBeVisible();
  expect(row.getByText("Offline", { exact: true }).query()).toBeNull();
  await expect.element(row.getByRole("button", { name: "Edit" })).toBeDisabled();
});

it("a home on an older server without profile edits shows no Profile section (#3504, contract)", async () => {
  setup();
  home(CONNECTED);
  state.presentation = {
    connection: CONNECTED,
    serverConfig: { environment: { capabilities: {} } },
  };
  await using screen = await render(<GoatBotSettingsPanel />);

  expect(screen.container.querySelector("section#goat-bot")).not.toBeNull();
  expect(screen.container.querySelector("section#goat-bot-profile")).toBeNull();
});

it("removing the home computer from the app hides the Profile section and closes its dialog (#3504, behavior)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await editWithDraft(screen);

  await change(() => {
    state.environments = [environment(LAPTOP, "MacBook", false)];
  });

  expect(screen.container.querySelector("section#goat-bot-profile")).toBeNull();
  expect(page.getByRole("dialog").query()).toBeNull();
});

it.each(REFUSALS)(
  "a refusal ($refusal) makes Status say this device was not accepted, as Profile does, never offline, and access back says Answers on (#3532, access)",
  async ({ refuse }) => {
    setup();
    await using screen = await render(<GoatBotSettingsPanel />);

    await change(refuse);

    const card = status(screen);
    await expect
      .element(card.getByText("GOAT on Mac Studio did not accept this device"))
      .toBeVisible();
    await expect.element(card.getByRole("button", { name: "Make MacBook the home" })).toBeVisible();
    expect(card.getByText(/Home machine is offline/).query()).toBeNull();
    expect(card.getByText("Checking the model…").query()).toBeNull();
    expect(card.getByRole("listitem").elements()).toHaveLength(1);
    await expect
      .element(profile(screen).getByText("GOAT on Mac Studio did not accept this device"))
      .toBeVisible();

    await change(() => {
      state.revoked = false;
      home(CONNECTED, { ...kept(), dataUpdatedAt: READ_AFTER });
    });

    await expect.element(status(screen).getByText("Answers on Mac Studio")).toBeVisible();
  },
);

it("an unreachable home that has not refused this device still says Home machine is offline (#3532, guard)", async () => {
  setup();
  state.primaryId = STUDIO;
  await using screen = await render(<GoatBotSettingsPanel />);

  await change(() => home(RECONNECTING, { ...kept(), isPending: true }));

  const card = status(screen);
  await expect.element(card.getByText("Home machine is offline (Mac Studio)")).toBeVisible();
  expect(card.getByText(/did not accept/).query()).toBeNull();
});

it("a refused home then removed from the app never says it did not accept this device (#3532, guard)", async () => {
  setup();
  await using screen = await render(<GoatBotSettingsPanel />);
  await change(() => {
    state.primaryId = STUDIO;
    state.revoked = true;
    home(BLOCKED, { ...kept(), error: "Not accepted." });
  });
  await expect
    .element(status(screen).getByText("GOAT on Mac Studio did not accept this device"))
    .toBeVisible();

  await change(() => {
    state.presentation = null;
    state.environments = [environment(LAPTOP, "MacBook", false)];
  });

  expect(
    status(screen)
      .getByText(/did not accept/)
      .query(),
  ).toBeNull();
});
