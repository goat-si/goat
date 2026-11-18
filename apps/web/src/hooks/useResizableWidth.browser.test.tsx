import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "./useResizableWidth";

const STORAGE_KEY = "test:responsive-panel-width";

function Panel({ defaultWidth }: { defaultWidth: number }) {
  const { handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 160,
    maxWidth: 560,
    edge: "left",
  });
  return <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />;
}

/** Sized from the hook's width like a real host, but never wider than `cap`. */
function CappedPanel({ cap }: { cap: number }) {
  const { width, handlers } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth: 240,
    minWidth: 160,
    maxWidth: 900,
    edge: "left",
  });
  return (
    <div
      style={
        {
          [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
          width: `min(var(${RESIZABLE_WIDTH_PROPERTY}), ${cap}px)`,
          // Hosts animate their width; the saved width must not be read mid-animation.
          transition: "width 10s linear",
        } as CSSProperties
      }
    >
      <div role="separator" style={{ width: 8, height: 40 }} {...handlers} />
    </div>
  );
}

function storedWidth(value: string | null): Disposable {
  const previous = localStorage.getItem(STORAGE_KEY);
  if (value === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, value);
  return {
    [Symbol.dispose]: () => {
      if (previous === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, previous);
    },
  };
}

/** Lifts src/test/browserNoMotion.ts for one test, so the host's width transition runs. */
function withMotion(): Disposable {
  const style = document.querySelector<HTMLStyleElement>("style[data-test-no-motion]");
  if (style) style.disabled = true;
  return {
    [Symbol.dispose]: () => {
      if (style) style.disabled = false;
    },
  };
}

function dragHandle(
  container: HTMLElement,
): Disposable & { drag: (from: number, to: number) => Promise<void> } {
  const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
  // Synthetic drag events have no active browser pointer to capture.
  const capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
  const pointer = { bubbles: true, pointerId: 1, button: 0 };
  return {
    drag: (from, to) =>
      act(() => {
        handle.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: from }));
        handle.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: to }));
      }),
    [Symbol.dispose]: () => capture.mockRestore(),
  };
}

describe("useResizableWidth", () => {
  it("keeps the stored width after a stationary click and persists an actual drag", async () => {
    using _stored = storedWidth(null);
    // This hook only needs browser storage and React; no navigation is involved.
    await using screen = await render(<Panel defaultWidth={240} />, { router: false });
    await screen.getByRole("separator").click();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    using handle = dragHandle(screen.container);
    await handle.drag(500, 500);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.container.style.getPropertyValue(RESIZABLE_WIDTH_PROPERTY)).toBe("240px");

    await handle.drag(500, 450);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("290");
  });

  it("a drag on a pane its container caps starts from the width on screen", async () => {
    using _stored = storedWidth("600");
    // This hook only needs browser storage and React; no navigation is involved.
    await using screen = await render(<CappedPanel cap={300} />, { router: false });
    using handle = dragHandle(screen.container);
    await handle.drag(500, 550);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("250");
  });

  it("a drag that runs into the container's cap saves the width on screen", async () => {
    using _stored = storedWidth("240");
    using _motion = withMotion();
    // This hook only needs browser storage and React; no navigation is involved.
    await using screen = await render(<CappedPanel cap={300} />, { router: false });
    using handle = dragHandle(screen.container);
    await handle.drag(500, 400);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("300");
  });
});
