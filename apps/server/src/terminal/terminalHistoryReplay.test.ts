import { expect, it } from "vite-plus/test";
import { sanitizeTerminalHistoryChunk } from "./terminalHistoryReplay.ts";

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
