import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: "ios" },
  Modal: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button onClick={props.onPress} disabled={props.disabled} aria-label={props.accessibilityLabel}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./components/SettingsChoiceRow", () => ({ SettingsChoiceRow: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
// A row reads as its label and value, as a screen reader says it.
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: (props: {
    label: string;
    value?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      data-settings-row
      aria-label={[props.label, props.value].filter(Boolean).join(", ")}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
// One registry for the app and the screen, so a Save reads the same connection the screen shows.
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
// The app's computers: "env", the GOAT Bot home, is listed.
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make<unknown>({ isReady: true, entries: new Map([["env", {}]]) }),
    },
  };
});
// Each computer's presentation, as the app derives it: its connection and what its server supports.
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useAtomValue } = await import("@effect/atom-react");
  const presentationsAtom = Atom.make(new Map<string, { connection: { phase: string } }>());
  const presentationAtom = Atom.family((id: string) =>
    Atom.make((get) => get(presentationsAtom).get(id) ?? null),
  );
  return {
    environmentPresentations: { presentationsAtom, presentationAtom },
    useEnvironmentPresentation: (id: string | null) => ({
      isReady: true,
      presentation: useAtomValue(id === null ? Atom.make(null) : presentationAtom(id)),
    }),
  };
});
vi.mock("../../state/environments", async () => {
  const { environmentPresentations } = await import("../../state/presentation");
  return {
    useEnvironments: () => ({
      presentationById: useAtomValue(environmentPresentations.presentationsAtom),
    }),
  };
});
// The roster's bot-list read, deleted members included, which every reader of a computer must share;
// any other input is a read nobody answers. And this phone's permission to edit bots.
vi.mock("../../state/channels", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const read = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const unanswered = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const mayEdit = Atom.make(true);
  const allowed = { permissionAtom: () => Atom.make(true) };
  return {
    channelEnvironment: {
      listBots: (args: { input: { includeDeleted?: boolean } }) =>
        args.input.includeDeleted === true ? read : unanswered,
      updateBot: { permissionAtom: () => mayEdit },
      createBot: allowed,
      setBotHidden: allowed,
    },
  };
});
vi.mock("../goat-bot/openAsksRead", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const idle = Atom.make(AsyncResult.initial());
  return { openAsks: () => idle };
});
// The home is claimed on "env" and connected while its presentation says so.
vi.mock("../goat-bot/useMobileGoatBotHomeSettings", async () => {
  const { environmentPresentations } = await import("../../state/presentation");
  return {
    useMobileGoatBotHomeSettings: () => {
      const presentation = useAtomValue(environmentPresentations.presentationsAtom).get(
        "env" as never,
      );
      return {
        supported: true,
        resolution: {
          state: "claimed",
          claim: { environmentId: "env" },
          homeKnown: true,
          homeConnected: presentation?.connection.phase === "connected",
        },
        targets: [],
        environments: [],
        writableIds: new Set(),
        busy: false,
        error: null,
        changeHome: () => {},
      };
    },
  };
});
vi.mock("../goat-bot/useMobileGoatBotModel", () => ({ useMobileGoatBotModel: () => null }));

import { environmentPresentations } from "../../state/presentation";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
} from "../goat-bot/useKeptPerComputer";
import { SettingsGoatBotRouteScreen } from "./SettingsGoatBotRouteScreen";

const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const botListAtom = channelEnvironment.listBots({
  environmentId: "env" as never,
  input: { includeDeleted: true },
}) as unknown as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>>;
const mayEditAtom = channelEnvironment.updateBot.permissionAtom(
  "env" as never,
) as unknown as Atom.Writable<boolean>;
const capabilities = { goatBotProfiles: true, goatBotProfileEdit: true, goatBotMembers: true };
const home = (phase: string) =>
  new Map([["env", { connection: { phase }, serverConfig: { environment: { capabilities } } }]]);
const main = {
  botId: "main",
  role: "main",
  name: "Scout",
  avatar: "🐐",
  purpose: "Watches CI",
  color: null,
  hidden: false,
  state: "active",
  defaultModelSelection: null,
};
const botList = { bots: [main] };
const refused = { _tag: "EnvironmentAuthorizationError", message: "Not allowed." };

