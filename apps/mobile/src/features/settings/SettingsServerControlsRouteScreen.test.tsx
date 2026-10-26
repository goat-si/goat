import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@goat/contracts";
import type { AgentToolListing } from "@goat/contracts/agentSurface/listing";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { useSyncExternalStore, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    revision: 0,
    listeners: new Set<() => void>(),
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    updateSettings: vi.fn(),
    alert: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    projectSelected: false,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({}),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(mocks.targets.map((target) => target.environmentId)),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({ RUNTIME_MODE_CHOICES: [] }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/DatabaseStorageNotice", () => ({ DatabaseStorageNotice: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsChoiceRow", () => ({
  SettingsChoiceRow: ({
    label,
    selected,
    disabled,
    onPress,
  }: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-pressed={selected} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/StandingInstructionsSettings", () => ({
  StandingInstructionsSettings: () => null,
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    subtitle,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    subtitle?: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      aria-description={subtitle}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => {
    useSyncExternalStore(
      (listener) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      () => mocks.revision,
    );
    return {
      selectedTargets: mocks.targets,
      projectGroups: [
        {
          key: "project",
          label: "Project",
          members: mocks.targets.map((target) => ({
            project: { environmentId: target.environmentId, id: "project" },
          })),
        },
      ],
      selectedProjectKey: mocks.projectSelected ? "project" : null,
    };
  },
}));

import {
  SettingsEnvironmentAgentBehaviorRouteScreen,
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsEnvironmentSourceControlRouteScreen,
} from "./SettingsServerControlsRouteScreen";

function environment(environmentId: string, label: string) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultAutoPull: false,
        sidebarAutoSettleOnMerge: false,
      },
      environment: {
        capabilities: { projectSettingsOverrides: true, threadAutoSettlement: true },
      },
    },
  };
}

function render(element: ReactNode) {
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
  root.render(element);
}
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.projectSelected = false;
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("maintenance automatic server updates", () => {
  const automaticUpdates = () => button("Automatic server updates");

  it("disables the switch until the server advertises the capability", () => {
    act(() => render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(automaticUpdates().disabled).toBe(true);
    expect(automaticUpdates().getAttribute("aria-description")).toBe(
      "Update this server to change this setting.",
    );

    mocks.targets = mocks.targets.map((target) => ({
      ...target,
      serverConfig: {
        ...target.serverConfig,
        environment: {
          capabilities: {
            ...target.serverConfig.environment.capabilities,
            automaticServerUpdates: true,
          },
        },
      },
    }));
    act(() => render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(automaticUpdates().disabled).toBe(false);
    expect(automaticUpdates().getAttribute("aria-description")).toBe(
      "When this server runs as a background service, install new releases from its channel while no threads are running. A failed update rolls back.",
    );
  });
});

describe("SettingsServerControlsRouteScreen", () => {
  it("writes the GOAT tool listing to the environment and keeps it environment-wide", async () => {
    const shippedDefault = DEFAULT_SERVER_SETTINGS.agentToolListing;
    const other: AgentToolListing = shippedDefault === "core" ? "full" : "core";
    const choice = (listing: AgentToolListing) =>
      buttonStartingWith(listing === "core" ? "Core" : "All tools");
    act(() => render(<SettingsEnvironmentAgentBehaviorRouteScreen />));
    expect(choice(shippedDefault).getAttribute("aria-pressed")).toBe("true");
    expect(choice(shippedDefault).textContent).toContain("(default)");

    await act(async () => choice(other).click());
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { patch: { agentToolListing: other } },
    });

    // A project has no override for this key, so the choice is not offered there.
    mocks.projectSelected = true;
    act(() => render(<SettingsEnvironmentAgentBehaviorRouteScreen />));
    expect(choice(other).disabled).toBe(true);
  });

  it("sends a draft saved during a pending write once that write settles", async () => {
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => render(<SettingsEnvironmentSourceControlRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });
});

function button(label: string) {
  const result = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function buttonStartingWith(label: string) {
  const result = Array.from(container.querySelectorAll("button")).find((element) =>
    element.textContent?.startsWith(label),
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
