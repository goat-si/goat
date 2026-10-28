import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";

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
  it("a call that overtakes its owner's phases shows under that owner, past an ended one", () => {
    const ended = {
      environmentId: EnvironmentId.make("environment"),
      runId: "run",
      turnId: "turn",
      targetId: "a",
      generation: 1,
      sequence: 3,
    };
    const next = { ...ended, targetId: "b", generation: 2, sequence: 0 };
    const { sent } = run([
      { type: "cursor", event: { op: "hide", identity: ended, phase: "hidden", reason: "ended" } },
      {
        type: "call",
        id: "b",
        name: "click",
        args: { ...WINDOW, element_token: "s1:1" },
        codeMode: true,
        cursor: { owner: next, point: { fx: 0.5, fy: 0.45 } },
      },
      // b's own first phase still supersedes the call's stand-in.
      {
        type: "cursor",
        event: { op: "show", identity: { ...next, sequence: 1 }, phase: "thinking" },
      },
    ]);
    const shown = { pid: 42, windowId: 7, point: { fx: 0.5, fy: 0.45 }, phase: "acting" };
    assert.deepEqual(sent[1], [{ op: "show", identity: next, ...shown }]);
    assert.deepEqual(sent[2], [{ op: "show", identity: { ...next, sequence: 1 }, ...shown }]);
  });
  it("keeps a hidden capture above concurrent thinking and refuses a stale show", () => {
    const owner = {
      environmentId: EnvironmentId.make("environment"),
      runId: "run",
      turnId: "turn",
      targetId: "target",
      generation: 1,
    };
    const scoped = (sequence: number, phase: "thinking" | "resting") => ({
      type: "cursor" as const,
      event: { op: "show" as const, identity: { ...owner, sequence }, phase },
    });
    const { state, sent } = run([
      ...snapshot,
      call("click", "click", { ...WINDOW, x: 20, y: 20 }),
      reply("click"),
      scoped(1, "thinking"),
      call("capture", "get_window_state", WINDOW),
      scoped(2, "resting"),
      scoped(1, "thinking"),
      reply("capture"),
      {
        type: "cursor",
        event: {
          op: "hide",
          identity: { ...owner, sequence: 3 },
          phase: "hidden",
          reason: "ended",
        },
      },
      scoped(2, "resting"),
    ]);
    assert.deepEqual(sent[5], [
      { op: "hide", identity: { ...owner, sequence: 1 }, phase: "hidden", reason: "capture" },
    ]);
    assert.deepEqual(sent[6], [
      { op: "hide", identity: { ...owner, sequence: 2 }, phase: "hidden", reason: "capture" },
    ]);
    assert.deepEqual(sent[7], []);
    assert.deepEqual(state.shown, {
      op: "hide",
      identity: { ...owner, sequence: 3 },
      phase: "hidden",
      reason: "idle",
    });
  });

  it("a target's own hide never ends the helper's session, even when a capture held it back", () => {
    // The macOS helper ends its MCP session on these reasons; only a pause or the end may send them.
    const sessionEnding = new Set(["human_input", "takeover", "private", "ended"]);
    const owner = {
      environmentId: EnvironmentId.make("environment"),
      runId: "run",
      turnId: "turn",
      targetId: "target",
      generation: 1,
    };
    for (const reason of ["ended", "private", "takeover"] as const) {
      const { state, sent } = run([
        ...snapshot,
        {
          type: "cursor",
          event: { op: "show", identity: { ...owner, sequence: 1 }, phase: "thinking" },
        },
        call("capture", "get_window_state", WINDOW),
        {
          type: "cursor",
          event: { op: "hide", identity: { ...owner, sequence: 2 }, phase: "hidden", reason },
        },
        reply("capture"),
      ]);
      for (const command of sent.flat())
        if (command !== null && typeof command === "object" && "reason" in command)
          assert.isFalse(
            sessionEnding.has(String(command.reason)),
            `${reason} sent ${String(command.reason)}`,
          );
      assert.deepEqual(state.shown, {
        op: "hide",
        identity: { ...owner, sequence: 2 },
        phase: "hidden",
        reason: "idle",
      });
    }
    const paused = run([
      ...snapshot,
      {
        type: "cursor",
        event: { op: "show", identity: { ...owner, sequence: 1 }, phase: "thinking" },
      },
      { type: "pause", reason: "human_input" },
    ]);
    assert.equal(
      paused.state.shown?.op === "hide" ? paused.state.shown.reason : undefined,
      "human_input",
    );
  });

  it("keeps direct-call markers separate from a code-mode cursor owner", () => {
    const owner = {
      environmentId: EnvironmentId.make("environment"),
      runId: "run",
      turnId: "turn",
      targetId: "target",
      generation: 1,
      sequence: 1,
    };
    const { sent } = run([
      ...snapshot,
      { type: "cursor", event: { op: "show", identity: owner, phase: "thinking" } },
      call("direct", "click", { ...WINDOW, x: 50, y: 50 }),
      reply("direct"),
    ]);
    assert.deepEqual(sent[3], [
      { op: "show", pid: 42, windowId: 7, point: { fx: 0.05, fy: 0.1 }, phase: "acting" },
    ]);
    assert.deepEqual(sent[4], [
      { op: "show", pid: 42, windowId: 7, point: { fx: 0.05, fy: 0.1 }, phase: "resting" },
    ]);
  });

  it("hides the overlay through settle sampling and uses that window's fresh pixel frame", () => {
    const { sent, state } = run([
      ...snapshot,
      call("c", "click", WINDOW),
      reply("c"),
      call("settle", "wait_for_window_settle"),
      reply("settle", { width: 2000, height: 1000 }),
      call("next", "click", { ...WINDOW, x: 1000, y: 500 }),
    ]);
    assert.deepEqual(sent[4], [{ op: "hide", reason: "capture" }]);
    assert.deepEqual(state.shown, {
      op: "show",
      pid: 42,
      windowId: 7,
      point: { fx: 0.5, fy: 0.5 },
      phase: "acting",
    });
  });

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
    // Hidden until the driver confirms the recording stopped; a failed stop keeps it hidden.
    const stopping = run([call("r2", "stop_recording", {})], recording.state).state;
    assert.deepEqual(stopping.shown, { op: "hide", reason: "capture" });
    assert.deepEqual(run([{ type: "reply", id: "r2", failed: true }], stopping).state.shown, {
      op: "hide",
      reason: "capture",
    });
    assert.equal(run([reply("r2")], stopping).state.shown?.op, "show");
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
