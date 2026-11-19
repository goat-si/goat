import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { providerFailureFromResult } from "./ClaudeResultFailure.ts";
import { makeResultFrame } from "./ClaudeWakeFrames.testkit.ts";

it("uses the outer gateway cooldown after a nested last error", () => {
  const message = makeResultFrame({
    uuid: "cooldown",
    result:
      "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last error: upstream (reset after 1h)) (reset after 2m)",
    terminalReason: "api_error",
    isError: true,
    apiErrorStatus: 429,
  });
  if (message.type !== "result") throw new Error("Expected a result frame");
  expect(
    providerFailureFromResult(message, DateTime.makeUnsafe("2026-11-20T00:00:00.000Z"))?.resetAt,
  ).toBe("2026-11-20T00:02:00.000Z");
});
