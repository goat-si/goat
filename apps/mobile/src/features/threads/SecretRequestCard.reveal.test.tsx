import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  answer: vi.fn(),
  appState: [] as Array<(next: string) => void>,
  blur: [] as Array<() => void>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  AppState: {
    addEventListener: (event: string, listener: (next: string) => void) => {
      const list = event === "blur" ? state.blur : state.appState;
      list.push(listener as never);
      return { remove: () => list.splice(list.indexOf(listener as never), 1) };
    },
  },
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
    onSubmitEditing?: (event: { nativeEvent: { text: string } }) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      type={props.secureTextEntry ? "password" : "text"}
      disabled={!props.editable}
      onInput={(event) => props.onChangeText(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter")
          props.onSubmitEditing?.({ nativeEvent: { text: event.currentTarget.value } });
      }}
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
  serverEnvironment: {
    openHandoff: {},
    answerSecretRequest: { permissionAtom: () => true },
    settingsValueAtom: () => null,
    configValueAtom: () => null,
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
import { SecretRequestCard } from "./SecretRequestCard";

const item = {
  type: "secret_request",
  id: TurnItemId.make("item:reveal"),
  threadId: ThreadId.make("thread:reveal"),
  label: "API key",
  reason: "Deploy",
  secretStatus: "pending",
};

async function renderRevealed() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.appState.length = 0;
  state.blur.length = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <SecretRequestCard
        environmentId={EnvironmentId.make("test")}
        projectedItem={{ item, visibility: "local" } as never}
        iconColor="black"
      />,
    ),
  );
  const field = () => container.querySelector<HTMLInputElement>('input[aria-label="API key"]')!;
  await act(() => {
    field().value = "sk-test-value";
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')!.click(),
  );
  expect(field().type).toBe("text");
  return { container, root, field };
}

it("masks a revealed secret again when it is submitted", async () => {
  let finish: (value: unknown) => void = () => {};
  state.answer.mockReset().mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const { root, field } = await renderRevealed();
  try {
    await act(() =>
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(state.answer).toHaveBeenCalledOnce();
    expect(field().type).toBe("password");
    await act(async () => finish({ _tag: "Success", value: undefined }));
  } finally {
    act(() => root.unmount());
  }
});

it("keeps the value masked under the error when the save fails", async () => {
  state.answer.mockReset().mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail({ _tag: "SecretRequestError", message: "The server refused the secret." }),
  });
  const { container, root, field } = await renderRevealed();
  try {
    await act(() =>
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(container.textContent).toContain("refused");
    expect(field().value).toBe("sk-test-value");
    expect(field().type).toBe("password");
  } finally {
    act(() => root.unmount());
  }
});

it("masks a revealed secret when the app leaves the foreground", async () => {
  const { root, field } = await renderRevealed();
  try {
    await act(() => state.appState.forEach((listener) => listener("inactive")));
    expect(field().type).toBe("password");
  } finally {
    act(() => root.unmount());
  }
});

it("masks a revealed secret when the window loses focus to the app switcher", async () => {
  // Android keeps the app resumed while its recents view shows it, so only blur arrives.
  const { root, field } = await renderRevealed();
  try {
    await act(() => state.blur.forEach((listener) => listener()));
    expect(field().type).toBe("password");
  } finally {
    act(() => root.unmount());
  }
});
