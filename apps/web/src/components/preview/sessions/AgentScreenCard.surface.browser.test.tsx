import "~/index.css";

import type {
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@goat/client-runtime/preview/server-browser-stream";
import { type EnvironmentId, type PreviewSession, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  events: null as PreviewStreamEvents | null,
  sent: [] as Array<PreviewStreamInput>,
  agentDriven: false,
  created: 0,
  // One access object, as the real atom keeps; a new one would reconnect the stream.
  access: {
    httpBase: "http://preview.test",
    wsBase: "ws://preview.test",
    query: {},
    credentials: true,
  },
}));

// The network boundary: the real surface and painter run; the socket is this fake client.
vi.mock("@goat/client-runtime/preview/server-browser-stream", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/client-runtime/preview/server-browser-stream")>()),
  createPreviewStreamClient: (_target: unknown, events: PreviewStreamEvents) => {
    state.events = events;
    state.created += 1;
    return {
      send: (input: PreviewStreamInput) => (state.sent.push(input), true),
      stop: () => undefined,
    };
  },
}));
// Pop out uses the browser's picture-in-picture, which a headless test page cannot open.
vi.mock("../../../browser/serverPictureInPicture", () => ({
  serverPictureInPictureKey: (threadId: string, tabId: string) => JSON.stringify([threadId, tabId]),
  supportsServerPictureInPicture: () => true,
  useServerPictureInPictureKey: () => null,
  openServerPictureInPicture: async () => undefined,
  closeServerPictureInPicture: () => undefined,
}));
// The desktop bridge that pops a drawn tab's webview into its own window.
const pip = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));
vi.mock("../previewBridge", () => ({ previewBridge: { pictureInPicture: pip } }));
vi.mock("../../../state/previewStream", () => ({
  usePreviewStreamAccess: () => state.access,
  refreshPreviewStreamAccess: () => undefined,
}));
vi.mock("../../../previewStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../previewStateStore")>()),
  usePreviewTabAgentDriven: () => state.agentDriven,
}));

import { ServerBrowserSurface } from "../../../browser/ServerBrowserSurface";
import {
  acquireBrowserSurface,
  useBrowserSurfaceStore,
} from "../../../browser/browserSurfaceStore";
import { AgentScreenCardView } from "./AgentScreenCard";
import { StackDocumentContext } from "./PreviewSessionStackSurface";

const environmentId = "env-surface" as EnvironmentId;
const tab: PreviewSession = {
  id: "browser:thread-1:tab-1",
  kind: "browser",
  environmentId,
  host: "mac",
  platform: "mac",
  threadId: ThreadId.make("thread-1"),
  target: { kind: "browser", tabId: "tab-1", url: "http://localhost:8036/", title: "GOAT (Dev)" },
  owner: "agent",
  status: "acting",
  capabilities: {
    controls: ["takeover", "stop"],
    frames: true,
    privateMode: true,
    humanInput: true,
  },
};

function setup(agentDriven = false) {
  state.events = null;
  state.sent = [];
  state.agentDriven = agentDriven;
  state.created = 0;
}

/** A real 16:10 JPEG, so the painter decodes and paints it like a streamed frame. */
async function jpeg() {
  const canvas = new OffscreenCanvas(160, 100);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = "#e11d48";
  context.fillRect(0, 0, 160, 100);
  return (await canvas.convertToBlob({ type: "image/jpeg" })).arrayBuffer();
}

const control = (patch: Record<string, unknown>) =>
  act(() =>
    state.events?.onControl?.({
      canOperate: true,
      controller: "agent",
      generation: 1,
      dialog: null,
      ...patch,
    } as never),
  );

const painted = (canvas: HTMLCanvasElement) =>
  canvas.width > 1 &&
  (canvas.getContext("2d")?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3] ?? 0) >
    0;

