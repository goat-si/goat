import { DEFAULT_MAX_TERMINAL_BUFFER_BYTES } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH,
  MAX_PENDING_HISTORY_ESCAPE_SEQUENCE_LENGTH,
  sanitizeTerminalHistoryChunk,
} from "./terminalHistoryReplay.ts";

const CAP = MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH;

// Feeds chunks as the manager does and records what history keeps.
function historyFeed() {
  let pending = "";
  let visible = "";
  return {
    feed(...chunks: string[]) {
      for (const data of chunks) {
        const result = sanitizeTerminalHistoryChunk(pending, data);
        pending = result.pendingControlSequence;
        visible += result.visibleText;
        // Nothing over the cap is held between chunks.
        expect(pending.length).toBeLessThanOrEqual(CAP);
      }
    },
    get pending() {
      return pending;
    },
    get visible() {
      return visible;
    },
  };
}

// Just over the cap, in 64 KiB chunks.
function overCap(start: string, unit: string): string[] {
  const payload = unit.repeat(Math.ceil((CAP + 1 - start.length) / unit.length));
  const chunks = [start];
  for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
    chunks.push(payload.slice(offset, offset + 64 * 1024));
  }
  return chunks;
}

it.each([
  ["an OSC ended by BEL", "\u001b]1337;File=:", "QUJD", "\u0007"],
  ["an OSC ended by ST", "\u001b]52;c;", "QUJD", "\u001b\\"],
  ["a DCS ended by ST", "\u001bPq", "#0;2;0;0;0~", "\u001b\\"],
  ["a CSI ended by its final byte", "\u001b[", "1;", "m"],
])(
  "swallows the rest of %s past the pending cap, then keeps what follows",
  (_, start, unit, end) => {
    const history = historyFeed();
    history.feed("before", ...overCap(start, unit), unit.repeat(1000), end + "after\n");
    expect(history.visible).toBe("beforeafter\n");
    expect(history.pending).toBe("");
  },
);

it.each([
  ["OSC", "\u001b]1337;File=:", "QUJD"],
  ["DCS", "\u001bPq", "#0;2;0;0;0~"],
])("ends a swallowed %s at an ST split across chunks", (_, start, unit) => {
  const history = historyFeed();
  history.feed("before", ...overCap(start, unit), unit + "\u001b", "\\after\n");
  expect(history.visible).toBe("beforeafter\n");
  expect(history.pending).toBe("");
});

it("keeps the sequence that an ESC starts after a swallowed one, also across chunks", () => {
  const history = historyFeed();
  history.feed(...overCap("\u001b]1337;File=:", "QUJD"), "QUJD\u001b[31mred\n");
  history.feed(...overCap("\u001bPq", "?"), "??\u001b", "[0mplain\n");
  expect(history.visible).toBe("\u001b[31mred\n\u001b[0mplain\n");
  expect(history.pending).toBe("");
});

it("swallows everything after a sequence that never terminates, as a terminal shows nothing", () => {
  const history = historyFeed();
  history.feed("before", ...overCap("\u001b]1337;File=:", "QUJD"));
  for (let index = 0; index < 48; index += 1) history.feed("x".repeat(64 * 1024) + "\nline\n");
  expect(history.visible).toBe("before");
  expect(history.pending.length).toBeLessThan(16);
});

it("keeps a sequence exactly at the pending cap whole", () => {
  const start = "\u001b]0;";
  const payload = "t".repeat(CAP - start.length);
  const history = historyFeed();
  history.feed(start, payload);
  expect(history.pending.length).toBe(CAP);
  history.feed("\u0007after");
  expect(history.visible).toBe(start + payload + "\u0007after");
});

it("retains text after an unfinished OSC is interrupted by a new escape across chunks", () => {
  const first = sanitizeTerminalHistoryChunk("", "\u001b]0;unfinished\u001b");
  expect(first.pendingControlSequence).not.toBe("");
  const second = sanitizeTerminalHistoryChunk(
    first.pendingControlSequence,
    "\u001b[?2026$pvisible\n",
  );
  expect(second.visibleText).toContain("visible\n");
  expect(second.visibleText).not.toContain("?2026$p");
  expect(second.pendingControlSequence).toBe("");
});

