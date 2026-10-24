import "~/index.css";

import {
  type EnvironmentId,
  type PreviewSession,
  type PreviewSessionControl,
  ThreadId,
} from "@goat/contracts";
import type { Ref } from "react";
import { expect, it, vi } from "vite-plus/test";
import { commands, type Locator, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  sessions: [] as ReadonlyArray<PreviewSession>,
  control: vi.fn(),
  surfaceControl: null as null | ((control: { readonly private?: boolean } | null) => void),
}));

vi.mock("../../../state/previewSessions", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    usePreviewSessions: () => state.sessions,
    previewSessionsEnvironment: { control: { permissionAtom: () => allowed } },
  };
});
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => state.control }));
vi.mock("../../../browserFaviconStore", () => ({ useFaviconForThreadUrl: () => null }));
// The stream needs a server; the stub paints a canvas and hands the test the stream's control.
vi.mock("../../../browser/ServerBrowserSurface", async () => {
  const { useEffect, useImperativeHandle, useRef } = await import("react");
  return {
    ServerBrowserSurface: (props: {
      readonly ref?: Ref<{ canvas: () => HTMLCanvasElement | null }>;
      readonly onControl?: (control: { readonly private?: boolean } | null) => void;
    }) => {
      const canvas = useRef<HTMLCanvasElement>(null);
      useImperativeHandle(props.ref, () => ({ canvas: () => canvas.current }));
      useEffect(() => {
        state.surfaceControl = props.onControl ?? null;
        const context = canvas.current?.getContext("2d");
        if (context) {
          context.fillStyle = "red";
          context.fillRect(0, 0, 4, 4);
        }
      }, [props.onControl]);
      return <canvas ref={canvas} width={4} height={4} data-testid="session-frame" />;
    },
  };
});

import { AgentScreenCardView } from "./AgentScreenCard";
import { AgentScreenCardsToggle } from "./AgentScreenCardsToggle";
import { PreviewSessionStack } from "./PreviewSessionStack";
import { usePreviewSessionStack } from "./previewSessionStackStore";

const environmentId = "env-cards" as EnvironmentId;
const HIDDEN_KEY = "goat:agent-screen-cards:hidden";

// Hidden controls stay in the tab order, so they are faded out rather than removed or invisible.
const shownControl = (locator: Locator) => expect.element(locator).toHaveStyle({ opacity: "1" });
const fadedControl = (locator: Locator) => expect.element(locator).toHaveStyle({ opacity: "0" });

function session(
  patch: Partial<PreviewSession> & Pick<PreviewSession, "id" | "kind" | "target">,
): PreviewSession {
  return {
    environmentId,
    host: "mac",
    platform: "mac",
    owner: "agent",
    status: "acting",
    capabilities: {
      controls: ["takeover", "stop", "stopAll"],
      frames: false,
      privateMode: true,
      humanInput: true,
    },
    ...patch,
  };
}

const browserTab = (patch: Partial<PreviewSession> = {}) =>
  session({
    id: "browser-1",
    kind: "browser",
    threadId: ThreadId.make("thread-1"),
    target: { kind: "browser", tabId: "tab-1", url: "http://localhost:8036/", title: "GOAT (Dev)" },
    capabilities: {
      controls: ["takeover", "stop"],
      frames: true,
      privateMode: true,
      humanInput: true,
    },
    ...patch,
  });

const desktopApp = (patch: Partial<PreviewSession> = {}) =>
  session({
    id: "desktop-1",
    kind: "desktop",
    target: { kind: "desktop", bundleId: "com.apple.TextEdit", title: "TextEdit" },
    ...patch,
  });

function setup(sessions: ReadonlyArray<PreviewSession>) {
  state.sessions = sessions;
  state.control.mockReset();
  state.surfaceControl = null;
  window.sessionStorage.removeItem(HIDDEN_KEY);
  usePreviewSessionStack.setState({
    hidden: false,
    narrow: false,
    revealedWhileNarrow: false,
    dismissed: new Set(),
    focus: null,
    focusRequest: 0,
  });
}

/** A thread header of the given width, which is what the cards measure the pane by. */
function paneOf(width: number) {
  const header = document.createElement("header");
  header.dataset.chatHeader = "";
  header.style.cssText = `position:fixed;top:0;left:0;height:48px;width:${width}px`;
  document.body.append(header);
  return {
    resize: (next: number) => act(() => void (header.style.width = `${next}px`)),
    [Symbol.dispose]: () => header.remove(),
  };
}

function Cards() {
  return (
    <>
      <AgentScreenCardsToggle environmentId={environmentId} threadRef={null} />
      <PreviewSessionStack environmentId={environmentId} threadRef={null} />
    </>
  );
}

function cardView(target: PreviewSession, handlers: Partial<{ expand: () => void }> = {}) {
  const onControl = vi.fn<(control: PreviewSessionControl) => void>();
  const onDismiss = vi.fn();
  return {
    onControl,
    onDismiss,
    element: (
      <AgentScreenCardView
        session={target}
        threadTitle="Try computer use"
        live
        canControl
        focused={false}
        focusRequest={0}
        onExpand={handlers.expand ?? null}
        onControl={onControl}
        onDismiss={onDismiss}
      />
    ),
  };
}