function card(size: "card" | "large", session: PreviewSession = tab, onCollapse = () => undefined) {
  return (
    <AgentScreenCardView
      session={session}
      size={size}
      width={size === "large" ? 640 : 240}
      threadTitle="Thread"
      live
      canControl
      canOperateBrowser
      focused={false}
      focusRequest={0}
      onExpand={() => undefined}
      onCollapse={onCollapse}
      onControl={() => undefined}
      onDismiss={() => undefined}
    />
  );
}

async function connect(screen: { container: HTMLElement }) {
  await vi.waitFor(() => expect(state.events).not.toBeNull());
  await act(() => state.events?.onViewport({ width: 1280, height: 800 }));
  await control({});
  const frame = await jpeg();
  await act(() => state.events?.onFrame(frame));
  const canvas = screen.container.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  await vi.waitFor(() => expect(painted(canvas)).toBe(true));
  return canvas;
}

it("takes over a letterboxed tab, clicks land on the page's own coordinates, and the page never resizes", async () => {
  setup();
  await page.viewport(1400, 900);
  const collapse = vi.fn();
  await using screen = await render(card("large", tab, collapse));
  const canvas = await connect(screen);
  // The agent's pointer is drawn where it is on the page.
  await act(() => state.events?.onPointer?.({ phase: "move", x: 640, y: 400, sequence: 1 }));
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-agent-browser-cursor]")).not.toBeNull(),
  );

  // One connection for the whole session: control and frames never reconnect the stream.
  expect(state.created).toBe(1);
  await userEvent.hover(screen.getByRole("article"));
  await userEvent.click(screen.getByRole("button", { name: "Take over" }));
  expect(state.sent).toContainEqual({ type: "takeControl" });
  await control({ controller: "you" });

  const box = canvas.getBoundingClientRect();
  await userEvent.click(canvas, { position: { x: box.width * 0.5, y: box.height * 0.25 } });
  const down = state.sent.find((input) => input.type === "mouse" && input.action === "down");
  expect(down?.type === "mouse" && [Math.round(down.x), Math.round(down.y)]).toEqual([640, 200]);

  // Only the frame around the page changes with the window; the page keeps its viewport.
  await page.viewport(1000, 800);
  await control({ controller: "you", generation: 2 });
  expect(state.sent.some((input) => input.type === "resize")).toBe(false);

  await userEvent.click(screen.getByRole("button", { name: "Shrink to a card" }));
  expect(state.sent).toContainEqual({ type: "releaseControl" });
  expect(collapse).toHaveBeenCalledOnce();
});

it("wipes the picture and drops frames while a secret field is private to someone else", async () => {
  setup();
  await using screen = await render(card("card"));
  const canvas = await connect(screen);
  await control({ private: true, controller: "agent", canOperate: false });
  expect(painted(canvas)).toBe(false);
  // Frames in flight or sent meanwhile never paint (serverBrowserStream.test.ts orders decodes).
  // A reconnect keeps it hidden until the stream confirms the secret is gone.
  await act(() => state.events?.onConnectedChange(false));
  await control({ private: false });
  const next = await jpeg();
  await act(() => state.events?.onFrame(next));
  await vi.waitFor(() => expect(painted(canvas)).toBe(true));
});

it("keeps a stopped tab's last frame on its card, dimmed", async () => {
  setup();
  await using screen = await render(card("card"));
  const canvas = await connect(screen);
  await screen.rerender(
    card("card", {
      ...tab,
      status: "stopped",
      capabilities: { ...tab.capabilities, controls: ["handBack", "stopAll"] },
    }),
  );
  expect(painted(canvas)).toBe(true);
  expect(canvas.closest(".opacity-50")).not.toBeNull();
});

it("never resizes an agent's page from a view that follows its size, even after a takeover", async () => {
  setup(true);
  await using screen = await render(
    <div style={{ width: 500, height: 300 }}>
      <ServerBrowserSurface
        environmentId={environmentId}
        threadId="thread-1"
        tabId="tab-1"
        visible
      />
    </div>,
  );
  await connect(screen);
  await control({ controller: "you" });
  expect(state.sent.some((input) => input.type === "resize")).toBe(false);
});

