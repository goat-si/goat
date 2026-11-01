import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@goat/contracts";
import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadSelectionStore } from "../../threadSelectionStore";
import { ThreadContextDragGhost } from "../chat/ThreadContextDragGhost";
import { THREAD_CONTEXT_DROP_EVENT, threadContextDropTargetProps } from "../chat/threadContextDrag";
import { threadContextDragListProps, useThreadContextDragHandle } from "./useThreadContextDrag";

const environmentId = EnvironmentId.make("environment-remote");
const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));

// The list spans x 0..200; the composer sits to its right.
const LIST_RIGHT = 200;

let container: HTMLDivElement;
let root: Root;
let composer: HTMLFormElement;
let drops: ScopedThreadRef[][];
const onRowClick = vi.fn();

function Row(props: { id: string; title: string; disabled?: boolean }) {
  const listeners = useThreadContextDragHandle({
    threadKey: keyOf(props.id),
    title: props.title,
    disabled: props.disabled ?? false,
  });
  return createElement(
    "li",
    null,
    createElement(
      "div",
      {
        role: "button",
        "data-testid": props.id,
        onClick: onRowClick,
        ...listeners,
      },
      props.title,
      createElement("button", { type: "button", "data-testid": `${props.id}-action` }, "Archive"),
    ),
  );
}

function render(rows: ReadonlyArray<{ id: string; title: string; disabled?: boolean }>) {
  act(() => {
    root.render(
      createElement(
        "div",
        null,
        createElement(ThreadContextDragGhost),
        createElement(
          "ul",
          { ...threadContextDragListProps(), "data-testid": "list" },
          rows.map((row) => createElement(Row, { key: row.id, ...row })),
        ),
      ),
    );
  });
  const list = container.querySelector<HTMLElement>('[data-testid="list"]')!;
  list.getBoundingClientRect = () => new DOMRect(0, 0, LIST_RIGHT, 400);
}

function pointer(type: string, x: number, init: { buttons?: number; ctrlKey?: boolean } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 20,
    button: 0,
    buttons: init.buttons ?? 1,
    ctrlKey: init.ctrlKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  return event;
}

// ThreadContextDragGhost portals straight into the body.
const ghostText = () =>
  document.body.querySelector(':scope > [aria-hidden="true"]')?.textContent ?? null;

function drag(target: Element, path: readonly number[], release: number) {
  act(() => {
    target.dispatchEvent(pointer("pointerdown", 20));
    for (const x of path) document.dispatchEvent(pointer("pointermove", x));
  });
  const ghost = ghostText();
  act(() => {
    document.dispatchEvent(pointer("pointerup", release, { buttons: 0 }));
  });
  expect(ghostText()).toBeNull();
  return ghost;
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  composer = document.createElement("form");
  for (const [name, value] of Object.entries(threadContextDropTargetProps())) {
    composer.setAttribute(name, value);
  }
  document.body.append(container, composer);
  drops = [];
  onRowClick.mockClear();
  composer.addEventListener(THREAD_CONTEXT_DROP_EVENT, (event) => {
    drops.push([...(event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail]);
  });
  document.elementFromPoint = (x: number) => (x > LIST_RIGHT + 50 ? composer : null);
  useThreadSelectionStore.setState({ selectedThreadKeys: new Set(), anchorThreadKey: null });
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useThreadContextDragHandle", () => {
  // Activity Priority rows, rows on servers without pin ordering, and every
  // Projects view row take this path: they never sort but still drag out.
  it("hands a row dropped on a composer outside the list over as context", () => {
    render([{ id: "priority", title: "Running thread" }]);
    const ghost = drag(row("priority"), [40, 120, 320], 320);
    expect(ghost).toBe("Running thread");
    expect(drops).toEqual([[scopeThreadRef(environmentId, ThreadId.make("priority"))]]);
    // The composer highlight clears on release with the ghost.
    expect(document.querySelector("[data-thread-context-over]")).toBeNull();
  });

  it("hands over the whole selection when the dragged row is selected", () => {
    render([
      { id: "a", title: "First" },
      { id: "b", title: "Second" },
      { id: "c", title: "Third" },
    ]);
    useThreadSelectionStore.setState({ selectedThreadKeys: new Set([keyOf("a"), keyOf("c")]) });
    const ghost = drag(row("c"), [120, 320], 320);
    expect(ghost).toBe("Third+1");
    expect(drops).toEqual([
      [
        scopeThreadRef(environmentId, ThreadId.make("a")),
        scopeThreadRef(environmentId, ThreadId.make("c")),
      ],
    ]);

    drag(row("b"), [120, 320], 320);
    expect(drops[1]).toEqual([scopeThreadRef(environmentId, ThreadId.make("b"))]);
  });

  it("changes nothing when released inside the list, and swallows the release click", () => {
    render([{ id: "priority", title: "Running thread" }]);
    const ghost = drag(row("priority"), [60, 120], 120);
    expect(ghost).toBeNull();
    expect(drops).toEqual([]);
    act(() => row("priority").click());
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("drops nothing when released outside the list away from a composer", () => {
    render([{ id: "a", title: "First" }]);
    const ghost = drag(row("a"), [230], 230);
    expect(ghost).toBe("First");
    expect(drops).toEqual([]);
  });

  it("leaves plain clicks, nested controls, and macOS ctrl-clicks alone", () => {
    render([{ id: "a", title: "First" }]);
    act(() => {
      row("a").dispatchEvent(pointer("pointerdown", 20));
      document.dispatchEvent(pointer("pointerup", 20, { buttons: 0 }));
      row("a").click();
    });
    expect(onRowClick).toHaveBeenCalledOnce();

    expect(drag(row("a-action"), [120, 320], 320)).toBeNull();
    expect(drops).toEqual([]);

    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    act(() => {
      row("a").dispatchEvent(pointer("pointerdown", 20, { ctrlKey: true }));
      document.dispatchEvent(pointer("pointermove", 320));
    });
    expect(ghostText()).toBeNull();
    act(() => {
      document.dispatchEvent(pointer("pointerup", 320, { buttons: 0 }));
    });
    expect(drops).toEqual([]);
  });

  it("does not start while disabled for an inline rename", () => {
    render([{ id: "a", title: "First", disabled: true }]);
    expect(drag(row("a"), [120, 320], 320)).toBeNull();
    expect(drops).toEqual([]);
  });

  it("drops an in-flight gesture when the row stops allowing context drag", () => {
    // An Activity row can turn sortable mid-press, say when a pending order write lands.
    render([{ id: "a", title: "First" }]);
    act(() => {
      row("a").dispatchEvent(pointer("pointerdown", 20));
      document.dispatchEvent(pointer("pointermove", 320));
    });
    expect(ghostText()).toBe("First");
    render([{ id: "a", title: "First", disabled: true }]);
    expect(ghostText()).toBeNull();
    act(() => {
      document.dispatchEvent(pointer("pointermove", 330));
      document.dispatchEvent(pointer("pointerup", 330, { buttons: 0 }));
    });
    expect(ghostText()).toBeNull();
    expect(drops).toEqual([]);
  });

  it("cancels the gesture and clears the ghost when the row unmounts", () => {
    render([{ id: "a", title: "First" }]);
    act(() => {
      row("a").dispatchEvent(pointer("pointerdown", 20));
      document.dispatchEvent(pointer("pointermove", 320));
    });
    expect(ghostText()).toBe("First");
    render([]);
    expect(ghostText()).toBeNull();
    act(() => {
      document.dispatchEvent(pointer("pointerup", 320, { buttons: 0 }));
    });
    expect(drops).toEqual([]);
  });
});
