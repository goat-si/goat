import { describe, expect, it, vi } from "vite-plus/test";

import { routeMouseToFrame, sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

const makeGuest = ({
  focused,
  focusedDocument = true,
  held = () => false,
}: {
  readonly focused: boolean;
  readonly focusedDocument?: boolean;
  /** Whether the server holds the page's input when the probe runs. */
  readonly held?: () => boolean;
}) => {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === "Runtime.evaluate" && params?.expression?.includes("!== null")
      ? { result: { value: held() ? "held" : focusedDocument } }
      : { result: {} },
  );
  const webContents = {
    focusedFrame: focused ? {} : null,
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it("stops the guest's navigation without stopping its embedder window", async () => {
    let guestLoading = true;
    let embedderLoading = true;
    const guest = {
      stop: () => {
        guestLoading = false;
      },
    };
    const debuggee = {
      sendCommand: async () => {
        embedderLoading = false;
        return {};
      },
    };
    await sendPageCommand(
      guest as unknown as Electron.WebContents,
      debuggee as unknown as Electron.Debugger,
      "Page.stopLoading",
      {},
    );
    expect(guestLoading).toBe(false);
    expect(embedderLoading).toBe(true);
  });

  it("regression: forwards every syllable of Korean text to a focused guest", async () => {
    const guest = makeGuest({ focused: true });
    await guest.send("Input.insertText", { text: "오늘 날씨" });
    expect(guest.sendCommand).toHaveBeenCalledWith("Input.insertText", { text: "오늘 날씨" });
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  it("regression: types every Korean syllable into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "오늘 날씨" });
    expect(guest.webContents.insertText).toHaveBeenCalledTimes(1);
    expect(guest.webContents.insertText).toHaveBeenCalledWith("오늘 날씨");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("drops text the server held after Stop, and inserts once the hold ends", async () => {
    let held = true;
    const guest = makeGuest({ focused: false, held: () => held });
    await guest.send("Input.insertText", { text: "late" });
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
    held = false;
    await guest.send("Input.insertText", { text: "next" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("next");
  });

  it("still inserts when the hold starts after its probe answered (one IPC hop)", async () => {
    // The remaining window: the probe is the last check before webContents.insertText.
    let held = false;
    const guest = makeGuest({ focused: false, held: () => held });
    guest.webContents.insertText.mockImplementationOnce(async () => {
      held = true;
    });
    await guest.send("Input.insertText", { text: "raced" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("raced");
  });

  it("drops input whose relay was released while its focus probe ran", async () => {
    let released = false;
    const guest = makeGuest({ focused: false });
    guest.sendCommand.mockImplementationOnce(async () => {
      // The server lets go of the relay, which lifts its hold, while the probe is answering.
      released = true;
      return { result: { value: true } };
    });
    await sendPageCommand(
      guest.webContents as unknown as Electron.WebContents,
      { sendCommand: guest.sendCommand } as unknown as Electron.Debugger,
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "x", text: "x" },
      undefined,
      undefined,
      undefined,
      undefined,
      () => !released,
    );
    expect(guest.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  describe("mouse input over a cross-site frame of a guest the window does not show", () => {
    type Box = readonly [left: number, top: number, right: number, bottom: number];
    // Boxes are in each frame's viewport. The page is scrolled 1000px and holds a cross-site
    // frame with a 10px border and a same-site frame; the cross-site frame, scrolled 300px,
    // holds another cross-site frame.
    const documents: Record<
      string,
      {
        readonly ownFrameId: string;
        readonly scroll: { readonly pageX: number; readonly pageY: number };
        readonly owners: ReadonlyArray<{ border: Box; content: Box; frameId: string }>;
      }
    > = {
      page: {
        ownFrameId: "MAIN",
        scroll: { pageX: 0, pageY: 1000 },
        owners: [
          { border: [0, 89, 620, 409], content: [10, 99, 610, 399], frameId: "CROSS" },
          { border: [700, 0, 900, 200], content: [700, 0, 900, 200], frameId: "SAME" },
        ],
      },
      "session-cross": {
        ownFrameId: "CROSS",
        scroll: { pageX: 0, pageY: 300 },
        owners: [
          { border: [100, 100, 300, 300], content: [100, 100, 300, 300], frameId: "NESTED" },
        ],
      },
      "session-nested": { ownFrameId: "NESTED", scroll: { pageX: 0, pageY: 0 }, owners: [] },
    };
    const inside = ([left, top, right, bottom]: Box, x: number, y: number) =>
      x >= left && x < right && y >= top && y < bottom;
    const makeFramedGuest = (
      frameSessions: ReadonlyMap<string, string> = new Map([
        ["CROSS", "session-cross"],
        ["NESTED", "session-nested"],
      ]),
      unansweredLookup?: string,
    ) => {
      const input: Array<{ sessionId: string | undefined; x: unknown; y: unknown }> = [];
      const lookups: Array<{ sessionId: string | undefined; x: unknown; y: unknown }> = [];
      const sendCommand = vi.fn(
        async (method: string, params: Record<string, unknown>, sessionId?: string) => {
          const document = documents[sessionId ?? "page"]!;
          if (method === "Page.getLayoutMetrics") {
            if (sessionId !== undefined && sessionId === unansweredLookup) {
              return new Promise(() => {});
            }
            return { cssLayoutViewport: document.scroll };
          }
          if (method === "DOM.getNodeForLocation") {
            lookups.push({ sessionId, x: params["x"], y: params["y"] });
            // Chromium hit-tests in document coordinates.
            const x = (params["x"] as number) - document.scroll.pageX;
            const y = (params["y"] as number) - document.scroll.pageY;
            const index = document.owners.findIndex(({ border }) => inside(border, x, y));
            return { backendNodeId: index + 1, frameId: document.ownFrameId };
          }
          const owner = document.owners[(params["backendNodeId"] as number) - 1];
          // A miss lands on the document's root element, which names the document's own frame.
          if (method === "DOM.describeNode") {
            return { node: { frameId: owner?.frameId ?? document.ownFrameId } };
          }
          if (method === "DOM.getBoxModel") {
            const [left, top, right, bottom] = owner!.content;
            return { model: { content: [left, top, right, top, right, bottom, left, bottom] } };
          }
          input.push({ sessionId, x: params["x"], y: params["y"] });
          return {};
        },
      );
      const debuggee = { sendCommand } as unknown as Electron.Debugger;
      const send = (params: Record<string, unknown>, routed: boolean) =>
        sendPageCommand(
          {} as Electron.WebContents,
          debuggee,
          "Input.dispatchMouseEvent",
          params,
          undefined,
          routed ? routeMouseToFrame(debuggee, frameSessions, () => () => {}) : undefined,
        );
      const click = async (x: number, y: number, routed = true) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await send({ type, x, y }, routed);
        }
      };
      return { click, send, input, lookups };
    };

    it("sends it to the frame under the point, at the frame's own coordinates", async () => {
      const guest = makeFramedGuest();
      await guest.click(75.4, 116.5);
      expect(guest.input).toEqual(
        Array.from({ length: 3 }, () => ({ sessionId: "session-cross", x: 65.4, y: 17.5 })),
      );
      // The lookup takes whole document pixels, so it adds each frame's scroll.
      expect(guest.lookups.slice(0, 2)).toEqual([
        { sessionId: undefined, x: 75, y: 1117 },
        { sessionId: "session-cross", x: 65, y: 318 },
      ]);
    });

    it("follows a cross-site frame inside another", async () => {
      const guest = makeFramedGuest();
      await guest.click(160, 250);
      expect(guest.input[0]).toEqual({ sessionId: "session-nested", x: 50, y: 51 });
    });

    it("keeps input over the page, a same-site frame or a frame's border on the page", async () => {
      const guest = makeFramedGuest();
      await guest.click(650, 50);
      await guest.click(750, 50);
      await guest.click(5, 95);
      expect(guest.input.map(({ sessionId }) => sessionId)).toEqual(Array(9).fill(undefined));
    });

    it("gives the page an event whose frame never answers its lookup", async () => {
      vi.useFakeTimers();
      try {
        const guest = makeFramedGuest(undefined, "session-cross");
        const stalled = guest.click(75, 116);
        await vi.advanceTimersByTimeAsync(3_000);
        await stalled;
        await guest.click(650, 50);
        expect(guest.input.map(({ sessionId }) => sessionId)).toEqual(Array(6).fill(undefined));
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves wheels, pages without cross-site frames, and shown guests to Chromium", async () => {
      const guest = makeFramedGuest();
      await guest.send({ type: "mouseWheel", x: 75, y: 116, deltaY: 100 }, true);
      await guest.click(75, 116, false);
      const bare = makeFramedGuest(new Map());
      await bare.click(75, 116);
      expect([...guest.lookups, ...bare.lookups]).toEqual([]);
      expect([...guest.input, ...bare.input].map(({ sessionId }) => sessionId)).toEqual(
        Array(7).fill(undefined),
      );
    });
  });

  it("regression: refuses Korean text and key input when a cross-site frame holds focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "오늘 날씨" })).rejects.toThrow(
      /cross-site frame/,
    );
    await expect(
      guest.send("Input.dispatchKeyEvent", { type: "keyDown", key: "씨", text: "씨" }),
    ).rejects.toThrow(/cross-site frame/);
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
    expect(guest.webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(guest.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.evaluate",
    ]);
  });

  it("asks before typing into an unfocused guest, once its focus lookup has answered", async () => {
    const guest = makeGuest({ focused: false });
    let held = false;
    const type = () =>
      sendPageCommand(
        guest.webContents as unknown as Electron.WebContents,
        { sendCommand: guest.sendCommand } as unknown as Electron.Debugger,
        "Input.insertText",
        { text: "note" },
        undefined,
        undefined,
        () => {
          if (held) throw new Error("Held");
        },
      );
    const typing = type();
    // The lookup is on its way; the hold starts before it answers.
    held = true;
    await expect(typing).rejects.toThrow("Held");
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
    held = false;
    await type();
    expect(guest.webContents.insertText).toHaveBeenCalledWith("note");
  });
});

describe("CDP key events as Electron input", () => {
  it("regression: keeps every syllable in Korean char events", () => {
    expect(toKeyboardInputEvents({ type: "char", text: "오늘 날씨" })).toEqual(
      ["오", "늘", " ", "날", "씨"].map((keyCode) => ({ type: "char", keyCode, modifiers: [] })),
    );
  });

  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  // regression: #18556 agent typing in a preview tab landed in the app instead of the guest
  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});