it("still fits a person's own tab to the view it follows", async () => {
  setup(false);
  await using screen = await render(
    <div style={{ width: 500, height: 300 }}>
      <ServerBrowserSurface
        environmentId={environmentId}
        threadId="thread-1"
        tabId="tab-1"
        visible
      />
    </div>,
  );
  await connect(screen);
  await control({ controller: "you" });
  expect(state.sent.some((input) => input.type === "resize")).toBe(true);
});
const RUNTIME_TAB = JSON.stringify([environmentId, "thread-1", "epoch-1", "tab-1"]);
const hosted = { runtimeTabId: RUNTIME_TAB, overlay: null };

function drawnCard(hostedTab: typeof hosted | null) {
  return (
    <AgentScreenCardView
      session={tab}
      size="large"
      width={640}
      threadTitle="Thread"
      live
      canControl
      canOperateBrowser
      drawnHere
      hosted={hostedTab}
      focused={false}
      focusRequest={0}
      onExpand={() => undefined}
      onOpenInPanel={() => undefined}
      onControl={() => undefined}
      onDismiss={() => undefined}
    />
  );
}

const surfaceOf = () => useBrowserSurfaceStore.getState().byTabId[RUNTIME_TAB];
const overlay = () => document.querySelector("[data-agent-card-overlay]");

it("shows a tab this desktop draws as its own webview in the card, with no stream and no Take over", async () => {
  setup();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  await page.viewport(1400, 900);
  await using screen = await render(drawnCard(hosted));
  // The card holds the webview's place, the way the right panel does, fitted to its picture.
  await vi.waitFor(() => expect(surfaceOf()?.visible).toBe(true));
  expect(surfaceOf()?.fitSourceContent).toBe(true);
  const picture = screen.container.querySelector("[data-browser-surface-slot]")!;
  const box = picture.getBoundingClientRect();
  expect(surfaceOf()?.rect).toEqual({
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  });
  // The picture's controls sit above the webview, over exactly its rect.
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  expect(overlay()!.querySelector('[aria-label="Stop"]')).not.toBeNull();
  expect(overlay()!.querySelector('[aria-label="Take over"]')).toBeNull();
  // No stream: the page is on screen, not parked behind a still that never comes.
  expect(state.created).toBe(0);
  expect(screen.container.querySelector("canvas")).toBeNull();
  // The floating player's actions are on the card.
  await expect
    .element(screen.getByRole("button", { name: "Open in the right panel" }))
    .toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
});

it("never takes a drawn tab from the panel showing it, and shows it once the panel lets go", async () => {
  setup();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  await page.viewport(1400, 900);
  const panel = acquireBrowserSurface(RUNTIME_TAB);
  panel.present({ x: 900, y: 60, width: 400, height: 600 }, true);
  const panelOwner = surfaceOf()?.owner;
  await using screen = await render(drawnCard(hosted));
  await expect.element(screen.getByRole("article")).toBeVisible();
  expect(surfaceOf()?.owner).toBe(panelOwner);
  expect(surfaceOf()?.rect).toEqual({ x: 900, y: 60, width: 400, height: 600 });
  expect(overlay()).toBeNull();
  // The panel closes: the card shows the tab.
  act(() => panel.release());
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  expect(surfaceOf()?.owner).not.toBe(panelOwner);
  // The panel opens again and takes it back; the card gives it up without a fight.
  const again = acquireBrowserSurface(RUNTIME_TAB);
  act(() => void again.present({ x: 900, y: 60, width: 400, height: 600 }, true));
  await vi.waitFor(() => expect(overlay()).toBeNull());
  expect(surfaceOf()?.rect).toEqual({ x: 900, y: 60, width: 400, height: 600 });
  again.release();
});

