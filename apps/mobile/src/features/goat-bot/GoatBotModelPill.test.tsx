import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const platform = vi.hoisted(() => ({ OS: "android" as "android" | "ios" }));
type Props = { children?: ReactNode; style?: unknown; className?: string };
const box = vi.hoisted(
  () =>
    (name: string) =>
    (props: { children?: import("react").ReactNode; style?: unknown; className?: string }) => (
      <div
        data-box={name}
        data-style={JSON.stringify(props.style ?? null)}
        data-class={props.className}
      >
        {props.children}
      </div>
    ),
);
vi.mock("react-native", () => ({
  Platform: platform,
  View: box("view"),
  Text: (props: Props) => <span>{props.children}</span>,
  Pressable: (props: Props & { onPress?: () => void }) => (
    <button data-class={props.className} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../settings/appearance/useScaledTextRole", () => ({ useScaledTextRole: () => ({}) }));
vi.mock("../../components/ui/AndroidAnchoredMenu", () => ({
  AndroidAnchoredMenu: (props: Props & { children: (open: () => void) => ReactNode }) =>
    box("android-menu")({ ...props, children: props.children(() => {}) }),
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: box("ios-menu") }));

import { GoatBotModelPill } from "./GoatBotModelPill";

const menu = {
  label: "a-very-long-provider/model-name-that-does-not-fit-a-narrow-phone",
  accessibilityLabel: "GOAT Bot model",
  title: "GOAT Bot model",
  items: [],
  opens: true,
  canChange: true,
  select: () => {},
};

it("lets the model menu shrink so a long model name truncates and Send stays in the row", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const os of ["android", "ios"] as const) {
    platform.OS = os;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<GoatBotModelPill menu={menu} />));
    const wrapper = container.querySelector(`[data-box="${os}-menu"]`);
    expect(wrapper, os).not.toBeNull();
    expect(JSON.parse(wrapper?.getAttribute("data-style") ?? "null"), os).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
    });
    // Every box between the wrapper and the label shrinks too, down to the one-line label.
    for (const node of container.querySelectorAll("button, [data-box=view]"))
      expect(node.getAttribute("data-class"), os).toContain("shrink");
    await act(async () => root.unmount());
  }
});
