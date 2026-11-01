import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as NodeModule from "node:module";
import { expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ pass: ({ children }: { children?: ReactNode }) => children }));
vi.mock("@expo/ui/jetpack-compose", () => {
  const DropdownMenu = Object.assign(h.pass, { Trigger: h.pass, Items: h.pass });
  const SplitButtonLayout = Object.assign(h.pass, {
    LeadingButton: ({
      children,
      enabled,
      onClick,
    }: {
      children: ReactNode;
      enabled: boolean;
      onClick: () => void;
    }) => (
      <button aria-label="merge" disabled={!enabled} onClick={onClick}>
        {children}
      </button>
    ),
    TrailingButton: ({
      children,
      enabled,
      onCheckedChange,
    }: {
      children: ReactNode;
      enabled: boolean;
      onCheckedChange: (value: boolean) => void;
    }) => (
      <div>
        <button aria-label="options" disabled={!enabled} onClick={() => onCheckedChange(true)} />
        {children}
      </div>
    ),
  });
  return {
    Box: h.pass,
    DropdownMenu,
    Icon: h.pass,
    LoadingIndicator: h.pass,
    RNHostView: h.pass,
    Row: h.pass,
    SplitButtonLayout,
    Text: h.pass,
  };
});
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  defaultMinSize: () => ({}),
  fillMaxWidth: () => ({}),
  rotate: () => ({}),
  semantics: () => ({}),
  size: () => ({}),
}));
vi.mock("react-native", () => ({ Pressable: h.pass }));
vi.mock("../../features/settings/appearance/useScaledTextRole", () => ({
  useScaledTextRole: () => ({}),
}));
vi.mock("./AppSymbol", () => ({ SymbolView: h.pass }));
vi.mock("./Button", () => ({ Button: h.pass }));
vi.mock("./NativeThemeHost.android", () => ({ NativeThemeHost: h.pass }));
vi.mock("./useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, iconSize: 16, mediumIconSize: 16, menuWidth: 200 }),
}));
vi.mock("./useControlTheme", () => ({ useControlTheme: () => ({ colors: {} }) }));
vi.mock("./MenuPopup.android", () => ({
  MenuPopupItems: ({ onPress }: { onPress: (action: { id: string }) => void }) => (
    <button onClick={() => onPress({ id: "rebase" })}>Rebase</button>
  ),
}));
import { SplitButton } from "./SplitButton.android";

it("keeps merge options available when the primary merge is disabled", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const extensions = NodeModule.createRequire(import.meta.url).extensions;
  const previousXml = extensions[".xml"];
  extensions[".xml"] = (module) => {
    module.exports = 1;
  };
  const onPress = vi.fn();
  const onPressAction = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <SplitButton
          label="Merge"
          menuTitle="Merge options"
          disabled
          onPress={onPress}
          actions={[{ id: "rebase", title: "Rebase" }]}
          onPressAction={onPressAction}
        />,
      ),
    );
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="merge"]')?.disabled).toBe(
      true,
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="options"]')?.disabled,
    ).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="options"]')?.click());
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Rebase")
        ?.click(),
    );
    expect(onPress).not.toHaveBeenCalled();
    expect(onPressAction).toHaveBeenCalledWith("rebase");
  } finally {
    act(() => root.unmount());
    if (previousXml) extensions[".xml"] = previousXml;
    else delete extensions[".xml"];
    vi.unstubAllGlobals();
  }
});
