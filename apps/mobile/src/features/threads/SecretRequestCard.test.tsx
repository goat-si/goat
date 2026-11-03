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
    autoComplete?: string;
    textContentType?: string;
    importantForAutofill?: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      type={props.secureTextEntry ? "password" : "text"}
      data-autocomplete={props.autoComplete}
      data-content-type={props.textContentType}
      data-autofill={props.importantForAutofill}
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
    const setupKey = container.querySelector<HTMLInputElement>(
      'input[aria-label="Authenticator setup key"]',
    );
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save securely",
    );
    expect(user).not.toBeNull();
    expect(password?.type).toBe("password");
    expect(setupKey?.type).toBe("password");
    expect(setupKey?.dataset.autocomplete).toBe("off");
    expect(setupKey?.dataset.contentType).toBe("none");
    expect(setupKey?.dataset.autofill).toBe("no");
    expect(save?.disabled).toBe(true);
    await act(() => {
      user!.value = "test-user";
      user!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save?.disabled).toBe(true);
    await act(() => {
      password!.value = "  pass word  ";
      password!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save?.disabled).toBe(false);
    await act(() => {
      setupKey!.value = "  abcd efgh  ";
      setupKey!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => save!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        threadId: "thread:login",
        turnItemId: "item:login",
        answer: {
          type: "save_login",
          username: "test-user",
          password: "  pass word  ",
          authenticatorSetupKey: "abcd efgh",
        },
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

it("validates all card fields, masks the CVC and saves the card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answer.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  const container = document.createElement("div");
  const root = createRoot(container);
  const item = {
    type: "secret_request",
    id: TurnItemId.make("item:card"),
    threadId: ThreadId.make("thread:card"),
    label: "Payment",
    reason: "Pay",
    secretStatus: "pending",
    requestKind: "card",
    siteOrigin: "https://card.test",
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
    const fields = ["Card number", "Expiry month", "Expiry year", "CVC", "Name on card"].map(
      (label) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`),
    );
    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save securely",
    );
    expect(fields.every(Boolean)).toBe(true);
    for (const field of fields) {
      expect(field?.dataset.autocomplete).toBe("off");
      expect(field?.dataset.contentType).toBe("none");
      expect(field?.dataset.autofill).toBe("no");
    }
    expect(fields[3]?.type).toBe("password");
    expect(save?.disabled).toBe(true);
    for (const [index, value] of [
      "4242 4242-4242 4242",
      "01",
      "29",
      "003",
      "  Example Name  ",
    ].entries()) {
      await act(() => {
        const field = fields[index]!;
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(save?.disabled).toBe(false);
    await act(() => save!.click());
    expect(state.answer).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        threadId: "thread:card",
        turnItemId: "item:card",
        answer: {
          type: "save_card",
          number: "4242424242424242",
          expiryMonth: "01",
          expiryYear: "2029",
          cvc: "003",
          name: "  Example Name  ",
        },
      },
    });
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
