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

it.effect("a read rejected after dispatch has failure safety in its reply and receipt", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.succeed({
          value: "x".repeat(1000),
          category: "confirmed" as const,
          evidence: ["read:completed"],
          safety: classifyActionOutcome({ effect: "read", status: "completed" }),
        }),
    });
    const live = context();
    const reply = yield* bridge.handle(call(1), {
      ...live,
      limits: { ...live.limits, returnBytes: 100 },
    });
    expect(reply?.error?.safety).toMatchObject({
      code: "read_indeterminate",
      possibleCommit: false,
    });
    const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
    expect(journal[0]?.receipt.safety).toMatchObject({
      code: "read_indeterminate",
      possibleCommit: false,
    });
  }),
);
