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
  Text: (props: { children?: ReactNode; accessibilityElementsHidden?: boolean }) => (
    <span aria-hidden={props.accessibilityElementsHidden}>{props.children}</span>
  ),
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
    accessibilityValue?: { text?: string };
  }) => (
    <button
      onClick={props.onPress}
      disabled={props.disabled}
      aria-label={props.accessibilityLabel}
      aria-valuetext={props.accessibilityValue?.text}
    >
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
  SettingsSection: ({ title, children }: { title?: string; children?: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("./components/SettingsChoiceRow", () => ({
  SettingsChoiceRow: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button
      data-choice-row
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.label}
      checked={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onValueChange(event.target.checked)}
    />
  ),
}));
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
// The roster's bot-list read of "env", deleted members included, which every reader of a computer
// must share; any other computer or input is a read nobody answers. And the permission to edit bots.
vi.mock("../../state/channels", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const read = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const unanswered = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial());
  const mayEdit = Atom.make(true);
  const allowed = { permissionAtom: () => Atom.make(true) };
  return {
    channelEnvironment: {
      listBots: (args: { environmentId: string; input: Record<string, unknown> }) =>
        args.environmentId === "env" &&
        Object.keys(args.input).length === 1 &&
        args.input.includeDeleted === true
          ? read
          : unanswered,
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
        environments: [{ environmentId: "env", label: "Studio" }],
        writableIds: new Set(["env"]),
        busy: false,
        error: null,
        changeHome: () => {},
      };
    },
  };
});
// The home's server config as this phone last loaded it, or null when it never loaded one.
vi.mock("../goat-bot/useMobileGoatBotModel", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make<object | null>(null);
  return {
    useMobileGoatBotModel: Object.assign(
      (_environmentId: string | null, canWrite: boolean) => {
        const loaded = useAtomValue(config);
        if (loaded === null) return null;
        const save = () => Promise.resolve(true);
        return { ...loaded, saving: false, error: null, allowed: canWrite, save };
      },
      { config },
    ),
  };
});

import { environmentPresentations } from "../../state/presentation";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
} from "../goat-bot/useKeptPerComputer";
import { SettingsGoatBotRouteScreen } from "./SettingsGoatBotRouteScreen";
import { useMobileGoatBotModel } from "../goat-bot/useMobileGoatBotModel";

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
const configAtom = (useMobileGoatBotModel as unknown as { config: Atom.Writable<object | null> })
  .config;
const config = {
  settings: { goatBotSessionRouting: "session", channelAutoPlacement: true },
  state: {
    summaryLabel: "Automatic",
    automaticDescription: "gpt-5",
    separate: false,
    choices: [
      {
        key: "codex:fast",
        label: "Fast",
        providerLabel: "Codex",
        instanceId: "codex",
        model: "fast",
      },
    ],
  },
};
const capabilities = { goatBotProfiles: true, goatBotProfileEdit: true, goatBotMembers: true };
const home = (phase: string, failure?: { kind: string; reason: string }) =>
  new Map([
    ["env", { connection: { phase, failure }, serverConfig: { environment: { capabilities } } }],
  ]);
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

