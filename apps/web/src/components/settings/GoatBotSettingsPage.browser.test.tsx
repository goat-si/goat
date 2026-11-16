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
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";

vi.unmock("../goatBot/useGoatBotComputerReadable");

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;
interface ListView {
  readonly data: { readonly bots: ReadonlyArray<BotProfile> } | null;
  readonly error: string | null;
  readonly isPending: boolean;
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
  },
  listAtom: "goat-bot-profile-list",
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
  const { Atom } = await import("effect/reactivity");
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
      if (atom === state.listAtom) return { ...state.list, refresh: () => {} };
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

const kept = (bots: ReadonlyArray<BotProfile> = [MAIN]): ListView => ({
  data: { bots },
  error: null,
  isPending: false,
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

function setup() {
  state.persist.mockReset().mockResolvedValue({ _tag: "Success" });
  state.primaryId = null;
  state.revoked = false;
  state.mayEdit = true;
  home(CONNECTED);
}

function profile(screen: Screen) {
  const section = screen.container.querySelector("section#goat-bot-profile");
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

it.each([
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
])(
  "a refusal ($refusal) closes the dialog, hides the bot's name and says this device was not accepted, never Offline (#3504, access)",
  async ({ refuse }) => {
    setup();
    await using screen = await render(<GoatBotSettingsPanel />);
    await editWithDraft(screen);

    await change(refuse);

    expect(page.getByRole("dialog").query()).toBeNull();
    const row = profile(screen);
    await expect
      .element(row.getByText("GOAT on Mac Studio did not accept this device."))
      .toBeVisible();
    await expect.element(row.getByText("GOAT Bot", { exact: true })).toBeVisible();
    expect(row.getByText("Goatie").query()).toBeNull();
    expect(row.getByText("Keeps the studio running.").query()).toBeNull();
    expect(row.getByText("Offline", { exact: true }).query()).toBeNull();
    expect(row.getByRole("button", { name: "Edit" }).query()).toBeNull();

    await change(() => {
      state.revoked = false;
      home(CONNECTED);
    });

    await expect.element(profile(screen).getByText("🐐 Goatie")).toBeVisible();
    expect(page.getByRole("dialog").query()).toBeNull();
  },
);

it("the profile row reads Loading… while its first read is pending (#3504, behavior)", async () => {
  setup();
  home(CONNECTED, { data: null, error: null, isPending: true });
  await using screen = await render(<GoatBotSettingsPanel />);

  const row = profile(screen);
  await expect.element(row.getByText("Loading…")).toBeVisible();
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