it("gives browser tabs and desktop apps the same card, with no session counter", async () => {
  setup([browserTab(), desktopApp()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const browser = screen.getByRole("article", { name: "GOAT (Dev): Agent controlling" });
  const desktop = screen.getByRole("article", { name: "TextEdit: Agent controlling" });
  await expect.element(browser).toBeVisible();
  await expect.element(desktop).toBeVisible();
  // One line of header (the name and a status dot), then the picture; no badge or subtitle text.
  for (const card of [browser, desktop])
    await expect.element(card.getByRole("img", { name: "Agent controlling" })).toBeInTheDocument();
  await expect.element(desktop.getByText("No preview")).toBeVisible();
  expect(browser.element().getBoundingClientRect().width).toBe(
    desktop.element().getBoundingClientRect().width,
  );
  expect(screen.container.textContent).not.toMatch(/Agents on screen|helper|Agent controlling/);
});

it("hides the cards in a pane too narrow for them, and the header toggle shows them anyway", async () => {
  setup([desktopApp()]);
  await page.viewport(1400, 900);
  using pane = paneOf(900);
  await using screen = await render(<Cards />);
  const toggle = screen.getByRole("button", { name: "Agents on screen" });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByRole("article", { name: "TextEdit: Agent controlling" }))
    .toBeVisible();
  // Hiding them again in the narrow pane keeps the window's choice for a wide one.
  await userEvent.click(toggle);
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  await pane.resize(1400);
  await expect.element(screen.getByRole("article")).toBeVisible();
  expect(window.sessionStorage.getItem(HIDDEN_KEY)).toBeNull();
});

it("remembers hidden cards for the window across a reload", async () => {
  setup([desktopApp()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect.element(screen.getByRole("article")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Agents on screen" }));
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  vi.resetModules();
  const reloaded = await import("./previewSessionStackStore");
  expect(reloaded.usePreviewSessionStack.getState().hidden).toBe(true);
});

it("shows the corner controls on hover and on keyboard focus, and Stop stops the session", async () => {
  setup([]);
  const card = cardView(desktopApp());
  await using screen = await render(card.element);
  const stop = screen.getByRole("button", { name: "Stop" });
  const takeOver = screen.getByRole("button", { name: "Take over" });
  await fadedControl(stop);
  await userEvent.hover(screen.getByRole("article"));
  await shownControl(stop);
  await shownControl(takeOver);
  // Off the page: the card sits at its top-left corner, where unhover parks the mouse.
  await commands.resetPointer();
  await fadedControl(stop);
  await userEvent.tab();
  await expect.element(stop).toHaveFocus();
  await shownControl(stop);
  await userEvent.keyboard("{Enter}");
  expect(card.onControl).toHaveBeenCalledWith("stop");
});

it("reveals the controls with a first tap on touch screens instead of opening the preview", async () => {
  setup([]);
  const expand = vi.fn();
  const card = cardView(browserTab(), { expand });
  await using screen = await render(card.element);
  const picture = screen.getByRole("button", { name: "Open GOAT (Dev)" }).element();
  const tap = (target: Element) => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    (target as HTMLElement).click();
  };
  await fadedControl(screen.getByRole("button", { name: "Stop" }));
  await act(() => tap(picture));
  await shownControl(screen.getByRole("button", { name: "Stop" }));
  expect(expand).not.toHaveBeenCalled();
  // The next tap acts, and a tap elsewhere puts the controls away.
  await act(() => tap(picture));
  expect(expand).toHaveBeenCalledOnce();
  await act(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
    ),
  );
  await fadedControl(screen.getByRole("button", { name: "Stop" }));
});

it("hides and wipes the picture as soon as the stream reports private mode", async () => {
  setup([]);
  await using screen = await render(cardView(browserTab()).element);
  const frame = screen.getByTestId("session-frame");
  await expect.element(frame).toBeVisible();
  await vi.waitFor(() => expect(state.surfaceControl).not.toBeNull());
  // The session list still says the agent owns the tab; only the stream knows yet.
  await act(() => state.surfaceControl?.({ private: true }));
  await expect.element(frame).not.toBeVisible();
  await expect.element(screen.getByText("Private")).toBeVisible();
  const canvas = frame.element() as HTMLCanvasElement;
  expect(Array.from(canvas.getContext("2d")?.getImageData(0, 0, 4, 4).data ?? [1])).toEqual(
    new Array(64).fill(0),
  );
  await act(() => state.surfaceControl?.({ private: false }));
  await expect.element(frame).toBeVisible();
});

it("never mounts a picture for a session the list already marks private", async () => {
  setup([]);
  await using screen = await render(cardView(browserTab({ owner: "private" })).element);
  await expect.element(screen.getByText("Private")).toBeVisible();
  await expect.element(screen.getByTestId("session-frame")).not.toBeInTheDocument();
});

it("keeps a stopped session's dimmed card until the person closes it", async () => {
  setup([
    desktopApp({
      status: "stopped",
      capabilities: { controls: ["stopAll"], frames: false, privateMode: true, humanInput: true },
    }),
  ]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const card = screen.getByRole("article", { name: "TextEdit: Stopped" });
  await expect.element(card).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Close" }));
  await expect.element(card).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Agents on screen" }))
    .not.toBeInTheDocument();
});