/** Settings > GOAT Bot with its home "Studio" connected and the bot list not yet answered. */
async function settings(loaded: object | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetKeptPerComputerForTests();
  const registry = appAtomRegistry;
  registry.set(presentationsAtom, home("connected"));
  // Before following, so the last test's refusal does not start this computer over.
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(botListAtom, AsyncResult.initial());
  registry.set(mayEditAtom, true);
  registry.set(configAtom, loaded);
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
  const modelRow = () =>
    container.querySelector<HTMLButtonElement>('[data-settings-row][aria-label^="GOAT Bot model"]');
  return {
    /** The Profile row as it reads, or null when there is none. */
    get row() {
      return row()?.getAttribute("aria-label") ?? null;
    },
    /** The GOAT Bot model row as it reads and whether it is off, or null when there is none. */
    get modelRow() {
      const found = modelRow();
      return found ? { label: found.getAttribute("aria-label"), disabled: found.disabled } : null;
    },
    /** The open model picker's choices, empty when it is closed. */
    get choices() {
      return [...container.querySelectorAll("[data-choice-row]")].map((choice) =>
        choice.getAttribute("aria-label"),
      );
    },
    get titles() {
      return [...container.querySelectorAll("section")].map((section) =>
        section.getAttribute("aria-label"),
      );
    },
    /** A switch's state, or null when it is not shown. */
    toggle: (label: string) => {
      const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      return found ? { checked: found.checked, disabled: found.disabled } : null;
    },
    /** Whether a screen reader reaches the text before the section with that title. */
    readsBefore: (text: string, title: string) => {
      const line = [...container.querySelectorAll("span")].find(
        (span) => span.textContent === text,
      );
      const section = container.querySelector(`section[aria-label="${title}"]`);
      return (
        line !== undefined &&
        section !== null &&
        (line.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
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
    /** What a screen reader says with Save, after its name, or null. */
    get saveValue() {
      return save()?.getAttribute("aria-valuetext") ?? null;
    },
    /** Each place the text shows on screen, and whether a screen reader skips it. */
    shown: (text: string) =>
      [...container.querySelectorAll("span")]
        .filter((span) => span.textContent === text)
        .map((span) => ({ hiddenFromReader: span.getAttribute("aria-hidden") === "true" })),
    answer: (result: AsyncResult.AsyncResult<unknown, unknown>) =>
      act(async () => registry.set(botListAtom, result)),
    openRow: () => act(async () => row()?.click()),
    openModel: () => act(async () => modelRow()?.click()),
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
    /** The next connection attempt is refused: this phone's credential no longer works there. */
    refuseConnection: () =>
      act(async () =>
        registry.set(
          presentationsAtom,
          home("error", { kind: "blocked", reason: "authentication" }),
        ),
      ),
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

it("an Edit sheet open when the computer drops stays open with its typed change and Save off with the reason said once, and Save comes back on reconnect", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  await screen.openRow();
  await screen.typePurpose("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(true);
  expect(screen.saveValue).toBe(null);
  await screen.drop();
  expect(screen.sheetOpen).toBe(true);
  expect(screen.purpose).toBe("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(false);
  // Shown beside Save and said with it, hints on or off; the visible line is skipped so it is said once.
  expect(screen.saveValue).toBe("Scout's computer isn't connected.");
  expect(screen.shown("Scout's computer isn't connected.")).toEqual([{ hiddenFromReader: true }]);
  await screen.reconnect();
  expect(screen.purpose).toBe("Keeps an eye on the release");
  expect(screen.saveEnabled).toBe(true);
  expect(screen.saveValue).toBe(null);
  expect(screen.shown("Scout's computer isn't connected.")).toEqual([]);
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

it("after a refusal the row reads Loading with no name while the list is read again, and Couldn't load while the refusal stands", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  const refusal = AsyncResult.failure(Cause.fail(refused), {
    previousSuccess: Option.some(AsyncResult.success(botList)),
  });
  await screen.answer(refusal);
  expect(screen.row).toBe("GOAT Bot, Couldn't load");
  // Access back: the list is asked again and has not answered.
  await screen.answer(AsyncResult.waitingFrom(Option.some(refusal)));
  expect(screen.row).toBe("GOAT Bot, Loading…");
  await screen.openRow();
  expect(screen.sheetOpen).toBe(false);
  // Refused again, the refusal stands.
  await screen.answer(refusal);
  expect(screen.row).toBe("GOAT Bot, Couldn't load");
  await screen.answer(AsyncResult.initial(true));
  expect(screen.row).toBe("GOAT Bot, Loading…");
  await screen.answer(AsyncResult.success(botList));
  expect(screen.row).toBe("🐐 Scout, Edit");
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

it("once the connection is refused the row reads Couldn't load, not Offline or Loading", async () => {
  await using screen = await settings();
  await screen.answer(AsyncResult.success(botList));
  await screen.refuseConnection();
  expect(screen.row).toBe("GOAT Bot, Couldn't load");
});

it("offline, Messages, Workers and Model keep their last values with every control off and the reason read first, an open picker closes, and reconnecting turns them back on (#3503)", async () => {
  await using screen = await settings(config);
  await screen.openModel();
  expect(screen.choices).toEqual(["Automatic", "Fast"]);
  await screen.drop();
  expect(screen.toggle("Answer with the bot session")).toEqual({ checked: true, disabled: true });
  expect(screen.toggle("Automatically choose a worker computer")).toEqual({
    checked: true,
    disabled: true,
  });
  expect(screen.modelRow).toEqual({ label: "GOAT Bot model, Automatic", disabled: true });
  expect(screen.choices).toEqual([]);
  expect(screen.shown("Changes need Studio connected.")).toHaveLength(1);
  expect(screen.readsBefore("Changes need Studio connected.", "Messages")).toBe(true);
  await screen.reconnect();
  expect(screen.toggle("Answer with the bot session")).toEqual({ checked: true, disabled: false });
  expect(screen.toggle("Automatically choose a worker computer")).toEqual({
    checked: true,
    disabled: false,
  });
  expect(screen.modelRow).toEqual({ label: "GOAT Bot model, Automatic", disabled: false });
  expect(screen.choices).toEqual([]);
  expect(screen.shown("Changes need Studio connected.")).toEqual([]);
});

it("once the connection is refused, Messages, Workers and Model show none of that computer's settings and say they couldn't load (#3503)", async () => {
  await using screen = await settings(config);
  expect(screen.toggle("Answer with the bot session")).not.toBe(null);
  await screen.refuseConnection();
  expect(screen.toggle("Answer with the bot session")).toBe(null);
  expect(screen.toggle("Automatically choose a worker computer")).toBe(null);
  expect(screen.modelRow).toBe(null);
  expect(screen.titles).toEqual(["Profile", "Computers", "Messages", "Workers", "Model"]);
  expect(screen.shown("Couldn't load these settings from Studio.")).toHaveLength(1);
});

it("offline with no config ever loaded, Messages, Workers and Model keep their titles and say they show when the computer connects (#3503)", async () => {
  await using screen = await settings(null);
  await screen.drop();
  expect(screen.titles).toEqual(["Profile", "Computers", "Messages", "Workers", "Model"]);
  expect(screen.shown("Shown when Studio connects.")).toHaveLength(1);
});
