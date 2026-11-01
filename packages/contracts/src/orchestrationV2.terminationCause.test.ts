import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2RunJson } from "./orchestrationV2.ts";

const decodeMemoryRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
const encodeMemoryRun = Schema.encodeSync(OrchestrationV2RunJson);

it("round-trips optional termination cause and accepts legacy run JSON", () => {
  const legacy = {
    id: "run-termination",
    threadId: "thread-termination",
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "test" },
    providerThreadId: null,
    userMessageId: "message-termination",
    rootNodeId: null,
    activeAttemptId: null,
    status: "failed",
    requestedAt: "2026-10-15T00:00:00.000Z",
    startedAt: null,
    completedAt: "2026-10-15T00:00:01.000Z",
    checkpointId: null,
    contextHandoffId: null,
  };
  expect(encodeMemoryRun(decodeMemoryRun(legacy))).not.toHaveProperty("terminationCause");
  for (const kind of ["validation_error", "preparation_failed", "quota", "provider_process_exit"]) {
    const caused = { ...legacy, terminationCause: { kind } };
    expect(encodeMemoryRun(decodeMemoryRun(caused))).toEqual(caused);
  }
});
