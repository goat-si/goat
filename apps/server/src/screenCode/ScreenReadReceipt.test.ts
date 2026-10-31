import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = () => ({
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits({}),
  invocation: {
    environmentId: "env" as never,
    capabilities: new Set(["preview" as const]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: "thread" as never,
      providerSessionId: "s",
      providerInstanceId: "p" as never,
    },
    reauthorize: () => Effect.void,
  },
});
const call = (callId: number) => ({
  t: "call" as const,
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  targetRef: {
    id: "target",
    kind: "tab" as const,
    environmentId: "env",
    runId: "r",
    turnId: "t",
    generation: 0,
  },
  method: "observe" as const,
  args: {},
  deadlineMillis: 60000,
});

it.effect("completed and cut reads leave a cell running without possible commits", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([{ kind: "tab", available: true }]),
      dispatch: (request) =>
        Effect.succeed({
          value: "readable",
          category: request.callId === 1 ? ("confirmed" as const) : ("unverifiable" as const),
          evidence: [request.callId === 1 ? "read:completed" : "read:cut"],
          safety: classifyActionOutcome({
            effect: "read",
            status: request.callId === 1 ? "completed" : "partial",
          }),
        }),
    });
    for (const id of [1, 2, 3]) {
      const reply = yield* bridge.handle({ ...call(id), method: "observe" }, context());
      expect(reply?.outcome).toBe("ok");
    }
    const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
    expect(journal.map(({ receipt }) => receipt.safety?.code)).toEqual([
      "read_completed",
      "read_indeterminate",
      "read_indeterminate",
    ]);
    expect(journal.every(({ receipt }) => receipt.safety?.possibleCommit === false)).toBe(true);
  }),
);
