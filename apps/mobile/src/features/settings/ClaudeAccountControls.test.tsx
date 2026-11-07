import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: true,
  mutate: vi.fn(),
  alert: vi.fn(),
  instance: {
    driver: "claudeAgent",
    displayName: "Work",
    enabled: true,
    config: { homePath: "/old", modelRoute: "opencodex" },
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: (props: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: state.alert }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.mutate }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configProjection: () => "config",
    mutateProviderInstance: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      config: {
        settings: { providerInstances: { claudeAgent_work: state.instance } },
        environment: { capabilities: { providerInstancePreconditions: true } },
      },
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () =>
      AsyncResult.success({
        config: {
          settings: { providerInstances: { claudeAgent_work: state.instance } },
          environment: { capabilities: { providerInstancePreconditions: true } },
        },
      }),
  },
}));
import { ClaudeAccountControls } from "./ClaudeAccountControls";

it("saves the edited name and folder without changing the instance id", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.mutate.mockReset().mockResolvedValue(AsyncResult.success({}));
  const rootElement = document.createElement("div");
  const root = createRoot(rootElement);
  try {
    await act(() =>
      root.render(
        <ClaudeAccountControls
          environment={{ environmentId: EnvironmentId.make("env") } as never}
          provider={
            {
              instanceId: ProviderInstanceId.make("claudeAgent_work"),
              driver: ProviderDriverKind.make("claudeAgent"),
            } as never
          }
        />,
      ),
    );
    const button = (label: string) =>
      [...rootElement.querySelectorAll("button")].find((item) => item.textContent === label);
    await act(() => button("Edit account")?.click());
    const nameInput = rootElement.querySelector<HTMLInputElement>(
      'input[aria-label="Account name"]',
    );
    expect(nameInput?.value).toBe("Work");
    const input = rootElement.querySelector<HTMLInputElement>(
      'input[aria-label="Claude config folder"]',
    );
    expect(input?.value).toBe("/old");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(() => {
      if (nameInput) {
        setter?.call(nameInput, "Personal");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (input) {
        setter?.call(input, "/new");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(() => button("Save")?.click());
    expect(state.mutate).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: "claudeAgent_work",
          expectedInstance: state.instance,
          instance: {
            ...state.instance,
            displayName: "Personal",
            config: { homePath: "/new", modelRoute: "opencodex" },
          },
        },
      },
    });
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("does not remove an account when permission is revoked before confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.mutate.mockReset();
  state.alert.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <ClaudeAccountControls
          environment={{ environmentId: EnvironmentId.make("env") } as never}
          provider={
            {
              instanceId: ProviderInstanceId.make("claudeAgent_work"),
              driver: ProviderDriverKind.make("claudeAgent"),
            } as never
          }
        />,
      ),
    );
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Remove account")
        ?.click(),
    );
    const actions = state.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    state.allowed = false;
    await act(() => actions.find((action) => action.text === "Remove")?.onPress?.());
    expect(state.mutate).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("removes an added account after confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.mutate.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.alert.mockReset();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <ClaudeAccountControls
          environment={{ environmentId: EnvironmentId.make("env") } as never}
          provider={
            {
              instanceId: ProviderInstanceId.make("claudeAgent_work"),
              driver: ProviderDriverKind.make("claudeAgent"),
            } as never
          }
        />,
      ),
    );
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Remove account")
        ?.click(),
    );
    const actions = state.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    await act(() => actions.find((action) => action.text === "Remove")?.onPress?.());
    expect(state.mutate).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        patch: {},
        providerInstanceMutation: { operation: "remove", instanceId: "claudeAgent_work" },
      },
    });
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
