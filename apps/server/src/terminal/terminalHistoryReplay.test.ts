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
