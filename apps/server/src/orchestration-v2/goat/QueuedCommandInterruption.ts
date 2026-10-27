import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import type {
  OrchestrationEffectRequestV2,
  PendingOrchestrationEffectV2,
} from "../EffectOutbox.ts";
import type { OrchestratorV2Error } from "../Orchestrator.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "../QueuedRunOrder.ts";

type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Effects = Ref.Ref<Array<PendingOrchestrationEffectV2>>;

interface QueuedCommandInterruptionDeps {
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly dispatchRunInterrupt: (
    command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
    events: Events,
    effects: Effects,
  ) => Effect.Effect<
    | {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      }
    | undefined,
    OrchestratorV2Error
  >;
}

export const makeQueuedCommandInterruption = ({
  emit,
  dispatchRunInterrupt,
}: QueuedCommandInterruptionDeps) => {
  const stopRunForQueuedCommand = Effect.fn("Orchestrator.stopRunForGoalCommand")(
    function* (input: {
      readonly command: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
      >;
      readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
      readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
      readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
      readonly queuedRunId: RunId;
      readonly targetRunId: RunId | undefined;
      readonly reason: string;
      readonly now: DateTime.Utc;
    }) {
      const { command, events, effects, projection, now, targetRunId } = input;
      const others = queuedRunsInDeliveryOrder(projection).filter(
        (run) => run.id !== input.queuedRunId && !isAutomaticCompletionRun(projection, run),
      );
      for (const [index, run] of others.entries()) {
        const queuePosition = index + 2;
        if (run.queuePosition === queuePosition) continue;
        yield* emit(
          events,
          command,
        )({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queuePosition },
        });
      }
      if (targetRunId === undefined) return undefined;
      const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
      const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
      const interrupted = yield* Effect.exit(
        dispatchRunInterrupt(
          {
            type: "run.interrupt",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: targetRunId,
            reason: input.reason,
          },
          interruptEvents,
          interruptEffects,
        ),
      );
      // A failed interrupt may have written part of its events, so they are kept apart.
      // The queued command then waits for the turn to end.
      if (Exit.isFailure(interrupted)) {
        yield* Effect.logWarning("queued command could not stop the running turn", {
          threadId: command.threadId,
          runId: targetRunId,
          cause: interrupted.cause,
        });
        return undefined;
      }
      const written = yield* Ref.get(interruptEvents);
      const enqueued = yield* Ref.get(interruptEffects);
      yield* Ref.update(events, (existing) => [...existing, ...written]);
      yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
      return interrupted.value;
    },
  );

  return { stopRunForQueuedCommand };
};
