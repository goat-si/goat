import { expect, it } from "vite-plus/test";
import {
  MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH,
  sanitizeTerminalHistoryChunk,
} from "./terminalHistoryReplay.ts";

it.each([
  ["an OSC", "\u001b]0;", "x"],
  ["a DCS", "\u001bPq", "?"],
  ["a CSI", "\u001b[", "1;"],
])("drops %s left unterminated past the pending cap and returns to ground", (_, start, unit) => {
  let pending = "";
  let visible = "";
  const feed = (data: string) => {
    const result = sanitizeTerminalHistoryChunk(pending, data);
    pending = result.pendingControlSequence;
    visible += result.visibleText;
  };
  feed(start);
  // Just over the cap, in the 64 KiB chunks a PTY delivers.
  const payload = unit.repeat(Math.ceil(MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH / unit.length));
  for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
    feed(payload.slice(offset, offset + 64 * 1024));
    expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_HISTORY_CONTROL_SEQUENCE_LENGTH);
  }
  expect(pending).toBe("");
  expect(visible).toBe("");
  feed("after\n");
  expect(visible).toBe("after\n");
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
