import "~/index.css";

import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type PreviewSession,
  type PreviewSessionControl,
  type PreviewSessionFrameEvent,
  ThreadId,
} from "@goat/contracts";
import type { Ref } from "react";
import { expect, it, vi } from "vite-plus/test";
import { commands, type Locator, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";
import { toastManager } from "../../ui/toast";

const state = vi.hoisted(() => ({
  environmentId: "env-cards",
  sessions: [] as ReadonlyArray<PreviewSession>,
  control: vi.fn(),
  canControl: true,
  scopes: new Set<string>(),
  frame: null as PreviewSessionFrameEvent | null,
  frameListeners: new Set<() => void>(),
  frameRequests: [] as Array<string | null>,
  surfaceControl: null as
    | null
    | ((
        control: {
          readonly private?: boolean;
          readonly controller: string;
          readonly canOperate: boolean;
        } | null,
      ) => void),
  surfaceCalls: [] as Array<string>,
  routeThread: null as string | null,
}));

vi.mock("../../../state/previewSessions", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useSyncExternalStore } = await import("react");
  return {
    usePreviewSessions: () => state.sessions,
    // A subscription, like the real frames atom: a new event re-renders its reader.
    useDesktopSessionFrame: (_environmentId: string, sessionId: string | null) => {
      state.frameRequests.push(sessionId);
      const event = useSyncExternalStore(
        (listener) => {
          state.frameListeners.add(listener);
          return () => state.frameListeners.delete(listener);
        },
        () => state.frame,
      );
      return { event: sessionId === null ? null : event, failed: false };
    },
    previewSessionsEnvironment: {
      control: { permissionAtom: () => Atom.make(state.canControl) },
    },
  };
});
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => state.control }));
vi.mock("../../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) => state.scopes.has(scope),
}));
vi.mock("../../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.environmentId,
}));
vi.mock("../../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : { title: `Thread ${ref.threadId}` },
}));
vi.mock("../../../browserFaviconStore", () => ({ useFaviconForThreadUrl: () => null }));
vi.mock("../../../hooks/useThreadRouteTarget", () => ({
  useThreadRouteTarget: () =>
    state.routeThread === null
      ? null
      : {
          kind: "server",
          threadRef: { environmentId: state.environmentId, threadId: state.routeThread },
        },
}));
// The stream needs a server; this stub stands in at the card's level (the real surface is
// exercised in AgentScreenCard.surface.browser.test.tsx).
vi.mock("../../../browser/ServerBrowserSurface", async () => {
  const { useEffect, useImperativeHandle } = await import("react");
  return {
    ServerBrowserSurface: (props: {
      readonly ref?: Ref<unknown>;
      readonly onControl?: typeof state.surfaceControl;
    }) => {
      useImperativeHandle(props.ref, () => ({
        canvas: () => null,
        takeControl: () => state.surfaceCalls.push("takeControl"),
        releaseControl: () => state.surfaceCalls.push("releaseControl"),
      }));
      useEffect(() => {
        state.surfaceControl = props.onControl ?? null;
      }, [props.onControl]);
      return <canvas width={4} height={4} data-testid="session-frame" />;
    },
  };
});

import { AgentScreenCardView } from "./AgentScreenCard";
import { AgentScreenCardsToggle } from "./AgentScreenCardsToggle";
import { PreviewSessionStack } from "./PreviewSessionStack";
import { usePreviewSessionStack } from "./previewSessionStackStore";
import { usePreviewMiniPlayerStore } from "../../../previewMiniPlayerStore";

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
    threadId: ThreadId.make("thread-desk"),
    target: { kind: "desktop", bundleId: "com.apple.TextEdit", title: "Whole screen" },
    ...patch,
  });

const sendFrame = (event: PreviewSessionFrameEvent | null) =>
  act(() => {
    state.frame = event;
    for (const listener of state.frameListeners) listener();
  });

