import { ProviderInstanceId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeAntigravityAcpAdapterFlavor } from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-background-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  defaultModel: Effect.succeed(undefined),
});

describe("AntigravityAdapterV2 native background tasks", () => {
  it("keeps a backgrounded command pending instead of settling the run at prompt return", () => {
    const sessionId = "664880dc-701a-4ab3-bd22-c00e2e605178";
    const toolCallId = "call_3735298662155955354";
    const ack = {
      toolCallId,
      kind: "execute",
      status: "inProgress" as const,
      data: {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Tool is running as a background task with task id: ${sessionId}/task-60`,
            },
          },
        ],
      },
    };
    assert.equal(flavor.extractBackgroundTaskId?.(ack), `${sessionId}/task-60`);
    assert.isTrue(flavor.isBackgroundCommandTool?.(ack));
    // These two flags keep both the run and the provider session alive for the late result.
    assert.isTrue(flavor.deferFinalizeForBackgroundWork);
    assert.isTrue(flavor.enablePostSettleContinuation);

    const report = {
      ...ack,
      status: "completed" as const,
      data: {
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Task id "${sessionId}/task-60" finished with result:\nCommand exited with code 0.`,
            },
          },
        ],
      },
    };
    assert.deepEqual(flavor.extractBackgroundTaskCompletion?.(report), [
      { taskId: `${sessionId}/task-60`, status: "completed", appendOutput: "" },
    ]);
    assert.isTrue(
      flavor.isProviderWakeNotification?.({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Task id "${sessionId}/task-60" finished with result:\nDone.`,
          },
        },
      } as never),
    );
  });
});
