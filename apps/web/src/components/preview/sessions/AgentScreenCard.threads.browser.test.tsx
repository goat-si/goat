import "~/index.css";

// The agents-on-screen cards are pinned to the thread that started them (computer and browser use).
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type PreviewSession,
  type PreviewSessionFrameEvent,
  ThreadId,
} from "@goat/contracts";
import type { ReactElement, Ref } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

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
  sessionListeners: new Set<() => void>(),
}));

vi.mock("../../../state/previewSessions", async () => {
  const { Atom } = await import("effect/reactivity");
  const { useSyncExternalStore } = await import("react");
  return {
    // A subscription, like the real sessions atom: a new list re-renders its readers.
    usePreviewSessions: () =>
      useSyncExternalStore(
        (listener) => {
          state.sessionListeners.add(listener);
          return () => state.sessionListeners.delete(listener);
        },
        () => state.sessions,
      ),
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
  // The preview runtime module reads these; outside the desktop app no tab is drawn natively.
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));
// Pop out uses the browser's picture-in-picture, which a headless test page cannot open.
vi.mock("../../../browser/serverPictureInPicture", () => ({
  serverPictureInPictureKey: (threadId: string, tabId: string) => JSON.stringify([threadId, tabId]),
  supportsServerPictureInPicture: () => true,
  useServerPictureInPictureKey: () => null,
  openServerPictureInPicture: async () => undefined,
  closeServerPictureInPicture: () => undefined,
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

import { AgentScreenCardsToggle } from "./AgentScreenCardsToggle";
import { PreviewSessionStack } from "./PreviewSessionStack";
import { usePreviewSessionStack } from "./previewSessionStackStore";
import { usePreviewMiniPlayerStore } from "../../../previewMiniPlayerStore";

const environmentId = "env-cards" as EnvironmentId;
const HIDDEN_KEY = "goat:agent-screen-cards:hidden";

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
    target: {
      kind: "desktop",
      bundleId: "com.apple.TextEdit",
      title: "Whole screen",
      motionSupport: "unsupported",
    },
    ...patch,
  });

/** The route shows the first session's thread unless a test names another one. */
function setup(
  sessions: ReadonlyArray<PreviewSession>,
  routeThread: string | null = sessions[0]?.threadId ?? null,
) {
  state.sessions = sessions;
  state.control.mockReset();
  state.control.mockResolvedValue({ _tag: "Success", value: { applied: true } });
  state.canControl = true;
  state.scopes = new Set([AuthPreviewOperateScope]);
  state.frame = null;
  state.frameRequests = [];
  state.surfaceControl = null;
  state.surfaceCalls = [];
  state.routeThread = routeThread;
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  window.sessionStorage.removeItem(HIDDEN_KEY);
  usePreviewSessionStack.setState({
    hidden: false,
    narrow: false,
    revealedWhileNarrow: false,
    dismissed: new Set(),
    hiddenLive: new Map(),
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

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadC = ThreadId.make("thread-c");
const withFrames = {
  controls: ["takeover", "stop", "stopAll"],
  frames: true,
  privateMode: true,
  humanInput: true,
} satisfies PreviewSession["capabilities"];
const pageTab = (thread: ThreadId, name: string) =>
  browserTab({
    id: `browser-${name}`,
    threadId: thread,
    target: {
      kind: "browser",
      tabId: `tab-${name}`,
      url: "http://localhost:8036/",
      title: `Page ${name}`,
    },
  });
const appTitles = () =>
  Array.from(document.querySelectorAll("article"), (card) => card.getAttribute("aria-label"));
const showThread = async (
  screen: { rerender: (ui: ReactElement) => Promise<unknown> },
  thread: string | null,
) => {
  state.routeThread = thread;
  await screen.rerender(<Cards />);
};

// Jun's report (2026-10-27): once one thread used computer use, its card showed in every thread.
it("pins each card to its own thread: browser, desktop and blocked sessions show only there", async () => {
  setup(
    [
      pageTab(threadA, "a"),
      desktopApp({ id: "desktop-a", threadId: threadA, capabilities: withFrames }),
      pageTab(threadB, "b"),
      desktopApp({ id: "desktop-b", threadId: threadB, capabilities: withFrames }),
      desktopApp({
        id: "desktop:blocked:thread-c",
        threadId: threadC,
        status: "permission-needed",
        capabilities: { controls: [], frames: false, privateMode: false, humanInput: false },
      }),
    ],
    "thread-a",
  );
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-a: Agent controlling" }))
    .toBeVisible();
  expect(appTitles()).toEqual(["Page a: Agent controlling", "Thread thread-a: Agent controlling"]);
  // Another thread's desktop is never captured for this view.
  expect(state.frameRequests.filter((id) => id !== null)).not.toContain("desktop-b");

  await showThread(screen, "thread-b");
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-b: Agent controlling" }))
    .toBeVisible();
  expect(appTitles()).toEqual(["Page b: Agent controlling", "Thread thread-b: Agent controlling"]);

  await showThread(screen, "thread-c");
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-c: Permission needed" }))
    .toBeVisible();
  expect(appTitles()).toEqual(["Thread thread-c: Permission needed"]);
});

// Several threads may drive the same app at once; each still sees only its own card.
it("gives two threads driving the same app one card each, in their own thread only", async () => {
  const textEdit = (id: string, thread: ThreadId) =>
    desktopApp({
      id,
      threadId: thread,
      target: { kind: "desktop", title: "TextEdit", motionSupport: "unsupported" },
      lease: { threadId: thread, expiresAt: "2026-10-27T12:00:00.000Z", scope: ["TextEdit"] },
    });
  setup([textEdit("desktop-a", threadA), textEdit("desktop-b", threadB)], "thread-b");
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-b: Agent controlling" }))
    .toBeVisible();
  expect(appTitles()).toEqual(["Thread thread-b: Agent controlling"]);
  await showThread(screen, "thread-a");
  await expect
    .element(screen.getByRole("article", { name: "Thread thread-a: Agent controlling" }))
    .toBeVisible();
  expect(appTitles()).toEqual(["Thread thread-a: Agent controlling"]);
});

// Stop all is the host's kill switch, so a thread with no card of its own still reaches it.
it("keeps Stop all in a thread with no card of its own, without another thread's cards", async () => {
  setup([desktopApp({ id: "desktop-a", threadId: threadA })], "thread-b");
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await userEvent.click(screen.getByRole("button", { name: "Stop all agents on screen" }));
  expect(state.control).toHaveBeenCalledWith({ environmentId, input: { control: "stopAll" } });
  expect(appTitles()).toEqual([]);
  await expect
    .element(screen.getByRole("button", { name: "Agents on screen" }))
    .not.toBeInTheDocument();
  // A view with no thread, such as a new draft, shows no cards either but keeps Stop all.
  await showThread(screen, null);
  await expect
    .element(screen.getByRole("button", { name: "Stop all agents on screen" }))
    .toBeVisible();
  expect(appTitles()).toEqual([]);
});

it("never shows a session that names no thread", async () => {
  setup([desktopApp({ id: "desktop-orphan", threadId: undefined })], "thread-a");
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  await expect
    .element(screen.getByRole("button", { name: "Stop all agents on screen" }))
    .toBeVisible();
  expect(appTitles()).toEqual([]);
  await showThread(screen, null);
  expect(appTitles()).toEqual([]);
});

it("keeps a card closed in one thread from changing another thread's list button", async () => {
  setup([pageTab(threadA, "a"), pageTab(threadB, "b")], "thread-a");
  await page.viewport(1400, 900);
  using _pane = paneOf(1400);
  await using screen = await render(<Cards />);
  const card = screen.getByRole("article", { name: /Page a/ });
  await userEvent.hover(card);
  await userEvent.click(card.getByRole("button", { name: "Close" }));
  await expect.element(card).not.toBeInTheDocument();
  await showThread(screen, "thread-b");
  const list = screen.getByRole("button", { name: "Agents on screen" });
  await expect.element(list).toHaveAttribute("aria-pressed", "true");
  // Showing the cards in thread B leaves the card closed in thread A put away.
  await userEvent.click(list);
  await userEvent.click(list);
  await showThread(screen, "thread-a");
  await expect.element(screen.getByRole("article", { name: /Page a/ })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Agents on screen" }))
    .toHaveAttribute("aria-pressed", "false");
});
