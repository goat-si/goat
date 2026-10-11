import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ChannelReceptionAction, ChannelReceptionResult } from "./index.ts";

const decode = Schema.decodeUnknownSync(ChannelReceptionResult);
const decodeAction = Schema.decodeUnknownSync(ChannelReceptionAction);

describe("reception results", () => {
  it("decodes each action the model may choose", () => {
    for (const action of [
      { type: "create_task", title: "Re-verify", instruction: "Run it again." },
      { type: "status", taskId: "task-1" },
      { type: "answer_question", taskId: "task-1", questionId: "q-1", answer: "Use main." },
      { type: "clarify", question: "Which project?" },
      { type: "report_only" },
    ]) {
      expect(decode({ replyText: "Okay.", action })).toEqual({ replyText: "Okay.", action });
    }
  });

  it("rejects actions outside the contract and empty replies", () => {
    expect(() =>
      decode({ replyText: "Okay.", action: { type: "run_shell", command: "ls" } }),
    ).toThrow();
    expect(() => decode({ replyText: "  ", action: { type: "report_only" } })).toThrow();
    expect(() =>
      decodeAction({
        type: "answer_question",
        taskId: "task-1",
      }),
    ).toThrow();
  });
});
