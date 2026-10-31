import { assert, describe, it } from "@effect/vitest";
import { historyTypedText } from "./ComputerUseHistoryText.ts";

describe("computer use history typed text", () => {
  it("retains only the length when the person has not opted in", () => {
    assert.deepEqual(historyTypedText("hello", false, "normal"), { length: 5 });
  });

  it("retains text only for a confirmed normal field after opt-in", () => {
    assert.deepEqual(historyTypedText("hello", true, "normal"), { length: 5, text: "hello" });
    assert.deepEqual(historyTypedText("secret", true, "secure"), { length: 6 });
    assert.deepEqual(historyTypedText("secret", true, "unknown"), { length: 6 });
  });
});
