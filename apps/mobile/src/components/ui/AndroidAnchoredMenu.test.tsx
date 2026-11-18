import type { ReactNode } from "react";
import { Activity, StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Measured = (x: number, y: number, width: number, height: number) => void;
// Measurements the anchor asked for and the test has not answered yet; the overlay answers at once.
const h = vi.hoisted(() => ({ held: [] as Measured[] }));
vi.mock("react-native", async () => {
  const { useEffect } = await import("react");
  type Props = {
    children?: ReactNode;
    ref?: (node: HTMLElement | null) => void;
    className?: string;
    onLayout?: () => void;
    onPress?: () => void;
    accessible?: boolean;
  };
  // Like a native view, it lays out once when it mounts.
  const View = ({ ref, children, className, onLayout }: Props) => {
    useEffect(() => onLayout?.(), []);
    return (
      <div ref={ref} data-overlay={className?.includes("inset-0") ? "" : undefined}>
        {children}
      </div>
    );
  };
  const Pressable = ({ ref, children, accessible, onPress }: Props) => (
    <button
      ref={ref}
      aria-label={accessible === false ? "Outside the menu" : undefined}
      onClick={onPress}
    >
      {children}
    </button>
  );
  return { View, Pressable, ScrollView: View };
});
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: (pick: (state: { isVisible: boolean; height: number }) => unknown) =>
    pick({ isVisible: false, height: 0 }),
}));
vi.mock("../../lib/backHandler", () => ({ useHardwareBack: () => {} }));
vi.mock("./OverlayPortal", () => ({
  OverlayPortal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, menuWidth: 200 }),
}));
vi.mock("./MenuPopup", () => ({
  MenuPopup: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPress: (action: { id: string; title: string }) => void;
  }) => (
    <div role="menu">
      {props.actions.map((action) => (
        <button key={action.id} onClick={() => props.onPress(action)}>
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";

const click = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent) === label)
    ?.click();

/** The real menu under an owner that counts it open from the request until the menu settles it. */
async function mountMenu(options: { inTab?: boolean } = {}) {
  h.held.length = 0;
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "measureInWindow");
  Object.defineProperty(HTMLElement.prototype, "measureInWindow", {
    configurable: true,
    value(this: HTMLElement, done: Measured) {
      if (this.hasAttribute("data-overlay")) done(0, 0, 400, 800);
      else h.held.push(done);
    },
  });
  const closed = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Owner() {
    const [rowShown, setRowShown] = useState(true);
    return (
      <>
        {rowShown ? (
          <AndroidAnchoredMenu actions={[{ id: "hide", title: "Hide" }]} onClose={closed}>
            {(open) => <button onClick={open}>Long press Research</button>}
          </AndroidAnchoredMenu>
        ) : null}
        <button onClick={() => setRowShown(false)}>Remove the row</button>
      </>
    );
  }
  // A workspace tab: hiding it runs every effect cleanup and keeps state, as Android's tab panes do.
  function Tab() {
    const [shown, setShown] = useState(true);
    return (
      <>
        <Activity mode={shown ? "visible" : "hidden"}>
          <Owner />
        </Activity>
        <button onClick={() => setShown((value) => !value)}>Switch tab</button>
      </>
    );
  }
  await act(async () =>
    root.render(<StrictMode>{options.inTab === true ? <Tab /> : <Owner />}</StrictMode>),
  );
  const items = () =>
    [...container.querySelectorAll('[role="menu"] button')].map((button) => button.textContent);
  return {
    closed,
    items,
    request: () => act(async () => click(container, "Long press Research")),
    removeRow: () => act(async () => click(container, "Remove the row")),
    measure: (width: number, height: number) =>
      act(async () => {
        for (const done of h.held.splice(0)) done(10, 20, width, height);
      }),
    /** Answers one held measurement, in the order they were asked, leaving the others held. */
    answer: (index: number, width: number, height: number) =>
      act(async () => h.held[index]?.(10, 20, width, height)),
    press: (label: string) => act(async () => click(container, label)),
    container,
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      container.remove();
      if (original) Object.defineProperty(HTMLElement.prototype, "measureInWindow", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "measureInWindow");
    },
  };
}

it("tells its owner once when its row leaves before the menu was measured (#3575)", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.removeRow();
  expect(menu.closed).toHaveBeenCalledTimes(1);
  // The measurement that lands afterwards opens nothing and tells nothing more.
  await menu.measure(300, 48);
  expect(menu.closed).toHaveBeenCalledTimes(1);
});

it("tells its owner once and shows nothing when its row cannot be measured (#3575)", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.measure(0, 0);
  expect(menu.items()).toEqual([]);
  expect(menu.closed).toHaveBeenCalledTimes(1);
  await menu.removeRow();
  expect(menu.closed).toHaveBeenCalledTimes(1);
});

it("tells its owner once when a choice closes it and its row leaves before that commits (#3575)", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.measure(300, 48);
  expect(menu.items()).toEqual(["Hide"]);
  // Both in one batch: the row leaves before the closed menu commits.
  await act(async () => {
    click(menu.container, "Hide");
    click(menu.container, "Remove the row");
  });
  expect(menu.closed).toHaveBeenCalledTimes(1);
});

it("guard: a menu that was never opened tells its owner nothing, mounted under StrictMode or removed", async () => {
  await using menu = await mountMenu();
  await menu.removeRow();
  expect(menu.closed).not.toHaveBeenCalled();
});

it("guard: an outside tap closes a measured menu and tells its owner once", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.measure(300, 48);
  await menu.press("Outside the menu");
  expect(menu.items()).toEqual([]);
  expect(menu.closed).toHaveBeenCalledTimes(1);
  await menu.removeRow();
  expect(menu.closed).toHaveBeenCalledTimes(1);
});

it("tells its owner once when its tab hides it, and shows no stale menu when the tab returns (#3575)", async () => {
  await using menu = await mountMenu({ inTab: true });
  await menu.request();
  await menu.measure(300, 48);
  expect(menu.items()).toEqual(["Hide"]);
  await menu.press("Switch tab");
  expect(menu.closed).toHaveBeenCalledTimes(1);
  await menu.press("Switch tab");
  expect(menu.items()).toEqual([]);
  // A fresh open still works and settles once more.
  await menu.request();
  await menu.measure(300, 48);
  await menu.press("Outside the menu");
  expect(menu.closed).toHaveBeenCalledTimes(2);
});

it("lets only the latest request open or settle the menu when an earlier measurement answers late (#3575)", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.request();
  await menu.answer(1, 300, 48);
  expect(menu.items()).toEqual(["Hide"]);
  // The first request's measurement answers late, with nothing to anchor to.
  await menu.answer(0, 0, 0);
  expect(menu.items()).toEqual(["Hide"]);
  expect(menu.closed).not.toHaveBeenCalled();
  await menu.press("Outside the menu");
  expect(menu.items()).toEqual([]);
  expect(menu.closed).toHaveBeenCalledTimes(1);
});

it("closes a shown menu, and tells its owner once, when a newer request cannot be measured (#3611)", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.measure(300, 48);
  expect(menu.items()).toEqual(["Hide"]);
  // The row asks again while the menu is up, and this time it cannot be measured.
  await menu.request();
  await menu.measure(0, 0);
  expect(menu.items()).toEqual([]);
  expect(menu.closed).toHaveBeenCalledTimes(1);
  // Nothing is left open to report.
  await menu.press("Outside the menu");
  await menu.removeRow();
  expect(menu.closed).toHaveBeenCalledTimes(1);
});
