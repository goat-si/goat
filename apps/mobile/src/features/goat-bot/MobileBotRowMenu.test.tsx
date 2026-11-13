import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Action = { id: string; title: string };
type MenuProps = {
  actions: ReadonlyArray<Action>;
  onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  children: ReactNode | ((open: () => void) => ReactNode);
};
const native = vi.hoisted(() => ({
  platform: { OS: "ios" as "ios" | "android" },
  menus: [] as Array<{ kind: string; actions: ReadonlyArray<Action> }>,
  press: null as null | ((id: string) => void),
  shown: 0,
}));
vi.mock("react-native", () => ({
  Platform: native.platform,
  // A click stands for a screen reader activating the control.
  View: (props: {
    accessibilityLabel?: string;
    accessibilityActions?: ReadonlyArray<{ name: string }>;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      data-actions={props.accessibilityActions?.map((action) => action.name).join(",")}
      onClick={() => props.onAccessibilityAction?.({ nativeEvent: { actionName: "activate" } })}
    >
      {props.children}
    </button>
  ),
  Text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
const menu = vi.hoisted(() => (kind: string) => (props: MenuProps) => {
  native.menus.push({ kind, actions: props.actions });
  native.press = (id) => props.onPressAction?.({ nativeEvent: { event: id } });
  return (
    <div>{typeof props.children === "function" ? props.children(() => {}) : props.children}</div>
  );
});
// Android uses the native menu view, which opens above the Home sheet's modal; show() opens it.
vi.mock("@react-native-menu/menu", async () => {
  const React = await import("react");
  return {
    MenuView: React.forwardRef((props: MenuProps, ref) => {
      React.useImperativeHandle(ref, () => ({ show: () => (native.shown += 1) }));
      return menu("android")(props);
    }),
  };
});
vi.mock("../../components/ui/Menu", () => ({ Menu: menu("ios") }));

import { MobileBotRowMenu } from "./MobileBotRowMenu";

const actions = [
  { id: "work", title: "Show work" },
  { id: "pin", title: "Pin" },
  { id: "done", title: "Mark done" },
  { id: "read", title: "Mark read" },
];

async function show(os: "ios" | "android") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.platform.OS = os;
  native.menus = [];
  const onSelect = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MobileBotRowMenu
        label="Actions for Task"
        title="Task"
        actions={actions}
        onSelect={onSelect}
      />,
    ),
  );
  return { container, onSelect, unmount: () => act(async () => root.unmount()) };
}

it("hands every row action to Android's native menu view, which opens above the Home sheet", async () => {
  const view = await show("android");
  expect(native.menus.at(-1)?.kind).toBe("android");
  expect(native.menus.at(-1)?.actions.map((action) => action.title)).toEqual([
    "Show work",
    "Pin",
    "Mark done",
    "Mark read",
  ]);
  // TalkBack's activation opens the native menu, which otherwise opens on touch only.
  const control = view.container.querySelector('[aria-label="Actions for Task"]');
  expect(control?.getAttribute("data-actions")).toBe("activate");
  native.shown = 0;
  await act(async () => (control as HTMLButtonElement).click());
  expect(native.shown).toBe(1);
  await act(async () => native.press?.("read"));
  expect(view.onSelect).toHaveBeenCalledWith("read");
  await view.unmount();
});

it("uses the iOS menu with the same actions", async () => {
  const view = await show("ios");
  expect(native.menus.at(-1)?.kind).toBe("ios");
  expect(native.menus.at(-1)?.actions).toHaveLength(4);
  await act(async () => native.press?.("work"));
  expect(view.onSelect).toHaveBeenCalledWith("work");
  await view.unmount();
});
