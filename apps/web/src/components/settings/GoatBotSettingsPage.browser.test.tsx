import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS, EnvironmentId } from "@goat/contracts";
import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const STUDIO = EnvironmentId.make("env-studio");
const LAPTOP = EnvironmentId.make("env-laptop");

const state = vi.hoisted(() => ({
  persist: vi.fn(),
  environments: [] as ReadonlyArray<unknown>,
}));

function environment(environmentId: EnvironmentId, label: string, primary: boolean) {
  return {
    environmentId,
    connected: true,
    supportsChannelLedger: true,
    primary,
    label,
    settingsSnapshot: {},
    homeTarget: {
      environmentId,
      connected: true,
      supportsHome: true,
      supportsBot: true,
      settingsLoaded: true,
      home: { environmentId: STUDIO, claimedAt: 1_000, claimId: "claim-studio" },
    },
  } satisfies GoatBotEnvironmentInput;
}

vi.mock(import("../goatBot/goatBotHooks"), async (original) => ({
  ...(await original()),
  useGoatBotEnvironments: (() => state.environments) as never,
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
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.persist.mockReset().mockResolvedValue({ _tag: "Success" });
  state.environments = [
    environment(STUDIO, "Mac Studio", true),
    environment(LAPTOP, "MacBook", false),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows where GOAT Bot runs and every channel, and saves a new home to each computer", async () => {
  await act(async () => root.render(<GoatBotSettingsPanel />));

  expect(container.querySelector("section#goat-bot")).not.toBeNull();
  expect(container.querySelector("section#slack-channel")).not.toBeNull();
  expect(container.querySelector("section#imessage")).not.toBeNull();
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
