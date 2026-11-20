import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// The native secret field (port of 35bda28117) and GOAT's fallback for a binary built before it.
const state = vi.hoisted(() => ({
  native: vi.fn((_props: Record<string, unknown>) => <span data-field="native" />),
  plain: vi.fn((_props: Record<string, unknown>) => <span data-field="plain" />),
}));
vi.mock("expo", () => ({ requireNativeView: () => state.native }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  processColor: () => 1,
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../lib/mobileTheme", () => ({ flattenThemeColor: () => "#000" }));
vi.mock("./PlainSecretTextInput", () => ({ PlainSecretTextInput: state.plain }));
vi.mock("./SecretRevealButton", () => ({ SecretRevealButton: () => null }));

const props = {
  accessibilityLabel: "API key",
  placeholder: "Paste the key",
  value: "",
  onChangeText: () => {},
  onSubmitEditing: () => {},
  editable: true,
  onFocus: vi.fn(),
};

async function renderWith(viewConfig: object | null) {
  vi.resetModules();
  state.native.mockClear();
  state.plain.mockClear();
  vi.stubGlobal("expo", viewConfig === null ? undefined : { getViewConfig: () => viewConfig });
  const { SecretTextInput } = await import("./SecretTextInput.android");
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<SecretTextInput {...props} />));
  return {
    container,
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the plain masked field on a binary without the native view", async () => {
  await using screen = await renderWith(null);
  expect(screen.container.querySelector("[data-field]")?.getAttribute("data-field")).toBe("plain");
  expect(state.plain.mock.calls[0]?.[0]).toMatchObject({ accessibilityLabel: "API key" });
});

it("uses the native field when the binary has it, and reports its focus", async () => {
  await using screen = await renderWith({ validAttributes: {} });
  expect(screen.container.querySelector("[data-field]")?.getAttribute("data-field")).toBe("native");
  const nativeProps = state.native.mock.calls[0]?.[0] as {
    inputLabel: string;
    onInputFocus: () => void;
  };
  expect(nativeProps.inputLabel).toBe("API key");
  nativeProps.onInputFocus();
  expect(props.onFocus).toHaveBeenCalledOnce();
});

it("masks the native field when it stops being editable and when the window loses focus", async () => {
  // The real eye and AppState for this case only; the cases above stub the eye.
  const blur: Array<() => void> = [];
  vi.resetModules();
  vi.doUnmock("./SecretRevealButton");
  vi.doMock("react-native", () => ({
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    processColor: () => 1,
    useWindowDimensions: () => ({ fontScale: 1 }),
    Pressable: (button: { accessibilityLabel?: string; onPress?: () => void }) => (
      <button aria-label={button.accessibilityLabel} onClick={button.onPress} />
    ),
    AppState: {
      addEventListener: (event: string, listener: () => void) => {
        if (event === "blur") blur.push(listener);
        return { remove: () => blur.splice(blur.indexOf(listener), 1) };
      },
    },
  }));
  vi.doMock("./AppSymbol", () => ({ SymbolView: () => null }));
  state.native.mockClear();
  vi.stubGlobal("expo", { getViewConfig: () => ({ validAttributes: {} }) });
  const { SecretTextInput } = await import("./SecretTextInput.android");
  const container = document.createElement("div");
  const root = createRoot(container);
  const revealed = () =>
    (state.native.mock.lastCall?.[0] as { revealed?: boolean } | undefined)?.revealed;
  const show = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Show secret"]')!.click();
  try {
    await act(async () => root.render(<SecretTextInput {...props} />));
    await act(async () => show());
    expect(revealed()).toBe(true);
    await act(async () => root.render(<SecretTextInput {...props} editable={false} />));
    expect(revealed()).toBe(false);
    await act(async () => root.render(<SecretTextInput {...props} />));
    await act(async () => show());
    expect(revealed()).toBe(true);
    await act(async () => blur.forEach((listener) => listener()));
    expect(revealed()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.doUnmock("react-native");
    vi.doUnmock("./AppSymbol");
  }
});
