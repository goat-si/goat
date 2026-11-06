import { describe, expect, it } from "vite-plus/test";
import { createNoteImageStore } from "./note-editor-images";
import { parseNoteEditorMessage, type NoteEditorOutbound } from "./note-editor-protocol";

function setup() {
  const posted: NoteEditorOutbound[] = [];
  const pending: Array<() => void> = [];
  const store = createNoteImageStore(
    (message) => posted.push(message),
    (run) => pending.push(run),
  );
  const flush = () => {
    for (const run of pending.splice(0)) run();
  };
  return { store, posted, flush };
}
const href = (index: number) => `/.attachments/${index.toString(16).padStart(16, "0")}.png`;

describe("note image store", () => {
  it("asks once per href, in batches the protocol accepts, and stops at 200 images", () => {
    const { store, posted, flush } = setup();
    for (let index = 0; index < 260; index++) store.url(href(index));
    store.url(href(0));
    flush();
    expect(
      posted.map((message) => (message.type === "resolveImages" ? message.hrefs.length : 0)),
    ).toEqual([50, 50, 50, 50]);
    for (const message of posted)
      expect(parseNoteEditorMessage(JSON.stringify(message))).toEqual(message);
  });

  it("shows URLs it asked for and ignores the rest", () => {
    const { store, flush } = setup();
    expect(store.url(href(1))).toBeNull();
    flush();
    expect(store.receive({ [href(1)]: "https://hub/a", [href(2)]: "https://hub/b" }, [])).toBe(
      true,
    );
    expect(store.url(href(1))).toBe("https://hub/a");
    expect(store.receive({}, [href(9)])).toBe(false);
  });

  it("renews an image that stops loading once per URL, then shows its label", () => {
    const { store, posted, flush } = setup();
    store.url(href(1));
    flush();
    store.receive({ [href(1)]: "https://hub/a" }, []);
    expect(store.failed(href(1))).toBe(true);
    expect(posted.at(-1)).toEqual({ type: "resolveImages", hrefs: [href(1)], renew: true });
    // The app answered with the same URL (not an expiry): a second failure stops asking.
    store.receive({ [href(1)]: "https://hub/a" }, []);
    expect(store.failed(href(1))).toBe(true);
    expect(posted).toHaveLength(2);
    expect(store.url(href(1))).toBeNull();
    // A freshly minted URL after a reconnect gets its own renewal.
    store.receive({ [href(1)]: "https://hub/b" }, []);
    expect(store.failed(href(1))).toBe(true);
    expect(posted).toHaveLength(3);
  });

  it("never asks again for an image the app reported missing", () => {
    const { store, posted, flush } = setup();
    store.url(href(1));
    flush();
    expect(store.receive({}, [href(1)])).toBe(true);
    store.url(href(1));
    flush();
    expect(posted).toHaveLength(1);
  });
});

describe("resolveImages messages", () => {
  const parse = (value: unknown) => parseNoteEditorMessage(JSON.stringify(value));
  it("accepts bounded string lists and drops duplicates", () => {
    expect(parse({ type: "resolveImages", hrefs: ["a", "a", "b"], renew: false })).toEqual({
      type: "resolveImages",
      hrefs: ["a", "b"],
      renew: false,
    });
  });
  it("rejects malformed or oversized requests", () => {
    for (const value of [
      { type: "resolveImages", hrefs: [], renew: false },
      {
        type: "resolveImages",
        hrefs: Array.from({ length: 51 }, (_, index) => String(index)),
        renew: false,
      },
      { type: "resolveImages", hrefs: [1], renew: false },
      { type: "resolveImages", hrefs: ["x".repeat(2049)], renew: false },
      { type: "resolveImages", hrefs: ["a"] },
      { type: "resolveImages", hrefs: "a", renew: false },
    ])
      expect(parse(value)).toBeNull();
  });
});
