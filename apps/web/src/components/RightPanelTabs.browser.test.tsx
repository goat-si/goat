import { EnvironmentId, ThreadId } from "@goat/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { focusPanelTerminalAfterClose, registerTerminalFocusTarget } from "~/lib/terminalFocus";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { RightPanelTabs } from "./RightPanelTabs";

function files(count: number): RightPanelSurface[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `file:${index}`,
    kind: "file",
    relativePath: index === 0 ? "a.ts" : `Long descriptive document ${index}.md`,
    revealLine: null,
    revealRequestId: 0,
  }));
}

function Fixture(props: {
  initial: RightPanelSurface[];
  width?: number;
  audio?: boolean;
  close?: (surface: RightPanelSurface, finish: () => void) => void;
}) {
  const [surfaces, setSurfaces] = useState(props.initial);
  const [active, setActive] = useState(props.initial[0]?.id ?? null);
  const noop = () => {};
  return (
    <div style={{ width: props.width ?? 640, height: 240 }}>
      <RightPanelTabs
        mode="embedded"
        open
        keybindings={[]}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
          editableFocus: false,
          modelPickerOpen: false,
        })}
        surfaces={surfaces}
        activeSurfaceId={active}
        environmentId={null}
        pendingSurfaceIds={new Set()}
        previewSessions={
          props.audio
            ? {
                audio: {
                  threadId: ThreadId.make("audio-test"),
                  tabId: "audio",
                  navStatus: { _tag: "Success", url: "about:blank", title: "Browser" },
                  canGoBack: false,
                  canGoForward: false,
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              }
            : {}
        }
        desktopByTabId={
          props.audio
            ? {
                audio: {
                  hasWebContents: true,
                  canGoBack: false,
                  canGoForward: false,
                  loading: false,
                  zoomFactor: 1,
                  pictureInPicture: false,
                  colorScheme: "light",
                  audioMuted: false,
                  audible: true,
                  controller: "human",
                  favicon: null,
                },
              }
            : {}
        }
        previewRuntimeTabId={(id) => id}
        terminalLabelsById={new Map()}
        onActivate={(surface) => setActive(surface.id)}
        onCloseSurface={(surface) => {
          const finish = () => {
            const index = surfaces.indexOf(surface);
            const next = surfaces.filter((entry) => entry.id !== surface.id);
            setSurfaces(next);
            if (active === surface.id) setActive((next[index] ?? next[index - 1])?.id ?? null);
          };
          if (props.close) props.close(surface, finish);
          else finish();
        }}
        onCloseOtherSurfaces={noop}
        onCloseSurfacesToRight={noop}
        onCloseAllSurfaces={noop}
        onCopyFilePath={noop}
        onAddBrowser={noop}
        onAddBrowserInProfile={noop}
        onAddTerminal={noop}
        onAddFiles={noop}
        onAddDiff={noop}
        onAddPullRequest={noop}
        onAddPullRequests={noop}
        onAddDevice={noop}
        browserAvailable={false}
        terminalAvailable={false}
        filesAvailable={false}
        diffAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
      >
        <button type="button">Outside the tab strip</button>
      </RightPanelTabs>
    </div>
  );
}

function tabs(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function viewport(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    '[data-right-panel-tab-list] [data-slot="scroll-area-viewport"]',
  )!;
}

it("shares capped widths independently of titles, shrinks equally, then scrolls at the minimum", async () => {
  const initial = files(2);
  await using screen = await render(<Fixture initial={initial} width={700} />);
  await vi.waitFor(() => {
    expect(tabs(screen.container).map((tab) => tab.getBoundingClientRect().width)).toEqual([
      192, 192,
    ]);
  });
  await screen.rerender(<Fixture initial={initial} width={340} />);
  await vi.waitFor(() => {
    const widths = tabs(screen.container).map((tab) => tab.getBoundingClientRect().width);
    expect(widths[0]).toBeCloseTo(widths[1]!, 1);
    expect(widths[0]).toBeGreaterThanOrEqual(96);
    expect(widths[0]).toBeLessThan(192);
  });
  await screen.rerender(<Fixture initial={initial} width={190} />);
  await vi.waitFor(() => {
    expect(tabs(screen.container).map((tab) => tab.getBoundingClientRect().width)).toEqual([
      96, 96,
    ]);
    expect(viewport(screen.container).scrollWidth).toBeGreaterThan(
      viewport(screen.container).clientWidth,
    );
  });
});

it("keeps the next close target under the pointer until the pointer leaves", async () => {
  await using screen = await render(<Fixture initial={files(4)} />);
  await vi.waitFor(() =>
    expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBeLessThan(192),
  );
  const before = tabs(screen.container)[1]!.getBoundingClientRect();
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 1.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 1.md" }),
  );
  await vi.waitFor(() => {
    const next = tabs(screen.container)[1]!.getBoundingClientRect();
    expect(next.width).toBeCloseTo(before.width, 1);
    expect(next.x).toBeCloseTo(before.x, 1);
  });
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 2.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 2.md" }),
  );
  expect(tabs(screen.container)[1]!.getBoundingClientRect().width).toBeCloseTo(before.width, 1);
  await userEvent.hover(screen.getByRole("button", { name: "Outside the tab strip" }));
  await vi.waitFor(() =>
    expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBe(192),
  );
});

