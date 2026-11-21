import type { ReactNode } from "react";
import { Activity, StrictMode, act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Measured = (x: number, y: number, width: number, height: number) => void;
// Measurements the anchor asked for and the test has not answered yet; the overlay answers at once.
const h = vi.hoisted(() => ({ held: [] as Measured[], keyboard: true }));
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
    pick({ isVisible: h.keyboard, height: h.keyboard ? 250 : 0 }),
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
  h.keyboard = true;
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
    hideKeyboard: () =>
      act(async () => {
        h.keyboard = false;
        root.render(
          <StrictMode>
            <Owner />
          </StrictMode>,
        );
      }),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      container.remove();
      if (original) Object.defineProperty(HTMLElement.prototype, "measureInWindow", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "measureInWindow");
    },
  };
}

it("closes an anchored menu when the keyboard hides", async () => {
  await using menu = await mountMenu();
  await menu.request();
  await menu.measure(300, 48);
  expect(menu.items()).toEqual(["Hide"]);
  await menu.hideKeyboard();
  expect(menu.items()).toEqual([]);
  expect(menu.closed).toHaveBeenCalledTimes(1);
});
