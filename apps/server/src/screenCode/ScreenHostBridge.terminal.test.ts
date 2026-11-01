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

it.effect.each(["screen_locked", "stopped_by_person"])(
  "a dispatcher terminal reply dominates a cell %s fence",
  (cut) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.suspend(() => {
            bridge.cutCellNow("r", "t", "c", cut);
            return Effect.fail({
              code: cut === "screen_locked" ? "stopped_by_person" : "screen_locked",
              effectStarted: true,
              nextStep: "Do not retry this turn.",
            });
          }),
      });
      const answer = yield* bridge.handle({ ...call(1), method: "launch_app" }, context());
      expect(answer?.outcome).toBe("error");
      if (answer?.outcome === "error") {
        expect(answer.error?.code).toBe("stopped_by_person");
        expect(answer.error?.safety?.retryClass).toBe("never");
        expect(answer.error?.safety?.possibleCommit).toBe(true);
      }
    }),
);

it.effect.each(["lock first", "stop first", "lock then next cell then stop"])(
  "a cell fence keeps person Stop over a lock: %s",
  (order) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      const lockFirst = order !== "stop first";
      bridge.cutCellNow("r", "t", "c", lockFirst ? "screen_locked" : "stopped_by_person");
      if (order === "lock then next cell then stop") {
        bridge.setDispatcher({
          availability: () => Effect.succeed([]),
          dispatch: () => Effect.succeed({ category: "confirmed", value: [] }),
        });
        const later = yield* bridge.handle(
          { ...call(2), cellId: "later", method: "list_apps" },
          { ...context(), cellId: "later" },
        );
        expect(later?.outcome).not.toBe("error");
      }
      bridge.cutCellNow("r", "t", "c", lockFirst ? "stopped_by_person" : "screen_locked");
      const answer = yield* bridge.handle(call(1), context());
      expect(answer?.outcome).toBe("error");
      if (answer?.outcome === "error") {
        expect(answer.error?.code).toBe("stopped_by_person");
        expect(answer.error?.safety?.retryClass).toBe("never");
      }
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () => Effect.succeed({ category: "confirmed", value: [] }),
      });
      const next = yield* bridge.handle(
        { ...call(2), cellId: "new", method: "list_apps" },
        { ...context(), cellId: "new" },
      );
      expect(next?.outcome).not.toBe("error");
    }),
);

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

it.effect("the outbound fence catches a cutoff after the host reply was prepared", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () => Effect.succeed({ category: "confirmed", value: [] }),
    });
    const input = { ...call(1), method: "list_apps" } satisfies ScreenHostCall;
    const answer = yield* bridge.handle(input, context());
    bridge.cutCellNow("r", "t", "c", "stopped_by_person");
    const final = bridge.finalizeReply(answer, input, context());
    expect(final?.outcome).toBe("error");
    expect(final?.error?.code).toBe("stopped_by_person");
    expect(final?.error?.safety?.retryClass).toBe("never");
  }),
);

it.effect.each(["stopped_by_person", "screen_locked"])(
  "a synchronous %s cutoff keeps successful read input evidence",
  (reason) =>
    Effect.gen(function* () {
      const bridge = new ScreenHostBridge();
      bridge.setDispatcher({
        availability: () => Effect.succeed([]),
        dispatch: () =>
          Effect.sync(() => {
            bridge.cutCellNow("r", "t", "c", reason);
            return {
              category: "confirmed",
              evidence: ["observed"],
              value: [],
              safety: {
                possibleCommit: true,
                retryClass: "never",
                writeStatus: "committed",
                code: "write_committed",
              },
            };
          }),
      });
      const answer = yield* bridge.handle({ ...call(1), method: "list_apps" }, context());
      expect(answer?.error?.code).toBe(reason);
      expect(answer?.error?.safety?.possibleCommit).toBe(true);
    }),
);

it.effect("a completed read retains input evidence through the final fence", () =>
  Effect.gen(function* () {
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher({
      availability: () => Effect.succeed([]),
      dispatch: () =>
        Effect.succeed({
          category: "confirmed",
          evidence: ["observed"],
          value: [],
          safety: {
            possibleCommit: true,
            retryClass: "never",
            writeStatus: "committed",
            code: "write_committed",
          },
        }),
    });
    const input = { ...call(1), method: "list_apps" } satisfies ScreenHostCall;
    const prepared = yield* bridge.handle(input, context());
    bridge.cutCellNow("r", "t", "c", "stopped_by_person");
    expect(bridge.finalizeReply(prepared, input, context())?.error?.safety?.possibleCommit).toBe(
      true,
    );
  }),
);
