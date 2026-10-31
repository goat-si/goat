import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenHostCall, ThreadId } from "@goat/contracts";
import { ScreenHostBridge, type ScreenHostContext } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = () =>
  ({
    runId: "r",
    turnId: "t",
    cellId: "c",
    threadId: "thread",
    environmentId: "env",
    limits: screenRunLimits(),
    invocation: { thread: { threadId: "thread" as ThreadId } },
  }) as ScreenHostContext;
const tab = {
  id: "target",
  kind: "tab" as const,
  environmentId: "env",
  runId: "r",
  turnId: "t",
  generation: 0,
};
const call = (callId: number): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  targetRef: tab,
  method: "click",
  args: {},
  deadlineMillis: 60_000,
});

it.effect(
  "observation evidence stays in the receipt when the reply line exceeds its size limit",
  () =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const app = { ...tab, kind: "app" as const };
      const observation = {
        mode: "diff",
        baseObservationId: "before",
        indexedText: '~ AXStaticText = "8"',
      };
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: (request) =>
          Effect.succeed(
            request.method === "click"
              ? {
                  category: "unverifiable" as const,
                  observedWindow: "42:7",
                  observedBaseline: "before",
                }
              : { category: "unverifiable" as const, observedWindow: "42:7", value: observation },
          ),
      });
      const ctx = {
        ...context(),
        limits: {
          ...context().limits,
          returnBytes: Buffer.byteLength(JSON.stringify(observation)),
        },
      };
      expect((yield* bridge.handle({ ...call(1), targetRef: app }, ctx))?.outcome).toBe("ok");
      const reply = yield* bridge.handle(
        { ...call(2), targetRef: app, method: "get_accessibility_tree" },
        ctx,
      );
      expect(reply?.outcome).toBe("ok");
      expect(reply?.value).toEqual(observation);
      const receipt = bridge
        .takeCellImagesNow("r", "t", "c")
        .journal.find((entry) => entry.receipt.method === "click")?.receipt;
      expect(receipt?.observedEffect).toEqual({
        state: "change_seen",
        rows: ['~ AXStaticText = "8"'],
      });
    }),
);
