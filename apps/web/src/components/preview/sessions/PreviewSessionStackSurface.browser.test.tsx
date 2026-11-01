import type {
  DesktopPreviewSessionStackBridge,
  DesktopPreviewSessionStackState,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useState } from "react";

import { act, render } from "../../../../test/render";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PreviewSessionStackSurface } from "./PreviewSessionStackSurface";

function setup(poppedOut = false) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow;
  if (!child) throw new Error("Missing test frame");
  let state: DesktopPreviewSessionStackState = {
    poppedOut,
    open: false,
    visible: false,
    maxHeight: 900,
    captureProtection: "unsupported",
    mouseEventForwarding: false,
  };
  const listeners = new Set<(state: DesktopPreviewSessionStackState) => void>();
  const emit = (patch: Partial<DesktopPreviewSessionStackState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const request = vi.fn<DesktopPreviewSessionStackBridge["request"]>(async (input) => {
    if (input.type === "layout") emit({ poppedOut: true, open: true, visible: input.height > 0 });
    if (input.type === "dock") emit({ poppedOut: false, open: false, visible: false });
    if (input.type === "release") emit({ open: false, visible: false });
    return state;
  });
  const original = window.desktopBridge;
  window.desktopBridge = {
    ...original,
    previewSessionStack: {
      request,
      onState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as NonNullable<typeof window.desktopBridge>;
  return {
    child,
    request,
    emit,
    [Symbol.dispose]() {
      if (original) window.desktopBridge = original;
      else delete window.desktopBridge;
      frame.remove();
    },
  };
}

function Stack(props: {
  readonly hidden?: boolean;
  readonly content?: boolean;
  readonly tooltip?: boolean;
}) {
  return (
    <PreviewSessionStackSurface
      hasContent={props.content ?? true}
      dockedHidden={props.hidden ?? false}
    >
      {({ floating, live, toggle, captureNotice }) => (
        <section data-stack-interactive aria-label="Session stack">
          <p>{floating ? "Floating sessions" : "Docked sessions"}</p>
          <p>{live ? "Live thumbnails" : "Thumbnails paused"}</p>
          {toggle}
          {captureNotice}
          {props.tooltip ? (
            <Tooltip open>
              <TooltipTrigger render={<span />}>Card name</TooltipTrigger>
              <TooltipPopup>Card name tooltip</TooltipPopup>
            </Tooltip>
          ) : null}
        </section>
      )}
    </PreviewSessionStackSurface>
  );
}

it("moves the stack to a child, pauses when hidden, and docks when the native window closes", async () => {
  using fixture = setup();
  using _open = vi.spyOn(window, "open").mockReturnValue(fixture.child);
  await using screen = await render(<Stack />);
  await userEvent.click(screen.getByRole("button", { name: "Pop out" }));
  await vi.waitFor(() => {
    expect(fixture.child.document.body.textContent).toContain("Floating sessions");
    expect(fixture.child.document.body.textContent).toContain("Live thumbnails");
    expect(fixture.child.document.body.textContent).toContain("cannot exclude");
  });
  expect(screen.container.textContent).not.toContain("Docked sessions");
  await act(() => fixture.emit({ visible: false }));
  await vi.waitFor(() =>
    expect(fixture.child.document.body.textContent).toContain("Thumbnails paused"),
  );
  // A native close sends the same state as Dock; no second copy remains in the app.
  await act(() => fixture.emit({ poppedOut: false, open: false, visible: false }));
  await expect.element(screen.getByText("Docked sessions")).toBeVisible();
  expect(fixture.child.document.body.textContent).not.toContain("Floating sessions");
});

it("restores only the persisted popout and keeps it available while the right panel is open", async () => {
  using fixture = setup(true);
  using open = vi.spyOn(window, "open").mockReturnValue(fixture.child);
  await using screen = await render(<Stack hidden />);
  await vi.waitFor(() =>
    expect(fixture.child.document.body.textContent).toContain("Floating sessions"),
  );
  expect(open).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Dock", exact: true }));
  await vi.waitFor(() =>
    expect(fixture.child.document.body.textContent).not.toContain("Floating sessions"),
  );
  // Docked stack steps aside for the full preview, then returns when that panel closes.
  await screen.rerender(<Stack hidden={false} />);
  await expect.element(screen.getByRole("button", { name: "Pop out" })).toBeVisible();
  await screen.rerender(<Stack content={false} />);
  await expect
    .element(screen.getByRole("region", { name: "Session stack" }))
    .not.toBeInTheDocument();
});

/** A card's own state, as a stopped card's last frame is (#1518). */
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Clicked {count}
    </button>
  );
}

// #1518: Pop out and Dock mounted the stack anew, so every card lost its own state, including
// the last frame a stopped desktop session no longer sends.
it("keeps each card's state through Pop out and Dock, and a click counts once in either place", async () => {
  using fixture = setup();
  using _open = vi.spyOn(window, "open").mockReturnValue(fixture.child);
  await using screen = await render(
    <PreviewSessionStackSurface hasContent dockedHidden={false}>
      {({ toggle }) => (
        <section data-stack-interactive aria-label="Session stack">
          <Counter />
          {toggle}
        </section>
      )}
    </PreviewSessionStackSurface>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Clicked 0" }));
  await expect.element(screen.getByRole("button", { name: "Clicked 1" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Pop out" }));
  await vi.waitFor(() => expect(fixture.child.document.body.textContent).toContain("Clicked 1"));
  const floating = () =>
    [...fixture.child.document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Clicked"),
    );
  await act(() => floating()?.click());
  await vi.waitFor(() => expect(floating()?.textContent).toBe("Clicked 2"));
  await act(() => fixture.emit({ poppedOut: false, open: false, visible: false }));
  await expect.element(screen.getByRole("button", { name: "Clicked 2" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Clicked 2" }));
  await expect.element(screen.getByRole("button", { name: "Clicked 3" })).toBeVisible();
});

it("keeps web sessions docked when no Electron bridge exists", async () => {
  using _fixture = setup();
  delete window.desktopBridge;
  await using screen = await render(<Stack />);
  await expect.element(screen.getByText("Docked sessions")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Pop out" })).not.toBeInTheDocument();
});

it("shows a floating card's tooltip in the floating window, not in GOAT's main window (#1534)", async () => {
  using fixture = setup();
  using _open = vi.spyOn(window, "open").mockReturnValue(fixture.child);
  await using screen = await render(<Stack tooltip />);
  await userEvent.click(screen.getByRole("button", { name: "Pop out" }));
  await vi.waitFor(() =>
    expect(fixture.child.document.body.textContent).toContain("Card name tooltip"),
  );
  expect(document.body.textContent).not.toContain("Card name tooltip");
  // Docking returns the tooltip to the main window with the stack.
  await userEvent.click(screen.getByRole("button", { name: "Dock", exact: true }));
  await expect.element(screen.getByText("Card name tooltip")).toBeInTheDocument();
  expect(fixture.child.document.body.textContent).not.toContain("Card name tooltip");
});
