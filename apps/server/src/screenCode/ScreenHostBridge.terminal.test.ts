import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { EnvironmentId, ProviderInstanceId, ThreadId, type ScreenHostCall } from "@goat/contracts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

const context = () => ({
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits(),
  invocation: {
    environmentId: EnvironmentId.make("env"),
    capabilities: new Set<"preview">(),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId: ThreadId.make("thread"),
      providerSessionId: "s",
      providerInstanceId: ProviderInstanceId.make("p"),
    },
  },
});
const call = (callId: number): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId,
  method: "click",
  args: {},
  deadlineMillis: 60000,
});

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "a terminal %s fence keeps its reason for an in-flight read",
  (reason) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const { targetRef: _targetRef, ...base } = call(1);
      const pending = yield* bridge
        .handle({ ...base, method: "list_apps" }, context())
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      bridge.cutCellNow("r", "t", "c", reason);
      const answer = yield* Fiber.join(pending);
      expect(answer?.outcome).toBe("error");
      if (answer?.outcome === "error") {
        expect(answer.error?.code).toBe(reason);
        expect(answer.error?.safety?.retryClass).toBe("never");
      }
    }),
);

it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "a terminal %s fence refuses a call that arrives after the cutoff",
  (reason) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      bridge.cutCellNow("r", "t", "c", reason);
      const answer = yield* bridge.handle(call(1), context());
      expect(answer?.outcome).toBe("error");
      if (answer?.outcome === "error") {
        expect(answer.error?.code).toBe(reason);
        expect(answer.error?.safety?.retryClass).toBe("never");
      }
    }),
);
