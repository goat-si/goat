import { describe, expect, it } from "vite-plus/test";
import { NoteEditorBridge } from "./note-editor-bridge";

const change = (
  seq: number,
  changes: Array<[number, number, string]>,
  length: number,
  generation = 0,
) => ({ type: "change", generation, seq, changes, length, checkbox: false }) as const;

describe("note editor bridge keeps React Native's copy equal to the page", () => {
  it("applies numbered edits in order", () => {
    const bridge = new NoteEditorBridge("ab");
    expect(bridge.receive(change(1, [[1, 1, "x"]], 3))).toEqual({
      kind: "value",
      value: "axb",
      checkbox: false,
    });
    expect(bridge.receive(change(2, [[3, 3, "!"]], 4))).toMatchObject({ value: "axb!" });
  });

  it("asks for the whole text when an equal-length edit goes missing, and ignores edits until it arrives", () => {
    const bridge = new NoteEditorBridge("abc");
    bridge.receive(change(1, [[0, 1, "X"]], 3));
    // seq 2 ([1,2,"Y"]) is lost; seq 3 has the same length and would silently diverge.
    expect(bridge.receive(change(3, [[2, 3, "Z"]], 3))).toEqual({
      kind: "send",
      message: { type: "requestDoc" },
    });
    expect(bridge.receive(change(4, [[0, 0, "q"]], 4)).kind).toBe("ignore");
    expect(bridge.receive({ type: "doc", generation: 0, seq: 4, doc: "qXYZ" })).toMatchObject({
      value: "qXYZ",
    });
    expect(bridge.receive(change(5, [[4, 4, "."]], 5))).toMatchObject({ value: "qXYZ." });
  });

  it("does not mistake a render that lags behind the page for a replacement", () => {
    const bridge = new NoteEditorBridge("a");
    bridge.receive(change(1, [[1, 1, "b"]], 2));
    bridge.receive(change(2, [[2, 2, "c"]], 3));
    expect(bridge.sync("ab")).toBeNull();
    expect(bridge.sync("abc")).toBeNull();
  });

  it("replaces the page text when React holds a value the page never sent, and drops older edits", () => {
    const bridge = new NoteEditorBridge("a");
    bridge.receive(change(1, [[1, 1, "b"]], 2));
    expect(bridge.sync("hub")).toEqual({ type: "setDoc", generation: 1, doc: "hub" });
    expect(bridge.receive(change(2, [[2, 2, "c"]], 3)).kind).toBe("ignore");
    expect(bridge.receive(change(1, [[3, 3, "!"]], 4, 1))).toMatchObject({ value: "hub!" });
  });
});
