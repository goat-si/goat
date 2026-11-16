import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpThreadStatusResult,
} from "./orchestratorMcp.ts";

const at = "2026-10-13T01:00:00.000Z";
const newerHostStatus = {
  stop: { state: "unresponsive", since: at },
  threadId: "remote-1",
  title: "Fix the flake",
  phase: "running",
  terminal: false,
  run: null,
  queuedRunId: null,
  pendingRequest: null,
  lastActivityAt: at,
  lastMessage: null,
  lastError: null,
  watch: null,
};

// The status schema as a caller from before the field decodes it.
const { stop: _stop, ...olderFields } = OrchestratorMcpThreadStatusResult.fields;
const decodeOlderStatus = Schema.decodeUnknownSync(Schema.Struct(olderFields));

describe("unanswered Stop on the wire", () => {
  it("lets a caller that predates the field read a newer host's status", () => {
    const older = decodeOlderStatus(newerHostStatus);
    expect(older).not.toHaveProperty("stop");
    expect(older.phase).toBe("running");
  });

  it("lets an origin that predates taskForceStop read a newer host's capabilities", () => {
    const { taskForceStop: _force, ...olderFeatures } =
      OrchestratorMcpCapabilitiesResult.fields.features.fields;
    const decodeOlder = Schema.decodeUnknownSync(
      Schema.Struct({
        ...OrchestratorMcpCapabilitiesResult.fields,
        features: Schema.Struct(olderFeatures),
      }),
    );
    const features = {
      appOwnedSubagents: true,
      asyncPolling: true,
      cancellation: true,
      batchThreadCreation: true,
      threadManagement: true,
      incrementalThreadRead: true,
      scheduledTasks: true,
      maxBatchThreads: 8,
      taskForceStop: true,
    };
    const older = decodeOlder({
      parentThreadId: null,
      inheritedProviderInstanceId: null,
      inheritedModel: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: [],
      features,
    });
    expect(older.features).not.toHaveProperty("taskForceStop");
    expect(older.features.cancellation).toBe(true);
  });
});
