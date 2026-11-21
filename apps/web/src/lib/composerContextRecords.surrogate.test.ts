import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { responseContextRecord } from "./composerContextRecords";

it("does not split a surrogate pair at the reply label boundary", () => {
  const text = `${"x".repeat(63)}😀`;
  const record = responseContextRecord({
    citation: {
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text,
      start: 0,
      end: text.length,
      prefix: "",
      suffix: "",
    },
    itemId: TurnItemId.make("item"),
    subagents: [],
  });
  expect(record.label).toBe("x".repeat(63));
});
