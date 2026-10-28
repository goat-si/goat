import {
  CommandId,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLifecycleMcpService from "../../ThreadLifecycleMcpService.ts";
import { KeyedClientRequestId, withClientRequestId } from "../keyedParameters.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadLifecycleMcpService.ThreadLifecycleMcpService,
  ],
};
const target = ThreadId.annotate({
  description:
    "Target thread in this environment. Other projects are allowed; permission modes cannot exceed the caller's.",
});
const accepted = Schema.Struct({
  accepted: Schema.Literal(true),
  commandId: CommandId,
  sequence: NonNegativeInt,
});
const receiptInput = Schema.Struct({
  clientRequestId: KeyedClientRequestId.annotate({
    description:
      "Original lifecycle request key. Only this thread or outside-client session in this environment can read it. Missing may mean expired.",
  }),
});
const receiptResult = Schema.Struct({
  state: Schema.Literals(["completed", "in_progress", "unknown", "missing"]),
  commandStatus: Schema.optional(Schema.NullOr(Schema.Literals(["accepted", "rejected"]))),
  result: Schema.optional(McpSchema.CallToolResult),
  failure: Schema.optional(
    Schema.Struct({ _tag: Schema.String, code: Schema.optional(Schema.String) }),
  ),
});
const resume = agentSurfaceRegistry["queue.resume"];
const start = agentSurfaceRegistry["queued_run.start"];
const remove = agentSurfaceRegistry["thread.delete"];
const detach = agentSurfaceRegistry["provider_session.detach"];
const queueReceipt = agentSurfaceRegistry["queue.receipt"];
const runReceipt = agentSurfaceRegistry["queued_run.receipt"];
const threadReceipt = agentSurfaceRegistry["thread.lifecycle_receipt"];
const sessionReceipt = agentSurfaceRegistry["provider_session.receipt"];
export const ThreadLifecycleToolkit = Toolkit.make(
  Tool.make(resume.name, {
    ...common,
    description: resume.description,
    parameters: withClientRequestId(Schema.Struct({ threadId: Schema.optional(target) })),
    success: accepted,
  }).annotateMerge(agentSurfaceAnnotations(resume)),
  Tool.make(start.name, {
    ...common,
    description: start.description,
    parameters: withClientRequestId(
      Schema.Struct({
        threadId: Schema.optional(target),
        queuedRunId: RunId.annotate({
          description:
            "Selected queued user run from queue.list; stale or active selections are refused.",
        }),
      }),
    ),
    success: accepted,
  }).annotateMerge(agentSurfaceAnnotations(start)),
  Tool.make(remove.name, {
    ...common,
    description: remove.description,
    parameters: withClientRequestId(Schema.Struct({ threadId: target })),
    success: accepted,
  }).annotateMerge(agentSurfaceAnnotations(remove)),
  Tool.make(detach.name, {
    ...common,
    description: detach.description,
    parameters: withClientRequestId(
      Schema.Struct({
        threadId: target,
        providerSessionId: ProviderSessionId.annotate({
          description:
            "Explicit provider session owned by the target thread. A live session will disconnect after acceptance.",
        }),
      }),
    ),
    success: accepted,
  }).annotateMerge(agentSurfaceAnnotations(detach)),
  Tool.make(queueReceipt.name, {
    ...common,
    description: queueReceipt.description,
    parameters: receiptInput,
    success: receiptResult,
  }).annotateMerge(agentSurfaceAnnotations(queueReceipt)),
  Tool.make(runReceipt.name, {
    ...common,
    description: runReceipt.description,
    parameters: receiptInput,
    success: receiptResult,
  }).annotateMerge(agentSurfaceAnnotations(runReceipt)),
  Tool.make(threadReceipt.name, {
    ...common,
    description: threadReceipt.description,
    parameters: receiptInput,
    success: receiptResult,
  }).annotateMerge(agentSurfaceAnnotations(threadReceipt)),
  Tool.make(sessionReceipt.name, {
    ...common,
    description: sessionReceipt.description,
    parameters: receiptInput,
    success: receiptResult,
  }).annotateMerge(agentSurfaceAnnotations(sessionReceipt)),
);
