import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });

  it("decodes cursor-state without coordinates and rejects stale or unknown phases", () => {
    const onPointer = vi.fn();
    const onCursorState = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onCursorState,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    const identity = {
      environmentId: "environment",
      runId: "run",
      turnId: "turn",
      targetId: "target",
      generation: 1,
    };
    const message = (phase: string, sequence: number) =>
      FakeSocket.current.message(
        JSON.stringify({
          type: "cursor-state",
          cursor: { identity: { ...identity, sequence }, phase },
        }),
      );
    message("thinking", 1);
    message("unknown", 2);
    message("hidden", 2);
    message("acting", 1);
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "move", x: 1, y: 2, sequence: 3 }),
    );
    expect(onCursorState).toHaveBeenCalledTimes(2);
    expect(onCursorState).toHaveBeenLastCalledWith({
      identity: { ...identity, sequence: 2 },
      phase: "hidden",
    });
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({ phase: "move", x: 1, y: 2, sequence: 3 });
  });

  it("renders a code-mode pointer with its owner and a legacy pointer after terminal hide", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onCursorState: vi.fn(),
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    const cursor = {
      identity: {
        environmentId: "environment",
        runId: "run",
        turnId: "turn",
        targetId: "target",
        generation: 1,
        sequence: 1,
      },
      phase: "thinking",
    };
    FakeSocket.current.message(JSON.stringify({ type: "cursor-state", cursor }));
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "move", x: 4, y: 5, sequence: 1, cursor }),
    );
    FakeSocket.current.message(
      JSON.stringify({
        type: "cursor-state",
        cursor: { ...cursor, identity: { ...cursor.identity, sequence: 2 }, phase: "hidden" },
      }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 6, y: 7, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledTimes(2);
    expect(onPointer).toHaveBeenNthCalledWith(1, {
      phase: "move",
      x: 4,
      y: 5,
      sequence: 1,
      cursor,
    });
    expect(onPointer).toHaveBeenNthCalledWith(2, { phase: "click", x: 6, y: 7, sequence: 2 });
  });
});

describe("preview frame painter privacy", () => {
  /** Decodes that finish only when the test says so, to order them against private mode. */
  function setup() {
    const decodes: Array<(bitmap: ImageBitmap) => void> = [];
    vi.stubGlobal(
      "createImageBitmap",
      () => new Promise<ImageBitmap>((resolve) => void decodes.push(resolve)),
    );
    const drawn: Array<number> = [];
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({ drawImage: (bitmap: { id: number }) => void drawn.push(bitmap.id) }),
    } as unknown as HTMLCanvasElement;
    const finish = async (index: number, id: number) => {
      decodes[index]?.({
        id,
        width: 1,
        height: 1,
        close: () => undefined,
      } as unknown as ImageBitmap);
      // The painter draws in the decode's continuation.
      await Promise.resolve();
      await Promise.resolve();
    };
    return {
      painter: createPreviewFramePainter(canvas),
      drawn,
      decodes,
      finish,
      [Symbol.dispose]: () => vi.unstubAllGlobals(),
    };
  }
  const frame = () => new ArrayBuffer(4);

  it("never paints a frame decoded across the start of private mode", async () => {
    using fixture = setup();
    fixture.painter.paint(frame());
    fixture.painter.setSuppressed(true);
    await fixture.finish(0, 1);
    // Frames sent meanwhile are dropped without decoding.
    fixture.painter.paint(frame());
    expect(fixture.decodes).toHaveLength(1);
    expect(fixture.drawn).toEqual([]);
  });

  it("never paints a pre-private frame that finishes decoding after private mode ended", async () => {
    using fixture = setup();
    fixture.painter.paint(frame());
    fixture.painter.setSuppressed(true);
    fixture.painter.setSuppressed(false);
    await fixture.finish(0, 1);
    expect(fixture.drawn).toEqual([]);
    // The next frame after private mode paints.
    fixture.painter.paint(frame());
    await fixture.finish(1, 2);
    expect(fixture.drawn).toEqual([2]);
  });
});
