// Android: the recents view keeps the activity resumed, so only AppState "blur" arrives.
import { EnvironmentId, ThreadId, TurnItemId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  answer: vi.fn(),
  appState: [] as Array<(next: string) => void>,
  blur: [] as Array<() => void>,
  os: "android",
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("react-native", () => ({
  processColor: () => 1,
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Platform: {
    get OS() {
      return state.os;
    },
  },
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
      // As React Native: iOS's AppState emits no focus events and refuses the subscription.
      if (event === "blur" && state.os === "ios")
        throw new Error("appStateFocusChange is not a supported event type for RCTAppState");
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
// The Android variant on a binary without the native view, which keeps the plain field.
vi.mock("expo", () => ({ requireNativeView: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/mobileTheme", () => ({ flattenThemeColor: () => "#000" }));
vi.mock(
  "../../components/ui/SecretTextInput",
  async () => await import("../../components/ui/SecretTextInput.android"),
);
import { SecretRequestCard } from "./SecretRequestCard";

const item = {
  type: "secret_request",
  id: TurnItemId.make("item:reveal"),
  threadId: ThreadId.make("thread:reveal"),
  label: "API key",
  reason: "Deploy",
  secretStatus: "pending",
};

async function renderRevealed(os = "android") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.appState.length = 0;
  state.blur.length = 0;
  state.os = os;
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