it("a drawn tab the desktop does not host yet shows a placeholder and opens no stream", async () => {
  setup();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  await using screen = await render(drawnCard(null));
  await expect.element(screen.getByRole("article")).toBeVisible();
  expect(state.created).toBe(0);
  expect(screen.container.querySelector("canvas")).toBeNull();
  expect(screen.container.querySelector("[data-browser-surface-slot]")).toBeNull();
  expect(screen.container.querySelector('[aria-label="Take over"]')).toBeNull();
});

it("a drawn tab popped out natively stays native when the cards float out of GOAT", async () => {
  setup();
  pip.open.mockClear();
  pip.close.mockClear();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  const poppedOut = {
    runtimeTabId: RUNTIME_TAB,
    overlay: { pictureInPicture: true, hasWebContents: true } as never,
  };
  const floatingDocument = document.implementation.createHTMLDocument("floating");
  await using screen = await render(
    <StackDocumentContext.Provider value={floatingDocument}>
      {drawnCard(poppedOut)}
    </StackDocumentContext.Provider>,
  );
  // No webview can show in the floating window; the pop-out still belongs to the native tab.
  expect(screen.container.querySelector("[data-browser-surface-slot]")).toBeNull();
  const close = screen.getByRole("button", { name: "Close separate window" });
  await expect.element(close).toHaveAttribute("aria-pressed", "true");
  await close.click({ force: true });
  expect(pip.close).toHaveBeenCalledWith(RUNTIME_TAB);
  expect(pip.open).not.toHaveBeenCalled();
});

it("the wheel over a drawn card's picture scrolls the stack, not nothing", async () => {
  setup();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  await page.viewport(1400, 900);
  await using screen = await render(
    <div data-agent-cards-scroll="" style={{ height: 300, overflowY: "auto" }}>
      <AgentScreenCardView
        session={tab}
        size="card"
        width={240}
        threadTitle="Thread"
        live
        canControl
        canOperateBrowser
        drawnHere
        hosted={hosted}
        focused={false}
        focusRequest={0}
        onExpand={() => undefined}
        onControl={() => undefined}
        onDismiss={() => undefined}
      />
      <div style={{ height: 1200 }} />
    </div>,
  );
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  const list = screen.container.querySelector<HTMLElement>("[data-agent-cards-scroll]")!;
  const opener = overlay()!.querySelector<HTMLElement>('button[aria-label="Open GOAT (Dev)"]')!;
  opener.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
  await vi.waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
});

it("a drawn tab's card hides the page while a secret field is focused or a person drives it", async () => {
  setup();
  useBrowserSurfaceStore.setState({ byTabId: {}, activityByTabId: {} });
  await page.viewport(1400, 900);
  const small = (owner: PreviewSession["owner"]) => (
    <AgentScreenCardView
      session={{ ...tab, owner }}
      size="card"
      width={240}
      threadTitle="Thread"
      live
      canControl
      canOperateBrowser
      drawnHere
      hosted={hosted}
      focused={false}
      focusRequest={0}
      onExpand={() => undefined}
      onControl={() => undefined}
      onDismiss={() => undefined}
    />
  );
  await using screen = await render(small("agent"));
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
  await screen.rerender(small("private"));
  await expect.element(screen.getByText("Private")).toBeVisible();
  // The webview is let go, not just covered: nothing presents it from this card.
  await vi.waitFor(() => expect(overlay()).toBeNull());
  expect(surfaceOf()?.visible).toBe(false);
  expect(surfaceOf()?.owner).toBeNull();
  await screen.rerender(small("human"));
  await expect.element(screen.getByText("A person is in control")).toBeVisible();
  expect(overlay()).toBeNull();
  // The large card is the person's own view: a secret they type there stays on screen for them.
  await screen.rerender(drawnCard(hosted));
  await vi.waitFor(() => expect(overlay()).not.toBeNull());
});
