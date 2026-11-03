import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: {
    accessibilityLabel: string;
    value: string;
    secureTextEntry?: boolean;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      type={props.secureTextEntry ? "password" : "text"}
      disabled={!props.editable}
      onInput={(event) => props.onChangeText(event.currentTarget.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { openHandoff: {}, answerSecretRequest: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
import { SecretRequestCard } from "./SecretRequestCard";

it("requires both fields and masks the login password before saving", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const container = document.createElement("div");
  const root = createRoot(container);
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:login"),
    threadId: ThreadId.make("thread:login"),
    label: "Site login",
    reason: "Sign in",
    secretStatus: "pending",
    requestKind: "login",
    siteOrigin: "https://login.test",
  };
  try {
    await act(() =>
      root.render(
        <SecretRequestCard
          environmentId={EnvironmentId.make("test")}
          projectedItem={{ item, visibility: "local" } as never}
          iconColor="black"
        />,
      ),
    );
    const user = container.querySelector<HTMLInputElement>('input[aria-label="Username"]');
    const password = container.querySelector<HTMLInputElement>('input[aria-label="Password"]');
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save securely",
    );
    expect(user).not.toBeNull();
    expect(password?.type).toBe("password");
    expect(save?.disabled).toBe(true);
    await act(() => {
      user!.value = "test-user";
      user!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save?.disabled).toBe(true);
    await act(() => {
      password!.value = "test-password";
      password!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save?.disabled).toBe(false);
    await act(() => save!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        threadId: "thread:login",
        turnItemId: "item:login",
        answer: { type: "save_login", username: "test-user", password: "test-password" },
      },
    });
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the existing masked single-secret form", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const container = document.createElement("div");
  const root = createRoot(container);
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:secret"),
    threadId: ThreadId.make("thread:secret"),
    label: "API secret",
    reason: "Connect",
    secretStatus: "pending",
  };
  try {
    await act(() =>
      root.render(
        <SecretRequestCard
          environmentId={EnvironmentId.make("test")}
          projectedItem={{ item, visibility: "local" } as never}
          iconColor="black"
        />,
      ),
    );
    const secret = container.querySelector<HTMLInputElement>('input[aria-label="API secret"]');
    expect(secret?.type).toBe("password");
    expect(container.querySelector('input[aria-label="Username"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
