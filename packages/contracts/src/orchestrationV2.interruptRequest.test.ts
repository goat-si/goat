import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2TurnItem, OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";

const decodeStored = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeStored = Schema.encodeSync(OrchestrationV2TurnItemJson);
const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
const readFromWire = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2TurnItem));

// The interrupt request fields clients, agent readers and servers shipped with before holdsQueue.
const PreHoldInterruptRequest = Schema.Struct({
  type: Schema.Literal("run_interrupt_request"),
  message: Schema.String,
  unresponsiveAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
const decodePreHold = Schema.decodeUnknownSync(PreHoldInterruptRequest);

const request = {
  id: "run-signal:run-1:interrupt-request",
  type: "run_interrupt_request",
  threadId: "thread-1",
  runId: "run-1",
  nodeId: "node-1",
  providerThreadId: "provider-thread-1",
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 4,
  status: "completed",
  title: "Interrupt requested",
  startedAt: "2026-11-16T00:00:00.000Z",
  completedAt: "2026-11-16T00:00:00.000Z",
  updatedAt: "2026-11-16T00:00:00.000Z",
  message: "Stopped by user",
};

describe("an interrupt request that held the queue", () => {
  it("keeps holdsQueue through storage and the wire", () => {
    const stored = decodeStored({ ...request, holdsQueue: true });
    const sent = readFromWire(JSON.parse(JSON.stringify(sendOverWire(stored))));
    for (const item of [decodeStored(encodeStored(stored)), sent]) {
      expect(item.type === "run_interrupt_request" ? item.holdsQueue : undefined).toBe(true);
    }
  });

  it("is read without the field by an older client or agent reader", () => {
    const sent = sendOverWire(decodeStored({ ...request, holdsQueue: true }));
    expect(decodePreHold(sent)).toEqual({ type: request.type, message: request.message });
  });

  it("reads an older server's request, which never carries it, as not holding the queue", () => {
    const item = decodeStored(request);
    expect(item).not.toHaveProperty("holdsQueue");
  });

  it("refuses any value but true", () => {
    expect(() => decodeStored({ ...request, holdsQueue: false })).toThrow();
  });
});