it("reserves readable title space beside audio and an active close at minimum width", async () => {
  await using screen = await render(
    <Fixture
      initial={[{ id: "browser:audio", kind: "preview", resourceId: "audio" }, ...files(4)]}
      width={440}
      audio
    />,
  );
  await vi.waitFor(() => expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBe(96));
  const tab = tabs(screen.container)[0]!;
  const close = screen.getByRole("button", { name: "Close Browser" });
  await expect.element(close).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mute Browser" })).toBeVisible();
  const label = [...tab.querySelectorAll("span")].find((span) => span.textContent === "Browser")!;
  expect(label.getBoundingClientRect().width).toBeGreaterThanOrEqual(20);
  expect(tab.scrollWidth).toBeLessThanOrEqual(tab.clientWidth);
});

it("preserves the scrolled span on middle and rightmost close and releases it on keyboard navigation", async () => {
  await using screen = await render(<Fixture initial={files(8)} width={460} />);
  const scroller = viewport(screen.container);
  await act(() => {
    scroller.scrollLeft = scroller.scrollWidth;
  });
  const before = scroller.scrollLeft;
  const width = tabs(screen.container)[7]!.getBoundingClientRect().width;
  await userEvent.click(screen.getByRole("tab", { name: "Long descriptive document 6.md" }), {
    button: "middle",
  });
  await vi.waitFor(() => {
    expect(tabs(screen.container)).toHaveLength(7);
    expect(scroller.scrollLeft).toBeCloseTo(before, 0);
    expect(tabs(screen.container)[6]!.getBoundingClientRect().width).toBeCloseTo(width, 1);
  });
  await userEvent.click(screen.getByRole("tab", { name: "Long descriptive document 7.md" }), {
    button: "middle",
  });
  await vi.waitFor(() => expect(scroller.scrollLeft).toBeCloseTo(before, 0));
  tabs(screen.container)[0]!.focus();
  await userEvent.keyboard("{End}");
  await expect
    .element(screen.getByRole("tab", { name: "Long descriptive document 5.md" }))
    .toHaveFocus();
  await vi.waitFor(() => {
    const focused = document.activeElement!.getBoundingClientRect();
    const visible = scroller.getBoundingClientRect();
    expect(focused.left).toBeGreaterThanOrEqual(visible.left);
    expect(focused.right).toBeLessThanOrEqual(visible.right);
  });
  expect(scroller.scrollWidth).toBeLessThan(8 * (width + 4));
});

it("retains an existing close layout while the next close waits for confirmation", async () => {
  let complete: (() => void) | undefined;
  let requests = 0;
  await using screen = await render(
    <Fixture
      initial={files(4)}
      close={(_surface, finish) => {
        requests++;
        if (requests === 1) finish();
        else complete = finish;
      }}
    />,
  );
  const width = tabs(screen.container)[0]!.getBoundingClientRect().width;
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 1.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 1.md" }),
  );
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 2.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 2.md" }),
  );
  expect(tabs(screen.container)).toHaveLength(3);
  expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBeCloseTo(width, 1);
  await act(() => complete?.());
  await vi.waitFor(() => expect(tabs(screen.container)).toHaveLength(2));
  expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBeCloseTo(width, 1);
});

it("waits for a delayed removal and leaves no visible freeze after a cancelled close", async () => {
  let finish: (() => void) | undefined;
  const close = (_surface: RightPanelSurface, complete: () => void) => {
    finish = complete;
  };
  const initial = files(4);
  await using screen = await render(<Fixture initial={initial} close={close} />);
  const before = tabs(screen.container)[1]!.getBoundingClientRect().width;
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 1.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 1.md" }),
  );
  expect(tabs(screen.container)).toHaveLength(4);
  await act(() => finish?.());
  await vi.waitFor(() => {
    expect(tabs(screen.container)).toHaveLength(3);
    expect(tabs(screen.container)[1]!.getBoundingClientRect().width).toBeCloseTo(before, 1);
  });
  await userEvent.hover(screen.getByRole("button", { name: "Outside the tab strip" }));
  await userEvent.hover(screen.getByRole("tab", { name: "Long descriptive document 2.md" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Close Long descriptive document 2.md" }),
  );
  await screen.rerender(<Fixture initial={initial} close={close} width={340} />);
  await vi.waitFor(() =>
    expect(tabs(screen.container)[0]!.getBoundingClientRect().width).toBeLessThan(before),
  );
});

it("moves focus without activating, ignores modified or composing keys, and retains tab focus over terminal fallback", async () => {
  const ref = {
    environmentId: EnvironmentId.make("tab-test"),
    threadId: ThreadId.make("keyboard"),
  };
  const terminal: RightPanelSurface = {
    id: "terminal:test",
    kind: "terminal",
    resourceId: "test",
    terminalIds: ["test"],
    activeTerminalId: "test",
  };
  const initial = [files(1)[0]!, terminal];
  await using screen = await render(
    <Fixture
      initial={initial}
      close={(_surface, finish) => {
        useRightPanelStore.setState({
          byThreadKey: {
            "tab-test:keyboard": {
              isOpen: true,
              activeSurfaceId: terminal.id,
              surfaces: [terminal],
            },
          },
        });
        focusPanelTerminalAfterClose(ref, initial[0]!.id);
        finish();
      }}
    />,
  );
  const first = tabs(screen.container)[0]!;
  first.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(tabs(screen.container)[1]).toBe(document.activeElement);
  expect(first.getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{Home}");
  first.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Delete", ctrlKey: true, bubbles: true }),
  );
  first.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(tabs(screen.container)).toHaveLength(2);
  await userEvent.keyboard("{Delete}");
  await vi.waitFor(() => expect(tabs(screen.container)).toHaveLength(1));
  const focus = vi.fn(() => {
    screen.container.querySelector<HTMLButtonElement>("button")?.focus();
    return true;
  });
  const unregister = registerTerminalFocusTarget({ threadRef: ref, terminalId: "test", focus });
  try {
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tabs(screen.container)[0]);
  } finally {
    unregister();
  }
});