function setup(sessions: ReadonlyArray<PreviewSession>) {
  state.sessions = sessions;
  state.control.mockReset();
  state.control.mockResolvedValue({ _tag: "Success", value: { applied: true } });
  state.canControl = true;
  state.scopes = new Set([AuthPreviewOperateScope]);
  state.frame = null;
  state.frameRequests = [];
  state.surfaceControl = null;
  state.surfaceCalls = [];
  state.routeThread = null;
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  window.sessionStorage.removeItem(HIDDEN_KEY);
  usePreviewSessionStack.setState({
    hidden: false,
    narrow: false,
    revealedWhileNarrow: false,
    dismissed: new Set(),
    expanded: null,
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
      <AgentScreenCardsToggle />
      <PreviewSessionStack
        environmentId={environmentId}
        threadRef={
          state.routeThread === null
            ? null
            : { environmentId, threadId: ThreadId.make(state.routeThread) }
        }
      />
    </>
  );
}

function cardView(
  target: PreviewSession,
  options: Partial<{
    expand: (options?: { readonly takeOver?: boolean }) => void;
    size: "card" | "large";
    canControl: boolean;
    canOperateBrowser: boolean;
  }> = {},
) {
  const onControl = vi.fn<(control: PreviewSessionControl) => void>();
  const onDismiss = vi.fn();
  const onCollapse = vi.fn();
  return {
    onControl,
    onDismiss,
    onCollapse,
    element: (
      <AgentScreenCardView
        session={target}
        size={options.size ?? "card"}
        threadTitle="Try computer use"
        live
        canControl={options.canControl ?? true}
        canOperateBrowser={options.canOperateBrowser ?? true}
        focused={false}
        focusRequest={0}
        onExpand={options.expand ?? (() => undefined)}
        onCollapse={onCollapse}
        onControl={onControl}
        onDismiss={onDismiss}
      />
    ),
  };
}

const pictureRatio = (card: Locator) => {
  const picture = card.element().querySelector(".aspect-\\[16\\/10\\]");
  const box = picture?.getBoundingClientRect();
  return box ? box.width / box.height : 0;
};

it("gives browser tabs and desktop threads the same card, with no session counter", async () => {
  setup([browserTab(), desktopApp()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const browser = screen.getByRole("article", { name: "GOAT (Dev): Agent controlling" });
  // A desktop card is named by the thread driving it, never one merged "Whole screen".
  const desktop = screen.getByRole("article", { name: "Thread thread-desk: Agent controlling" });
  await expect.element(browser).toBeVisible();
  await expect.element(desktop).toBeVisible();
  for (const card of [browser, desktop])
    await expect.element(card.getByRole("img", { name: "Agent controlling" })).toBeInTheDocument();
  await expect.element(desktop.getByText("No preview")).toBeVisible();
  expect(browser.element().getBoundingClientRect().width).toBe(
    desktop.element().getBoundingClientRect().width,
  );
  expect(pictureRatio(browser)).toBeCloseTo(1.6, 1);
  expect(screen.container.textContent).not.toMatch(/Agents on screen|helper|Agent controlling/);
});

it("shows one card per thread, and a stopped control gives way to the thread's newer session", async () => {
  const thread = ThreadId.make("thread-desk");
  setup([
    desktopApp({ id: "desktop-old", status: "stopped", threadId: thread }),
    desktopApp({ id: "desktop-blocked", status: "permission-needed", threadId: thread }),
    desktopApp({ id: "desktop-other", threadId: ThreadId.make("thread-two") }),
  ]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-desk: Permission needed" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-two: Agent controlling" }))
    .toBeVisible();
  expect(screen.container.querySelectorAll("article")).toHaveLength(2);
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
  await expect.element(screen.getByRole("article")).toBeVisible();
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

it("stops every agent from the header with the cards hidden, and says when a stop did not apply", async () => {
  setup([desktopApp(), browserTab()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(900);
  await using screen = await render(<Cards />);
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  state.control.mockResolvedValue({
    _tag: "Success",
    value: { applied: false, reason: "not_allowed" },
  });
  using toast = vi.spyOn(toastManager, "add");
  await userEvent.click(screen.getByRole("button", { name: "Stop all agents on screen" }));
  expect(state.control).toHaveBeenCalledWith({
    environmentId,
    input: { control: "stopAll" },
  });
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Some agents could not be stopped" }),
    ),
  );
});

it("keeps the header's Stop all while the only agent tab plays in the thread's mini player", async () => {
  setup([browserTab()]);
  state.routeThread = "thread-1";
  usePreviewMiniPlayerStore
    .getState()
    .open(
      { environmentId, threadId: ThreadId.make("thread-1") },
      { kind: "browser", tabId: "tab-1" },
    );
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect
    .element(screen.getByRole("button", { name: "Stop all agents on screen" }))
    .toBeVisible();
  // The mini player already shows the tab, so it gets no card and no list button.
  await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Agents on screen" }))
    .not.toBeInTheDocument();
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
  // Focus on the picture already brings the controls up, then Tab reaches them.
  await userEvent.tab();
  await shownControl(stop);
  await userEvent.tab();
  await expect.element(stop).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(card.onControl).toHaveBeenCalledWith("stop");
});

it("disables controls a connection may not use", async () => {
  setup([]);
  await using screen = await render(
    cardView(browserTab(), { canControl: false, canOperateBrowser: false }).element,
  );
  await expect.element(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Take over" })).toBeDisabled();
  await screen.rerender(
    cardView(browserTab(), { canControl: false, canOperateBrowser: true }).element,
  );
  // Taking over a browser tab is the preview grant; stopping is the session controls grant.
  await expect.element(screen.getByRole("button", { name: "Take over" })).toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
});

it("reveals the controls with a first tap on touch screens instead of enlarging", async () => {
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

it("reveals the large view's controls with a tap on touch screens", async () => {
  setup([]);
  await using screen = await render(cardView(browserTab(), { size: "large" }).element);
  const shrink = screen.getByRole("button", { name: "Shrink to a card" });
  await fadedControl(shrink);
  const picture = screen.getByTestId("session-frame").element();
  await act(() =>
    picture.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })),
  );
  await shownControl(shrink);
});

it("enlarges in place, keeps the picture 16:10 as the pane resizes, and shrinks back", async () => {
  setup([browserTab()]);
  await page.viewport(1400, 900);
  using pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const card = screen.getByRole("article", { name: "GOAT (Dev): Agent controlling" });
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Enlarge" }));
  await expect.element(card).toHaveAttribute("data-size", "large");
  const wide = card.element().getBoundingClientRect().width;
  expect(wide).toBeGreaterThan(240);
  expect(pictureRatio(card)).toBeCloseTo(1.6, 1);
  await pane.resize(1300);
  await vi.waitFor(() => expect(card.element().getBoundingClientRect().width).toBeLessThan(wide));
  expect(pictureRatio(card)).toBeCloseTo(1.6, 1);
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Shrink to a card" }));
  await expect.element(card).toHaveAttribute("data-size", "card");
  expect(card.element().getBoundingClientRect().width).toBe(240);
});

it("takes over a browser tab from its card: enlarges, then asks the stream for control", async () => {
  setup([browserTab()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const card = screen.getByRole("article", { name: "GOAT (Dev): Agent controlling" });
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Take over" }));
  await expect.element(card).toHaveAttribute("data-size", "large");
  await vi.waitFor(() => expect(state.surfaceControl).not.toBeNull());
  await act(() => state.surfaceControl?.({ controller: "agent", canOperate: true }));
  expect(state.surfaceCalls).toEqual(["takeControl"]);
  await act(() => state.surfaceControl?.({ controller: "you", canOperate: true }));
  // Shrinking while in control hands it back first; the card is a passive view.
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Shrink to a card" }));
  expect(state.surfaceCalls).toEqual(["takeControl", "releaseControl"]);
});

it("says so when someone else holds the tab a takeover asked for", async () => {
  setup([]);
  await using screen = await render(cardView(browserTab(), { size: "large" }).element);
  await vi.waitFor(() => expect(state.surfaceControl).not.toBeNull());
  await act(() => state.surfaceControl?.({ controller: "agent", canOperate: true }));
  await userEvent.hover(screen.getByRole("article"));
  using toast = vi.spyOn(toastManager, "add");
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  expect(state.surfaceCalls).toEqual(["takeControl"]);
  await act(() => state.surfaceControl?.({ controller: "another-viewer", canOperate: true }));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Someone else controls this tab" }),
  );
});

it("hides the picture as soon as the stream reports private mode, even across a reconnect", async () => {
  setup([]);
  await using screen = await render(cardView(browserTab()).element);
  const frame = screen.getByTestId("session-frame");
  await expect.element(frame).toBeVisible();
  await vi.waitFor(() => expect(state.surfaceControl).not.toBeNull());
  // The session list still says the agent owns the tab; only the stream knows yet.
  await act(() =>
    state.surfaceControl?.({ private: true, controller: "agent", canOperate: false }),
  );
  await expect.element(frame).not.toBeVisible();
  await expect.element(screen.getByText("Private")).toBeVisible();
  // A dropped connection cannot lift privacy; only the stream's next answer does.
  await act(() => state.surfaceControl?.(null));
  await expect.element(frame).not.toBeVisible();
  await act(() =>
    state.surfaceControl?.({ private: false, controller: "agent", canOperate: false }),
  );
  await expect.element(frame).toBeVisible();
});

it("keeps the large view's stream for the person typing a secret, and no picture on a card", async () => {
  setup([]);
  const tab = browserTab({ owner: "private" });
  await using screen = await render(cardView(tab, { size: "large" }).element);
  const frame = screen.getByTestId("session-frame");
  await expect.element(frame).toBeVisible();
  await vi.waitFor(() => expect(state.surfaceControl).not.toBeNull());
  await act(() => state.surfaceControl?.({ private: true, controller: "you", canOperate: true }));
  await expect.element(frame).toBeVisible();
  await screen.rerender(cardView(tab).element);
  await expect.element(screen.getByText("Private")).toBeVisible();
  await expect.element(screen.getByTestId("session-frame")).not.toBeInTheDocument();
});

it("shows a desktop thread's live frames, drops them in private mode, and keeps the last one dimmed when stopped", async () => {
  setup([]);
  const desk = desktopApp({
    capabilities: {
      controls: ["takeover", "stop"],
      frames: true,
      privateMode: true,
      humanInput: true,
    },
  });
  state.frame = { type: "frame", seq: 1, width: 4, height: 4, mime: "image/jpeg", data: "AAAA" };
  await using screen = await render(cardView(desk).element);
  const picture = () => screen.container.querySelector("img");
  await vi.waitFor(() =>
    expect(picture()?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA"),
  );
  await sendFrame({ type: "unavailable", reason: "private" });
  await expect.element(screen.getByText("Private")).toBeVisible();
  expect(picture()).toBeNull();
  await sendFrame({ type: "frame", seq: 2, width: 4, height: 4, mime: "image/jpeg", data: "BBBB" });
  await vi.waitFor(() => expect(picture()).not.toBeNull());
  // Stopped: nothing is watched any more, and the last frame stays, dimmed.
  await screen.rerender(cardView({ ...desk, status: "stopped" }).element);
  expect(state.frameRequests.at(-1)).toBeNull();
  await vi.waitFor(() => expect(picture()?.className).toContain("opacity-50"));
  expect(picture()?.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
});

// #1518: Pop out and Dock mount the stack anew, and a stopped session sends no more frames.
it("keeps a stopped desktop session's last frame on a card mounted anew, as when popped out", async () => {
  setup([]);
  const desk = desktopApp({
    id: "desktop-remounted",
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
  });
  state.frame = { type: "frame", seq: 1, width: 4, height: 4, mime: "image/jpeg", data: "CCCC" };
  {
    await using docked = await render(cardView(desk).element);
    await vi.waitFor(() =>
      expect(docked.container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/jpeg;base64,CCCC",
      ),
    );
    // Stopped while docked, then popped out: the docked card goes away showing the frame.
    state.frame = null;
    await docked.rerender(cardView({ ...desk, status: "stopped" }).element);
    await vi.waitFor(() => expect(docked.container.querySelector("img")).not.toBeNull());
  }
  {
    await using popped = await render(cardView({ ...desk, status: "stopped" }).element);
    const picture = () => popped.container.querySelector("img");
    await vi.waitFor(() =>
      expect(picture()?.getAttribute("src")).toBe("data:image/jpeg;base64,CCCC"),
    );
    expect(picture()?.className).toContain("opacity-50");
  }
  // And docked again.
  await using redocked = await render(cardView({ ...desk, status: "stopped" }).element);
  await vi.waitFor(() =>
    expect(redocked.container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/jpeg;base64,CCCC",
    ),
  );
});

it("forgets a desktop session's last frame once it turns private, even on a card mounted anew", async () => {
  setup([]);
  const desk = desktopApp({
    id: "desktop-private-remounted",
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
  });
  state.frame = { type: "frame", seq: 1, width: 4, height: 4, mime: "image/jpeg", data: "DDDD" };
  {
    await using docked = await render(cardView(desk).element);
    await vi.waitFor(() => expect(docked.container.querySelector("img")).not.toBeNull());
    await sendFrame({ type: "unavailable", reason: "private" });
    await expect.element(docked.getByText("Private")).toBeVisible();
  }
  state.frame = null;
  await using popped = await render(cardView({ ...desk, status: "stopped" }).element);
  await vi.waitFor(() => expect(state.frameRequests.at(-1)).toBeNull());
  expect(popped.container.querySelector("img")).toBeNull();
});

it("shows no earlier frame once a person held the session, even after it stops", async () => {
  setup([]);
  const desk = desktopApp({
    id: "desktop-taken-over",
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
  });
  state.frame = { type: "frame", seq: 1, width: 4, height: 4, mime: "image/jpeg", data: "EEEE" };
  await using screen = await render(cardView(desk).element);
  await vi.waitFor(() => expect(screen.container.querySelector("img")).not.toBeNull());
  // The list marks it private: the card unmounts its picture without hearing a private frame.
  await screen.rerender(cardView({ ...desk, owner: "private" }).element);
  await expect.element(screen.getByText("Private")).toBeVisible();
  state.frame = null;
  await screen.rerender(cardView({ ...desk, status: "stopped" }).element);
  await vi.waitFor(() => expect(state.frameRequests.at(-1)).toBeNull());
  expect(screen.container.querySelector("img")).toBeNull();
});

it("does not give a stopped session's frame to another thread's session with the same id", async () => {
  setup([]);
  const desk = desktopApp({
    id: "desktop-reused",
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
  });
  state.frame = { type: "frame", seq: 1, width: 4, height: 4, mime: "image/jpeg", data: "FFFF" };
  {
    await using first = await render(cardView(desk).element);
    await vi.waitFor(() => expect(first.container.querySelector("img")).not.toBeNull());
    state.frame = null;
    await first.rerender(cardView({ ...desk, status: "stopped" }).element);
    await vi.waitFor(() => expect(first.container.querySelector("img")).not.toBeNull());
  }
  await using other = await render(
    cardView({ ...desk, threadId: ThreadId.make("thread-other"), status: "stopped" }).element,
  );
  await vi.waitFor(() => expect(state.frameRequests.at(-1)).toBeNull());
  expect(other.container.querySelector("img")).toBeNull();
});

it("tells a turn left without computer use which grant to allow, and watches no picture (#1399)", async () => {
  setup([]);
  const desk = desktopApp({
    status: "permission-needed",
    // Frames on, so only the guard keeps the card from watching a picture.
    capabilities: { controls: ["stop"], frames: true, privateMode: true, humanInput: true },
    target: {
      kind: "desktop",
      title: "Allow Screen & System Audio Recording for GOAT Computer Use",
    },
  });
  await using screen = await render(cardView(desk).element);
  await expect
    .element(screen.getByText(/No computer use yet\. Allow Screen & System Audio Recording/))
    .toBeVisible();
  expect(state.frameRequests.filter((id) => id !== null)).toEqual([]);
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
  const card = screen.getByRole("article", { name: "Thread thread-desk: Stopped" });
  await expect.element(card).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Close" }));
  await expect.element(card).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Agents on screen" }))
    .not.toBeInTheDocument();
});

it("leaves room for the pinned thread details card above the cards", async () => {
  setup([desktopApp()]);
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const card = screen.getByRole("article");
  await expect.element(card).toBeVisible();
  const details = document.createElement("div");
  details.dataset.threadDetailsCard = "";
  details.style.cssText = "position:fixed;top:60px;right:12px;width:360px;height:200px";
  document.body.append(details);
  try {
    // The details panel opening changes the layout key and re-measures what floats there.
    await act(() =>
      usePreviewSessionStack.setState((current) => ({ focusRequest: current.focusRequest + 1 })),
    );
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() =>
      expect(card.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(260),
    );
  } finally {
    details.remove();
  }
});
