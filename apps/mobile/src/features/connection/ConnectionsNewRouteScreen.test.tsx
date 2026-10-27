import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const { Children, harness } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <>{children}</>,
  harness: {
    connect: vi.fn(),
    remember: vi.fn(),
    remove: vi.fn(),
    leave: vi.fn(),
    alert: vi.fn(),
    setOptions: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  Linking: { openSettings: vi.fn() },
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("react-native-svg", () => ({
  default: Children,
  Defs: Children,
  RadialGradient: Children,
  Rect: () => null,
  Stop: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  useIsFocused: () => true,
  useNavigation: () => ({ canGoBack: () => true, setOptions: harness.setOptions }),
  useRoute: () => ({ name: "ConnectionsNew" }),
}));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("../../state/atom-registry");
  return {
    useAtomValue: (atom: Parameters<typeof appAtomRegistry.get>[0]) => appAtomRegistry.get(atom),
  };
});
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isLoaded: false, isSignedIn: false }) }));
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, vi.fn(async () => ({ granted: true }))],
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(async () => {}),
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: Children,
  AppTextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onInput={(event) => props.onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/FrostedCutout", () => ({ FrostedCutout: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: ({
    children,
    actions,
  }: {
    children?: ReactNode;
    actions: ReadonlyArray<{ onPress: () => void; disabled: boolean; loading: boolean }>;
  }) => (
    <>
      {children}
      {actions.map((action, index) => (
        <button key={index} aria-label="Submit" disabled={action.disabled} onClick={action.onPress}>
          {action.loading ? "Connecting" : "Connect"}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../settings/settings-navigation", () => ({ leaveSettingsPage: harness.leave }));
vi.mock("../workspace/workspace-selection-store", () => ({ workspaceHasColumns: () => false }));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("./CloudEnvironmentRows", () => ({ CloudEnvironmentRows: () => null }));
vi.mock("./useConnectionController", () => ({
  useConnectionController: () => ({
    connectPairingUrl: harness.connect,
    removeEnvironment: harness.remove,
  }),
}));
vi.mock("./useStoredHubEnvironment", () => ({
  useStoredHubEnvironment: () => ({
    loaded: true,
    storedHubId: "old-hub",
    error: null,
    rememberHubEnvironment: harness.remember,
  }),
}));
vi.mock("../../state/workspace", () => ({
  useConnectionsReady: () => true,
  useWorkspaceEnvironments: () => [{ environmentId: "old-hub", environmentLabel: "Old hub" }],
  useWorkspaceConnectionState: () => ({ connectionState: "connected", connectionError: null }),
}));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/remote-environment-projections", () => ({
  createRemoteEnvironmentProjectionAtoms: () => ({}),
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentCatalog: { networkStatusValueAtom: Atom.make("online") } };
});

import { ConnectionsNewRouteScreen } from "./ConnectionsNewRouteScreen";
import {
  setPendingConnectionError,
  useRemoteConnections,
} from "../../state/use-remote-environment-registry";

type Params = NonNullable<Parameters<typeof ConnectionsNewRouteScreen>[0]["route"]["params"]>;
type Result = AsyncResult.AsyncResult<EnvironmentId, Error>;
const failure = (message: string) => AsyncResult.failure(Cause.fail(new Error(message)));

function setup(params: Params = { intent: "change-hub" }, dev = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__DEV__", dev);
  vi.clearAllMocks();
  harness.connect.mockReset().mockResolvedValue(failure("Pairing code expired."));
  harness.remember.mockReset().mockResolvedValue(undefined);
  harness.remove.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  setPendingConnectionError("Could not send the message.");
  const container = document.createElement("div");
  const root = createRoot(container);
  let globalError: string | null = null;
  let clearPairingUrl = () => {};
  function ErrorProbe() {
    const connections = useRemoteConnections();
    globalError = connections.connectionError;
    clearPairingUrl = () => connections.onChangeConnectionPairingUrl("");
    return null;
  }
  function Screen({ params: nextParams }: { params: Params }) {
    return (
      <>
        <ErrorProbe />
        <ConnectionsNewRouteScreen route={{ params: nextParams }} />
      </>
    );
  }
  function rerender(nextParams = params) {
    act(() => root.render(<Screen params={nextParams} />));
  }
  rerender();
  if (!container.querySelector("input")) {
    const advanced = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Advanced",
    );
    act(() => advanced?.click());
  }
  return {
    container,
    rerender,
    get globalError() {
      return globalError;
    },
    edit(label: string, value: string) {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
      if (!input) throw new Error(`Missing ${label} input`);
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    async submit() {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Submit"]')?.click(),
      );
    },
    unmount() {
      act(() => root.render(<ErrorProbe />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      clearPairingUrl();
      setPendingConnectionError(null);
      vi.unstubAllGlobals();
    },
  };
}

it("shows only its own failure and preserves another feature's error on edit and leave", async () => {
  using screen = setup();
  expect(screen.container.textContent).not.toContain("Could not send the message.");
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  expect(screen.container.textContent).toContain("Pairing code expired.");
  expect(screen.container.textContent).toContain("Pairing code");
  screen.rerender();
  expect(screen.globalError).toBe("Could not send the message.");
  screen.edit("Code", "replacement-code");
  expect(screen.container.textContent).not.toContain("Pairing code expired.");
  screen.unmount();
  screen.rerender();
  expect(screen.globalError).toBe("Could not send the message.");
});

it.each(["failure", "success", "rejection", "unsupported"] as const)(
  "ignores an old %s after an edit and a newer submission",
  async (outcome) => {
    using screen = setup();
    const old = Promise.withResolvers<Result>();
    const current = Promise.withResolvers<Result>();
    harness.connect.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    screen.edit("Address", "https://first.invalid");
    await screen.submit();
    screen.edit("Address", "https://second.invalid");
    await screen.submit();
    expect(harness.connect).toHaveBeenCalledTimes(2);
    setPendingConnectionError("Git refresh failed.");
    screen.rerender();
    await act(async () => {
      if (outcome === "rejection") old.reject(new Error("Old rejection"));
      else
        old.resolve(
          outcome === "success"
            ? AsyncResult.success(EnvironmentId.make("stale-hub"))
            : outcome === "unsupported"
              ? AsyncResult.failure(
                  Cause.fail(
                    Object.assign(new Error("Old unsupported client"), { reason: "unsupported" }),
                  ),
                )
              : failure("Old failure"),
        );
      await old.promise.catch(() => {});
    });
    expect(screen.container.textContent).toContain("Connecting");
    expect(screen.container.textContent).not.toContain("Old failure");
    expect(screen.container.textContent).not.toContain("Old rejection");
    expect(harness.remember).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.leave).not.toHaveBeenCalled();
    expect(harness.alert).not.toHaveBeenCalled();
    await act(async () => {
      current.resolve(failure("Current failure"));
      await current.promise;
    });
    expect(screen.container.textContent).toContain("Current failure");
    expect(screen.globalError).toBe("Git refresh failed.");
  },
);

it("ignores a result when a different dev pairing link replaces the route", async () => {
  using screen = setup({ pairingUrl: "https://first.invalid", autoConnect: "true" }, true);
  const pending = Promise.withResolvers<Result>();
  harness.connect.mockReturnValueOnce(pending.promise);
  screen.rerender({ pairingUrl: "https://second.invalid", autoConnect: "true" });
  expect(harness.connect).toHaveBeenLastCalledWith("https://second.invalid", undefined);
  screen.rerender({ pairingUrl: "https://third.invalid" });
  await act(async () => {
    pending.resolve(failure("Replaced link failed"));
    await pending.promise;
  });
  expect(screen.container.textContent).not.toContain("Replaced link failed");
  expect(
    screen.container.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value,
  ).toBe("https://third.invalid");
  expect(harness.leave).not.toHaveBeenCalled();
});

it("ignores a result for a route whose expected environment has changed", async () => {
  using screen = setup({ routeFor: EnvironmentId.make("first-hub") });
  const pending = Promise.withResolvers<Result>();
  harness.connect.mockReturnValueOnce(pending.promise);
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  screen.rerender({ routeFor: EnvironmentId.make("second-hub") });
  await act(async () => {
    pending.resolve(AsyncResult.success(EnvironmentId.make("first-hub")));
    await pending.promise;
  });
  expect(harness.remember).not.toHaveBeenCalled();
  expect(harness.remove).not.toHaveBeenCalled();
  expect(harness.leave).not.toHaveBeenCalled();
});

it("shows unsupported-client failures in their dialog without claiming the hub", async () => {
  using screen = setup();
  harness.connect.mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(Object.assign(new Error("Upgrade the client."), { reason: "unsupported" })),
    ),
  );
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  expect(harness.alert).toHaveBeenCalledWith("Client not supported", "Upgrade the client.");
  expect(screen.container.textContent).not.toContain("Upgrade the client.");
  expect(harness.remember).not.toHaveBeenCalled();
  expect(harness.remove).not.toHaveBeenCalled();
  expect(harness.leave).not.toHaveBeenCalled();
});

