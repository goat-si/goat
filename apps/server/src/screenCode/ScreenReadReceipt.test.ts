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

it.effect.each(["invalid image", "oversized image reply"] as const)(
  "%s has failure safety in both reply and receipt",
  (kind) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const metadata = {
        imageRef: "i",
        callId: 1,
        targetId: "target",
        observationId: "o",
        regionId: "g",
        region: { kind: "viewport" as const, x: 0, y: 0, width: 1, height: 1 },
        pixelWidth: 1,
        pixelHeight: 1,
        scale: 1,
        mimeType: "image/png" as const,
      };
      const image = {
        ...metadata,
        callId: kind === "invalid image" ? 2 : 1,
        bytes: Buffer.from("png").toString("base64"),
      };
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.succeed({
            value: { text: "x".repeat(1000) },
            image,
            imageMetadata: metadata,
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
      expect(reply?.outcome).toBe("error");
      expect(reply?.error?.safety).toMatchObject({
        code: "read_indeterminate",
        possibleCommit: false,
      });
      const journal = (yield* bridge.takeCellImages("r", "t", "c")).journal;
      expect(journal[0]?.receipt).toMatchObject({
        category: "refused",
        safety: { code: "read_indeterminate", possibleCommit: false },
      });
    }),
);
