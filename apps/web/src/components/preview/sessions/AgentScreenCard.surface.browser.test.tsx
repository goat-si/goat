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
vi.mock("../../../state/previewStream", () => ({
  usePreviewStreamAccess: () => state.access,
  refreshPreviewStreamAccess: () => undefined,
}));
vi.mock("../../../previewStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../previewStateStore")>()),
  usePreviewTabAgentDriven: () => state.agentDriven,
}));

import { ServerBrowserSurface } from "../../../browser/ServerBrowserSurface";
import { AgentScreenCardView } from "./AgentScreenCard";

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
it("a tab this desktop draws opens no stream, which would wait on a page that is not painting", async () => {
  setup();
  await using screen = await render(
    <AgentScreenCardView
      session={tab}
      size="large"
      width={640}
      threadTitle="Thread"
      live
      canControl
      canOperateBrowser
      drawnHere
      focused={false}
      focusRequest={0}
      onExpand={() => undefined}
      onControl={() => undefined}
      onDismiss={() => undefined}
    />,
  );
  await expect.element(screen.getByText("Open to watch")).toBeVisible();
  expect(state.created).toBe(0);
  expect(screen.container.querySelector("canvas")).toBeNull();
});
