import { describe, expect, it } from "vite-plus/test";
import { NoteEditorBridge } from "./note-editor-bridge";

const change = (
  seq: number,
  changes: Array<[number, number, string]>,
  length: number,
  generation = 0,
) => ({ type: "change", generation, seq, changes, length, checkbox: false }) as const;
const doc = (seq: number, text: string, checkboxSeqs: number[] = [], id = 1, generation = 0) =>
  ({ type: "doc", id, generation, seq, doc: text, checkboxSeqs }) as const;
const requestDoc = (id = 1) => ({ send: { type: "requestDoc", id } });

describe("note editor bridge keeps React Native's copy equal to the page", () => {
  it("applies numbered edits in order", () => {
    const bridge = new NoteEditorBridge("ab");
    expect(bridge.receive(change(1, [[1, 1, "x"]], 3))).toEqual({
      value: { text: "axb", checkbox: false },
    });
    expect(bridge.receive(change(2, [[3, 3, "!"]], 4)).value?.text).toBe("axb!");
  });

  it("asks for the whole text when an equal-length edit goes missing", () => {
    const bridge = new NoteEditorBridge("abc");
    bridge.receive(change(1, [[0, 1, "X"]], 3));
    // seq 2 ([1,2,"Y"]) is lost; seq 3 has the same length and would silently diverge.
    expect(bridge.receive(change(3, [[2, 3, "Z"]], 3))).toEqual(requestDoc());
    expect(bridge.receive(doc(3, "XYZ")).value?.text).toBe("XYZ");
    expect(bridge.receive(change(4, [[3, 3, "."]], 4)).value?.text).toBe("XYZ.");
  });

  it("replays edits the page made after its snapshot", () => {
    const bridge = new NoteEditorBridge("abc");
    expect(bridge.receive(change(2, [[0, 0, "?"]], 4))).toEqual(requestDoc());
    expect(bridge.pending).toBe(true);
    // The page snapshots at seq 3, then edits again (seq 4) before the snapshot arrives.
    expect(bridge.receive(change(4, [[3, 3, "!"]], 4))).toEqual({});
    expect(bridge.receive(doc(3, "XYZ")).value?.text).toBe("XYZ!");
    expect(bridge.pending).toBe(false);
    expect(bridge.receive(change(5, [[4, 4, "."]], 5)).value?.text).toBe("XYZ!.");
  });

  it("asks again when a snapshot reply seems lost", () => {
    const bridge = new NoteEditorBridge("");
    bridge.receive(change(2, [[0, 0, "x"]], 1));
    const receipts = Array.from({ length: 100 }, (_, index) =>
      bridge.receive(change(index + 3, [[0, 0, "x"]], index + 1)),
    );
    expect(receipts.at(-1)).toEqual(requestDoc());
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
    expect(bridge.receive(change(2, [[2, 2, "c"]], 3))).toEqual({});
    expect(bridge.receive(change(1, [[3, 3, "!"]], 4, 1)).value?.text).toBe("hub!");
  });
  it("saves a recovered checkbox tap as a checkbox tap, and anything mixed as an edit", () => {
    const tap = new NoteEditorBridge("- [ ] a\n- [ ] b");
    // seq 1 (a checkbox tap) is lost; seq 2 (another tap) arrives and triggers a resync.
    expect(tap.receive({ ...change(2, [[11, 12, "x"]], 15), checkbox: true })).toEqual(
      requestDoc(),
    );
    expect(tap.receive(doc(2, "- [x] a\n- [x] b", [1, 2]))).toEqual({
      value: { text: "- [x] a\n- [x] b", checkbox: true },
    });
    const typed = new NoteEditorBridge("- [ ] a");
    expect(typed.receive(change(2, [[7, 7, "!"]], 8))).toEqual(requestDoc());
    expect(typed.receive(doc(2, "- [x] a!", [1])).value).toEqual({
      text: "- [x] a!",
      checkbox: false,
    });
  });

  it("reports nothing when a snapshot matches the copy it already had", () => {
    const bridge = new NoteEditorBridge("same");
    bridge.receive(change(2, [[0, 0, "x"]], 5));
    expect(bridge.receive(doc(2, "same"))).toEqual({});
    expect(bridge.pending).toBe(false);
  });
  it("ignores a late reply to an earlier recovery, so it cannot roll the copy back", () => {
    const bridge = new NoteEditorBridge("a");
    expect(bridge.receive(change(2, [[1, 1, "c"]], 2))).toEqual(requestDoc(1));
    // The page answers twice (a retry); the first answer ends recovery 1.
    expect(bridge.receive(doc(2, "abc", [], 1)).value?.text).toBe("abc");
    expect(bridge.receive(change(3, [[3, 3, "d"]], 4)).value?.text).toBe("abcd");
    expect(bridge.receive(change(5, [[5, 5, "f"]], 6))).toEqual(requestDoc(2));
    // The retry's late answer to recovery 1 arrives during recovery 2.
    expect(bridge.receive(doc(2, "abc", [], 1))).toEqual({});
    expect(bridge.pending).toBe(true);
    expect(bridge.retry()).toEqual({ type: "requestDoc", id: 2 });
    expect(bridge.receive(doc(5, "abcdef", [], 2)).value?.text).toBe("abcdef");
  });
  it("a save's barrier brings in an edit whose message never arrived", () => {
    const bridge = new NoteEditorBridge("ab");
    expect(bridge.receive(change(1, [[2, 2, "c"]], 3)).value?.text).toBe("abc");
    // seq 2 ("d") is lost and nothing follows it, so no gap is ever seen.
    expect(bridge.barrier()).toEqual({ type: "requestDoc", id: 1 });
    expect(bridge.pending).toBe(true);
    expect(bridge.receive(change(3, [[4, 4, "e"]], 5))).toEqual({});
    expect(bridge.receive(doc(2, "abcd", [], 1)).value?.text).toBe("abcde");
    expect(bridge.pending).toBe(false);
    expect(bridge.text).toBe("abcde");
  });
});
