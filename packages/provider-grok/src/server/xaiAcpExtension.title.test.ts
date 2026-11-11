import { describe, expect, it } from "vite-plus/test";

import { normalizeXAiAcpToolCallState } from "./xaiAcpExtension.ts";

const bashCall = (command: string) => ({
  toolCallId: "call-title",
  title: "Tool",
  status: "completed" as const,
  data: { rawInput: {}, rawOutput: { type: "Bash", command } },
});

describe("XAiAcpExtension command titles", () => {
  it("cuts a long command title without splitting a surrogate pair", () => {
    const command = `git commit -m "${"x".repeat(61)}🎉 ship it"`;
    expect(normalizeXAiAcpToolCallState(bashCall(command)).title).toBe(
      `git commit -m "${"x".repeat(61)}...`,
    );
  });

  it("keeps a surrogate pair that starts before the cut", () => {
    const command = `git commit -m "${"x".repeat(59)}🎉 ship it"`;
    expect(normalizeXAiAcpToolCallState(bashCall(command)).title).toBe(
      `git commit -m "${"x".repeat(59)}🎉 ...`,
    );
  });
});