/** Settings > GOAT Bot with its home connected and the bot list not yet answered. */
async function settings() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetKeptPerComputerForTests();
  const registry = appAtomRegistry;
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(presentationsAtom, home("connected"));
  registry.set(botListAtom, AsyncResult.initial());
  registry.set(mayEditAtom, true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <SettingsGoatBotRouteScreen />
      </RegistryContext>,
    ),
  );
  const row = () => container.querySelector<HTMLButtonElement>("[data-settings-row]");
  const save = () => container.querySelector<HTMLButtonElement>('button[aria-label="Save"]');
  return {
    /** The Profile row as it reads, or null when there is none. */
    get row() {
      return row()?.getAttribute("aria-label") ?? null;
    },
    get sheetOpen() {
      return container.querySelector('[role="dialog"]') !== null;
    },
    get purpose() {
      return container.querySelector<HTMLInputElement>('[aria-label="Purpose"]')?.value ?? null;
    },
    get saveEnabled() {
      return save() !== null && !save()!.disabled;
    },
    answer: (result: AsyncResult.AsyncResult<unknown, unknown>) =>
      act(async () => registry.set(botListAtom, result)),
    openRow: () => act(async () => row()?.click()),
    typePurpose: (value: string) =>
      act(async () => {
        const field = container.querySelector<HTMLInputElement>('[aria-label="Purpose"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    drop: () => act(async () => registry.set(presentationsAtom, home("offline"))),
    reconnect: () => act(async () => registry.set(presentationsAtom, home("connected"))),
    /** The read idled out while the computer was away: the next one starts with no answer. */
    forgetRead: () => act(async () => registry.set(botListAtom, AsyncResult.initial())),
    deny: () => act(async () => registry.set(mayEditAtom, false)),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      container.remove();
      stop();
    },
  };
}

it("offline, the Profile row keeps the main bot's name it last read, reads Offline and does not open", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  expect(screen.row).toBe("🐐 Scout, Edit");
  await screen.drop();
  expect(screen.row).toBe("🐐 Scout, Offline");
  await screen.openRow();
  expect(screen.sheetOpen).toBe(false);
});

it("an Edit sheet open when the computer drops stays open with its typed change and Save off, and Save comes back on reconnect", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  await screen.openRow();
  await screen.typePurpose("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(true);
  await screen.drop();
  expect(screen.sheetOpen).toBe(true);
  expect(screen.purpose).toBe("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(false);
  await screen.reconnect();
  expect(screen.purpose).toBe("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(true);
});

it("once the computer refuses the bot list, the row shows no name and does not open, and an open sheet closes for good", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  await screen.openRow();
  expect(screen.sheetOpen).toBe(true);
  await screen.answer(
    AsyncResult.failure(Cause.fail(refused), {
      previousSuccess: Option.some(AsyncResult.success(botList)),
    }),
  );
  expect(screen.row).toBe("GOAT Bot, Couldn't load");
  expect(screen.sheetOpen).toBe(false);
  await screen.openRow();
  expect(screen.sheetOpen).toBe(false);
  // Allowed again: the name returns, and the sheet stays closed until the person opens it.
  await screen.answer(AsyncResult.success(botList));
  expect(screen.row).toBe("🐐 Scout, Edit");
  expect(screen.sheetOpen).toBe(false);
});

it("without permission the row says so, and offline it says Offline first", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  await screen.deny();
  expect(screen.row).toBe("🐐 Scout, Permission required");
  await screen.drop();
  expect(screen.row).toBe("🐐 Scout, Offline");
});

it("a list read again from nothing after a long drop reads Loading, not Not started yet", async () => {
  await using screen = await settings();
  expect(screen.row).toBe("GOAT Bot, Loading…");
  await screen.answer(AsyncResult.success(botList));
  await screen.drop();
  await screen.forgetRead();
  await screen.reconnect();
  expect(screen.row).toBe("GOAT Bot, Loading…");
  await screen.answer(AsyncResult.success(botList));
  expect(screen.row).toBe("🐐 Scout, Edit");
});
