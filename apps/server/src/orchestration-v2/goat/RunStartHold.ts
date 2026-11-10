/**
 * What a `starting` run waits for when Codex start admission holds its thread: a turn
 * that kept running across a restart, or a turn Codex started that no run owns. Without it the
 * run reads only `starting`, and people stop threads that are waiting behind real work.
 *
 * @module RunStartHold
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
  OrchestrationV2Run,
  OrchestrationV2RunStartHold,
  OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

import type { OrchestratorDispatchError, OrchestratorV2Error } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

type StartHoldCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "run.start-hold.update" }
>;

const sameStartHold = (
  left: OrchestrationV2RunStartHold | undefined,
  right: OrchestrationV2RunStartHold | undefined,
) => left?.reason === right?.reason && left?.nativeTurnId === right?.nativeTurnId;

/** The run with its hold replaced, or null when nothing changes or the run no longer waits to start. */
export function withStartHold(
  run: OrchestrationV2Run,
  hold: OrchestrationV2RunStartHold | undefined,
): OrchestrationV2Run | null {
  if (sameStartHold(run.startHold, hold)) return null;
  if (hold !== undefined && run.status !== "starting") return null;
  const { startHold: _previous, ...rest } = run;
  return hold === undefined ? rest : { ...rest, startHold: hold };
}

export const dispatchRunStartHold = (deps: {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
}) =>
  Effect.fn("Orchestrator.dispatchRunStartHold")(function* (
    command: StartHoldCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const { runs } = yield* deps.projectionStore
      .getThreadRecords(command.threadId, ["runs"], { runIds: [command.runId] })
      .pipe(deps.mapDispatchError(command));
    const run = runs.find((candidate) => candidate.id === command.runId);
    const next = run === undefined ? null : withStartHold(run, command.startHold ?? undefined);
    if (run === undefined || next === null) return;
    yield* deps.emit(
      events,
      command,
    )({
      type: "run.updated",
      threadId: command.threadId,
      runId: run.id,
      ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
      providerInstanceId: run.providerInstanceId,
      occurredAt: yield* DateTime.now,
      payload: next,
    });
  });
