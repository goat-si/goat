import { assert, describe, it } from "@effect/vitest";

import {
  initialOverlayState,
  type OverlayEvent,
  type OverlayState,
  overlayStep,
  replyImageSize,
} from "./ComputerUseOverlay.ts";

const WINDOW = { pid: 42, window_id: 7 };

/** Runs events in order and records the commands each one sends before it is forwarded. */
function run(events: ReadonlyArray<OverlayEvent>, from: OverlayState = initialOverlayState) {
  let state = from;
  const sent: Array<ReadonlyArray<unknown>> = [];
  for (const event of events) {
    const [next, commands] = overlayStep(state, event);
    state = next;
    sent.push(commands);
  }
  return { state, sent };
}

const call = (id: string, name: string, args: unknown = WINDOW): OverlayEvent => ({
  type: "call",
  id,
  name,
  args,
});
const reply = (id: string, image?: { width: number; height: number }): OverlayEvent => ({
  type: "reply",
  id,
  ...(image ? { image } : {}),
});
const snapshot = [call("s", "get_window_state"), reply("s", { width: 1000, height: 500 })];

describe("ComputerUseOverlay", () => {
  it("hides before a capture is forwarded and comes back after it answers", () => {
    const { sent } = run([
      ...snapshot,
      call("c", "click", { ...WINDOW, x: 500, y: 250 }),
      reply("c"),
      call("s2", "get_window_state"),
      reply("s2", { width: 1000, height: 500 }),
    ]);
    const show = { op: "show", pid: 42, windowId: 7, point: { fx: 0.5, fy: 0.5 } };
    assert.deepEqual(sent.slice(2), [
      [{ ...show, phase: "acting" }],
      [{ ...show, phase: "resting" }],
      [{ op: "hide", reason: "capture" }],
      [{ ...show, phase: "resting" }],
    ]);
  });

  it("places the cursor by the last screenshot of that window, not by screen pixels", () => {
    const { state } = run([
      ...snapshot,
      call("c", "drag", { ...WINDOW, from_x: 250, from_y: 100, to_x: 900, to_y: 400 }),
    ]);
    assert.deepEqual(state.shown, {
      op: "show",
      pid: 42,
      windowId: 7,
      point: { fx: 0.25, fy: 0.2 },
      phase: "acting",
    });
  });

  it("shows only the glow when the point cannot be placed", () => {
    for (const args of [
      { ...WINDOW, x: 10, y: 10, from_zoom: true },
      { ...WINDOW, element_token: "snap:3" },
      { target: { kind: "window", pid: 42, window_id: 8 }, x: 10, y: 10 },
    ]) {
      const { state } = run([...snapshot, call("c", "click", args)]);
      assert.equal(state.shown?.op, "show");
      assert.notProperty(state.shown ?? {}, "point");
    }
  });

  it("draws nothing for input with no window, such as a desktop target", () => {
    const { state } = run([call("c", "click", { x: 10, y: 10, target: { kind: "desktop" } })]);
    assert.deepEqual(state.shown, { op: "hide", reason: "idle" });
  });

  it("hides for every pause and for the end, and stays hidden through later replies", () => {
    for (const reason of ["human_input", "takeover", "private"] as const) {
      const { sent } = run([
        ...snapshot,
        call("c", "click", { ...WINDOW, x: 1, y: 1 }),
        { type: "pause", reason },
        reply("c"),
      ]);
      assert.deepEqual(sent.slice(3), [[{ op: "hide", reason }], []]);
    }
    const { state } = run([...snapshot, call("c", "click", WINDOW), { type: "end" }, reply("c")]);
    assert.deepEqual(state.shown, { op: "hide", reason: "ended" });
  });

  it("keeps everything hidden through a recording and while a script runs", () => {
    const visible = run([...snapshot, call("c", "click", WINDOW), reply("c")]).state;
    const recording = run(
      [call("r", "start_recording", {}), call("c2", "click", WINDOW), reply("c2")],
      visible,
    );
    assert.deepEqual(recording.state.shown, { op: "hide", reason: "capture" });
    assert.equal(run([call("r2", "stop_recording", {})], recording.state).state.shown?.op, "show");
    assert.deepEqual(run([call("x", "run_script", {})], visible).state.shown, {
      op: "hide",
      reason: "capture",
    });
  });

  it("sends nothing when the drawing would not change", () => {
    const { sent } = run([
      ...snapshot,
      call("c", "click", WINDOW),
      call("l", "list_apps", {}),
      reply("l"),
    ]);
    assert.deepEqual(sent.slice(3), [[], []]);
  });

  it("reads a PNG screenshot's size from its header", () => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "latin1");
    header.writeUInt32BE(1440, 16);
    header.writeUInt32BE(900, 20);
    const result = {
      content: [
        { type: "text", text: "tree" },
        { type: "image", mimeType: "image/png", data: header.toString("base64") },
      ],
    };
    assert.deepEqual(replyImageSize(result), { width: 1440, height: 900 });
    assert.isUndefined(
      replyImageSize({ content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/" }] }),
    );
  });
});
