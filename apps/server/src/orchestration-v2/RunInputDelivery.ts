import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { AttemptDeliveryUpdate } from "./AttemptInputDelivery.ts";
import type { EventSinkV2 } from "./EventSink.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";

export const makeRunInputDelivery = Effect.fn("RunExecutionService.makeInputDelivery")(function* (
  eventSink: EventSinkV2["Service"],
  ids: IdAllocatorV2["Service"],
  { run, attempt, providerThread, reattach }: RunExecutionServiceV2StartRootRunInput,
) {
  if (reattach === true || attempt.inputDelivery === undefined) return undefined;
  const write = Effect.fn("RunExecutionService.writeInputDelivery")(
    function* (delivery: AttemptDeliveryUpdate["delivery"]) {
      const { id: runId, threadId } = run;
      const result = yield* eventSink.writeIfRunCurrent({
        threadId,
        runId,
        activeAttemptId: attempt.id,
        expectedStatus: "running",
        ...(delivery === "accepted"
          ? {}
          : {
              unlessInterruptRequested: {
                requestId: ids.derive.runSignalTurnItem({ runId, signal: "interrupt-request" }),
                resultId: ids.derive.runSignalTurnItem({ runId, signal: "interrupt-result" }),
              },
            }),
        attemptDelivery: {
          id: yield* ids.allocate.event({ threadId }),
          occurredAt: yield* DateTime.now,
          delivery,
        },
        events: [],
      });
      return result.committed;
    },
    Effect.mapError(
      (cause) =>
        new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: providerThread.driver,
          threadId: run.threadId,
          providerThreadId: providerThread.id,
          runId: run.id,
          cause,
        }),
    ),
  );
  const accepted = yield* Effect.cached(
    write("accepted").pipe(
      Effect.asVoid,
      Effect.catch(() =>
        Effect.logWarning("Provider input acceptance could not be recorded.", { runId: run.id }),
      ),
    ),
  );
  const submitted = yield* Ref.make(false);
  const begin = write("ambiguous").pipe(
    Effect.tap((admitted) => (admitted ? Ref.set(submitted, true) : Effect.void)),
  );
  return {
    begin: () => begin,
    accepted: () => accepted,
    submitted: Ref.get(submitted),
  } satisfies ProviderAdapter.ProviderInputDelivery & {
    readonly submitted: Effect.Effect<boolean>;
  };
});

export const submitProviderInput = Effect.fn("RunExecutionService.submitProviderInput")(function* <
  E,
  R,
>(
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  delivery: Effect.Success<ReturnType<typeof makeRunInputDelivery>>,
  operation: Effect.Effect<void, E, R>,
) {
  if (delivery !== undefined && runtime.tracksInputDelivery !== true && !(yield* delivery.begin()))
    return "skipped" as const;
  yield* operation;
  return runtime.tracksInputDelivery === true &&
    delivery !== undefined &&
    !(yield* delivery.submitted)
    ? ("skipped" as const)
    : ("submitted" as const);
});
