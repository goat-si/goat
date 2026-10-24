import { describe, expect, it, vi } from "vite-plus/test";

import { sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

/** A guest whose page reports `focusedDocument` for the focus probe. */
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
  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
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
      () => !released,
    );
    expect(guest.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });
});

describe("CDP key events as Electron input", () => {
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
