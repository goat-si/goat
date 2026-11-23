import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2RestartCancelledBackgroundWork as Work,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EventSink from "./EventSink.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type { ReleasedProviderThread } from "./providerSessionReleasedWork.ts";
import { latestStartedRun } from "./goat/RecoveryBackground.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";

const types: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "command_execution",
  "dynamic_tool",
  "subagent",
];
const statuses: ReadonlyArray<OrchestrationV2TurnItem["status"]> = [
  "interrupted",
  "failed",
  "cancelled",
];

export const makeReleasedWorkNote = ({
  projectionStore,
  eventSink,
  idAllocator,
}: {
  readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  readonly eventSink: EventSink.EventSinkV2Shape;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}) =>
  Effect.fn("ProviderSessionManager.writeReleasedWorkNote")(function* (
    released: Pick<
      ReleasedProviderThread,
      "threadId" | "providerSessionId" | "providerThreadId" | "lostTasks" | "lostItems"
    >,
  ) {
    const { threadId, providerSessionId, lostTasks, lostItems } = released;
    if (lostTasks.length === 0 && lostItems.length === 0) return;
    const { runs, turnItems } = yield* projectionStore.getThreadRecords(
      threadId,
      ["runs", "turnItems"],
      { turnItemTypes: types, turnItemStatuses: statuses },
    );
    const ids = new Set(lostItems.map((item) => item.id));
    const lost = [
      ...lostTasks.map((task) => ({
        providerThreadId: released.providerThreadId,
        work: cancelledRosterTaskWork(task),
      })),
      ...turnItems.flatMap((item) => {
        const work = ids.has(item.id) ? cancelledTurnItemWork(item) : undefined;
        const providerThreadId = awaitingProviderThreadId(item, runs);
        return work === undefined || providerThreadId == null ? [] : [{ providerThreadId, work }];
      }),
    ];
    const workByRun = new Map<RunId, { run: OrchestrationV2Run; work: Array<Work> }>();
    for (const { providerThreadId, work } of lost) {
      const run = latestStartedRun(runs, providerThreadId);
      if (run === undefined) continue;
      const entry = workByRun.get(run.id) ?? { run, work: [] };
      entry.work.push(work);
      workByRun.set(run.id, entry);
    }
    if (workByRun.size === 0) return;
    const now = yield* DateTime.now;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
    for (const { run, work } of workByRun.values()) {
      events.push({
        id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          runId: run.id,
          restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
            run.restartCancelledBackgroundWork ?? [],
            work,
          ),
        },
      });
      effects.push({
        id: `effect:restart-continuation:${run.id}`,
        commandId: CommandId.make(`command:provider-exit-continuation:${run.id}`),
        threadId,
        request: { type: "provider-runtime.continue", sourceRunId: run.id, cause: "provider_exit" },
      });
    }
    yield* eventSink.writeWithEffects({ events, effects });
  });

/** A query process can exit under a live session, after the run's last event. */
export const makeLostBackgroundWorkWriter =
  <E>(
    writeNote: (released: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly lostTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
      readonly lostItems: Array<never>;
    }) => Effect.Effect<void, E>,
  ) =>
  (
    event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "background_work.lost" }>,
    runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "driver" | "providerSessionId">,
  ) =>
    writeNote({
      threadId: event.threadId,
      providerSessionId: runtime.providerSessionId,
      providerThreadId: event.providerThreadId,
      lostTasks: event.tasks,
      lostItems: [],
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: runtime.driver,
            providerSessionId: runtime.providerSessionId,
            raisedByGoat: true,
            cause,
          }),
      ),
    );
