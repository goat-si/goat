import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Action = { id: string; title: string };
type MenuProps = {
  actions: ReadonlyArray<Action>;
  shouldOpenOnLongPress?: boolean;
  onPressAction?: (event: { nativeEvent: { event: string } }) => void;
  children: ReactNode | ((open: () => void) => ReactNode);
};
const native = vi.hoisted(() => ({
  platform: { OS: "ios" as "ios" | "android" },
  menus: [] as Array<{ kind: string; actions: ReadonlyArray<Action>; longPress?: boolean }>,
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
  native.menus.push({ kind, actions: props.actions, longPress: props.shouldOpenOnLongPress });
  native.press = (id) => props.onPressAction?.({ nativeEvent: { event: id } });
  return (
    <div data-menu={kind} data-long-press={String(props.shouldOpenOnLongPress)}>
      {typeof props.children === "function" ? props.children(() => {}) : props.children}
    </div>
  );
});
// Android uses the native menu view so it is not drawn behind the Home sheet's modal; that layering
// is native and is not checked here. show() opens it.
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

async function show(os: "ios" | "android", row?: ReactElement<{ onLongPress?: () => void }>) {
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
        row={row}
      />,
    ),
  );
  return { container, onSelect, unmount: () => act(async () => root.unmount()) };
}

it("hands every row action to Android's native menu view, which TalkBack's activation opens", async () => {
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

// A context menu on the row stands for the long press its Pressable reports.
const Row = (props: { onLongPress?: () => void; onPress?: () => void }) => (
  <button aria-label="Task row" onClick={props.onPress} onContextMenu={props.onLongPress} />
);

it("on Android keeps the row outside the native menu view, whose long press opens the button's menu", async () => {
  const onPress = vi.fn();
  const view = await show("android", <Row onPress={onPress} />);
  const row = view.container.querySelector('[aria-label="Task row"]');
  // The native view takes every touch of what it wraps, so a wrapped row could not be tapped.
  expect(row?.closest("[data-menu]")).toBeNull();
  await act(async () => (row as HTMLButtonElement).click());
  expect(onPress).toHaveBeenCalledTimes(1);
  native.shown = 0;
  await act(async () =>
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(native.shown).toBe(1);
  expect(native.menus.map((menu) => menu.kind)).toEqual(["android"]);
  await view.unmount();
});

it("on iOS wraps the row in a menu set to open on long press, given the button's actions", async () => {
  const view = await show("ios", <Row />);
  const row = view.container.querySelector('[aria-label="Task row"]');
  expect(row?.closest("[data-menu]")?.getAttribute("data-long-press")).toBe("true");
  const rowMenu = native.menus.find((menu) => menu.longPress);
  const buttonMenu = native.menus.find((menu) => menu.longPress === false);
  expect(rowMenu?.actions).toEqual(actions);
  expect(buttonMenu?.actions).toEqual(actions);
  await view.unmount();
});
