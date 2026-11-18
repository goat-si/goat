import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { AttemptDeliveryUpdate } from "./AttemptInputDelivery.ts";
import type { EventSinkV2 } from "./EventSink.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";

export const makeRunInputDelivery = Effect.fn("RunExecutionService.makeInputDelivery")(function* (
  eventSink: EventSinkV2["Service"],
  ids: IdAllocatorV2["Service"],
  { run, attempt, providerThread, reattach }: RunExecutionServiceV2StartRootRunInput,
  onSubmit: Effect.Effect<void>,
) {
  if (reattach === true) return undefined;
  const write = Effect.fn("RunExecutionService.writeInputDelivery")(
    function* (delivery: AttemptDeliveryUpdate["delivery"], inherited = false) {
      if (attempt.inputDelivery === undefined) return true;
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
          ...(inherited ? { inherited: true } : {}),
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
  const acknowledge = Effect.fn("RunExecutionService.acknowledgeInputDelivery")(
    function* (inherited: boolean) {
      yield* write("accepted", inherited);
    },
    Effect.catch(() =>
      Effect.logWarning("Provider input acceptance could not be recorded.", { runId: run.id }),
    ),
  );
  const accepted = yield* Effect.cached(acknowledge(false));
  const submitted = yield* Effect.cached(onSubmit);
  return {
    begin: () => write("ambiguous"),
    submitted: () => submitted,
    skipped: () => Effect.void,
    accepted: () => accepted,
    inherited: () => acknowledge(true),
  } satisfies ProviderAdapter.ProviderInputDelivery;
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
    return;
  yield* operation;
});