it("keeps C1 Unicode characters as text, including beside escape sequences", () => {
  const input = "café â€\u009d Ð\u0090 \u009e\u009f\u009b6n \u001b[31mvisible";
  const result = sanitizeTerminalHistoryChunk("", input);
  expect(result.visibleText).toBe(input);
  expect(result.pendingControlSequence).toBe("");
  expect(sanitizeTerminalHistoryChunk("", "trailing \u009d").visibleText).toBe("trailing \u009d");
});

it.each([
  { name: "NUL in DA", data: "A\u001b[0\u0000cB", history: "AB" },
  { name: "DEL in DA", data: "A\u001b[0\u007fcB", history: "AB" },
  { name: "NUL in DECRQM", data: "A\u001b[?2026\u0000$pB", history: "AB" },
  { name: "CR in DSR", data: "AB\u001b[5\rnC", history: "AB\rC" },
  { name: "DLE in DSR", data: "AB\u001b[5\u0010nC", history: "ABC" },
])(
  "strips a query with an embedded control but keeps what the terminal ran ($name)",
  ({ data, history }) => {
    expect(sanitizeTerminalHistoryChunk("", data).visibleText.replaceAll("\u0000", "")).toBe(
      history,
    );
  },
);

it("keeps decoded U+009C inside a stripped OSC query out of history", () => {
  const input = "A\u001b]11;?\u009cHIDDEN\u001b\\B\nC\u001bP$qm\u009cSHOWN\u001b\\D\n";
  expect(sanitizeTerminalHistoryChunk("", input).visibleText).toBe("AB\nCSHOWN\u001b\\D\n");
});

it.each([
  { name: "é in DA", data: "A\u001b[0écB", history: "AB" },
  { name: "DECID byte in a CSI", data: "A\u001b[嚠B", history: "A\ufffdB" },
  { name: "C1 DCS then C1 CSI", data: "A\u001b[\u0090\u009b6nB", history: "A\u001bP\u009cB" },
  { name: "ESC in DSR", data: "A\u001b[5\u001b[6nB", history: "AB" },
  { name: "non-ASCII text", data: "A\u001b[界nB", history: "A\u001b[界nB" },
])(
  "preserves text and strips terminal queries after a CSI interruption ($name)",
  ({ data, history }) => {
    expect(sanitizeTerminalHistoryChunk("", data).visibleText).toBe(history);
  },
);

it.each([
  ["CSI", "\u001b[", "1;", "m"],
  ["plain escape", "\u001b", " ", "0"],
])(
  "stops holding an unfinished %s after its own limit, fed in 1 KiB chunks",
  (_, start, unit, end) => {
    const history = historyFeed();
    const payload = unit.repeat((2 * MAX_PENDING_HISTORY_ESCAPE_SEQUENCE_LENGTH) / unit.length);
    history.feed("before", start);
    for (let offset = 0; offset < payload.length; offset += 1024) {
      history.feed(payload.slice(offset, offset + 1024));
      expect(history.pending.length).toBeLessThanOrEqual(
        MAX_PENDING_HISTORY_ESCAPE_SEQUENCE_LENGTH,
      );
    }
    history.feed(end + "after\n");
    expect(history.visible).toBe("beforeafter\n");
    expect(history.pending).toBe("");
  },
);

it("keeps a CSI just under its limit whole", () => {
  const csi = "\u001b[" + "1".repeat(MAX_PENDING_HISTORY_ESCAPE_SEQUENCE_LENGTH - 3) + "m";
  const history = historyFeed();
  history.feed(csi.slice(0, 1024), csi.slice(1024, 3000), csi.slice(3000), "after");
  expect(history.visible).toBe(csi + "after");
});

it("swallows a sequence longer than the client replay window, which no client could replay", () => {
  // The window is UTF-8 bytes and the cap UTF-16 units; image and sixel payloads are ASCII.
  const history = historyFeed();
  const start = "\u001b]1337;File=:";
  history.feed(
    "before",
    start,
    "QUJD".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES / 4),
    "\u0007after\n",
  );
  expect(history.visible).toBe("beforeafter\n");
});

it("ends a swallowed DCS at a C1 code point whose surrogate pair is split across chunks", () => {
  // U+10000's UTF-8 bytes run as C1 controls inside a DCS: 0x90 then 0x80, which ends it.
  const history = historyFeed();
  history.feed("before", ...overCap("\u001bPq", "?"), "\ud800", "\udc00after\n");
  expect(history.visible).toBe("before\u001b@\ufffdafter\n");
  expect(history.pending).toBe("");
});
