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
