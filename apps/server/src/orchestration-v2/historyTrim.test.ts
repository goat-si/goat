import { describe, expect, it } from "vite-plus/test";

import { trimHistoryItem, trimHistoryText } from "./historyTrim.ts";

describe("trimHistoryText", () => {
  it("keeps valid UTF-8 within the limit and is a no-op on its own output", () => {
    const text = "시작" + "가나다🙂".repeat(5_000) + "끝";
    const trimmed = trimHistoryText(text, 8192);
    expect(Buffer.byteLength(trimmed, "utf8")).toBeLessThanOrEqual(8192);
    expect(trimmed).not.toContain("\uFFFD");
    expect(trimmed.startsWith("시작") && trimmed.endsWith("끝")).toBe(true);
    expect(trimmed).toMatch(/\n… output trimmed, \d+ KB …\n/u);
    expect(trimHistoryText(trimmed, 8192)).toBe(trimmed);
  });

  it("trims structured tool output as its JSON text and leaves other items alone", () => {
    const output = { rows: Array.from({ length: 2_000 }, (_, index) => ({ index })) };
    const trimmed = trimHistoryItem({ type: "dynamic_tool", output });
    expect(typeof trimmed?.output).toBe("string");
    expect(trimHistoryItem({ type: "assistant_message", text: "x".repeat(20_000) })).toBeNull();
    expect(trimHistoryItem({ type: "command_execution", output: "short" })).toBeNull();
  });
});
