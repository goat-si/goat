import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";

const decodeStored = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeStored = Schema.encodeSync(OrchestrationV2TurnItemJson);

const reply = {
  id: "item-reply",
  type: "assistant_message",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  status: "completed",
  title: null,
  messageId: "message-reply",
  text: "Done",
  streaming: false,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-11-17T00:00:00.000Z",
};

describe("an assistant message's phase", () => {
  it("survives storage and the wire", () => {
    const stored = { ...reply, phase: "final_answer" };
    const sent = decodeStored(JSON.parse(JSON.stringify(encodeStored(decodeStored(stored)))));
    expect(sent.type === "assistant_message" ? sent.phase : undefined).toBe("final_answer");
  });

  it("is absent on rows from before it, and a phase this build does not know reads as absent", () => {
    const old = decodeStored(reply);
    expect(old.type === "assistant_message" ? old.phase : "missing").toBeUndefined();
    const newer = decodeStored({ ...reply, phase: "summary_from_a_newer_server" });
    expect(newer.type === "assistant_message" ? newer.phase : "missing").toBeUndefined();
    expect(newer).toMatchObject({ text: "Done" });
  });

  it("is dropped, not refused, by a decoder from before the field", () => {
    const olderReply = Schema.Struct({
      type: Schema.Literal("assistant_message"),
      text: Schema.String,
    });
    expect(Schema.decodeUnknownSync(olderReply)({ ...reply, phase: "final_answer" })).toEqual({
      type: "assistant_message",
      text: "Done",
    });
  });
});
