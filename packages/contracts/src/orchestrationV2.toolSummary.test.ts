import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";

const decodeStored = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeStored = Schema.encodeSync(OrchestrationV2TurnItemJson);

const row = {
  id: "cell-row",
  type: "dynamic_tool",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: "Terminal · type, press Enter",
  toolName: "goat.goat_screen_run",
  input: { code: "..." },
  toolSummary: "2 confirmed · 820 ms",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-10-29T00:00:00.000Z",
};

describe("a tool row's summary", () => {
  it("survives storage and the wire", () => {
    const sent = decodeStored(JSON.parse(JSON.stringify(encodeStored(decodeStored(row)))));
    expect(sent.type === "dynamic_tool" ? sent.toolSummary : undefined).toBe(row.toolSummary);
  });

  it("is dropped, not refused, by a decoder that doesn't know the field", () => {
    // Turn items decode without onExcessProperty: "error", so a client from before toolSummary
    // reads a row carrying it as this build reads a field from a newer server.
    const decoded = decodeStored({ ...row, summaryFromANewerServer: "x" });
    expect(decoded).not.toHaveProperty("summaryFromANewerServer");
    expect(decoded).toMatchObject({ title: row.title });
  });
});