it("ignores a pairing success after the form unmounts", async () => {
  using screen = setup();
  const pending = Promise.withResolvers<Result>();
  harness.connect.mockReturnValueOnce(pending.promise);
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  screen.unmount();
  await act(async () => {
    pending.resolve(AsyncResult.success(EnvironmentId.make("new-hub")));
    await pending.promise;
  });
  expect(harness.remember).not.toHaveBeenCalled();
  expect(harness.remove).not.toHaveBeenCalled();
  expect(harness.leave).not.toHaveBeenCalled();
});

it("forwards the expected environment identity and leaves the hub alone when pairing is denied", async () => {
  const expected = EnvironmentId.make("expected-hub");
  using screen = setup({ routeFor: expected });
  screen.edit("Address", "https://other.invalid");
  harness.connect.mockResolvedValueOnce(failure("Environment identity does not match."));
  await screen.submit();
  expect(harness.connect).toHaveBeenCalledWith("https://other.invalid", expected);
  expect(screen.container.textContent).toContain("Environment identity does not match.");
  expect(harness.remember).not.toHaveBeenCalled();
  expect(harness.remove).not.toHaveBeenCalled();
  expect(harness.leave).not.toHaveBeenCalled();
});

it.each(["1", "true"])(
  "rejects production deep-link prefill and auto-pairing with %s",
  (autoConnect) => {
    using screen = setup({
      pairingUrl: "https://untrusted.invalid#token=example-code",
      autoConnect,
    });
    expect(
      screen.container.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.value,
    ).toBe("");
    expect(
      screen.container.querySelector<HTMLInputElement>('input[aria-label="Code"]')?.value,
    ).toBe("");
    expect(harness.connect).not.toHaveBeenCalled();
  },
);

it("persists a newly paired hub before removing the old hub and leaving", async () => {
  using screen = setup();
  const remembered = Promise.withResolvers<void>();
  const newHub = EnvironmentId.make("new-hub");
  harness.connect.mockResolvedValueOnce(AsyncResult.success(newHub));
  harness.remember.mockReturnValueOnce(remembered.promise);
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  expect(harness.remove).not.toHaveBeenCalled();
  await act(async () => {
    remembered.resolve();
    await remembered.promise;
  });
  expect(harness.remember).toHaveBeenCalledWith({
    intent: "change-hub",
    pairedEnvironmentId: newHub,
  });
  expect(harness.remove).toHaveBeenCalledWith("old-hub");
  expect(harness.leave).toHaveBeenCalledOnce();
});

it("keeps the form open with a completion error when the old hub cannot be removed", async () => {
  using screen = setup();
  harness.connect.mockResolvedValueOnce(AsyncResult.success(EnvironmentId.make("new-hub")));
  harness.remove.mockResolvedValueOnce(failure("Hub removal failed"));
  screen.edit("Address", "https://pairing.invalid");
  await screen.submit();
  expect(screen.container.textContent).toContain("couldn't remove Old hub");
  expect(harness.leave).not.toHaveBeenCalled();
});
