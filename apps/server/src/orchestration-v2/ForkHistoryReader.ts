import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@goat/shared/orchestrationV2Timeline";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export function makeForkHistoryReader(store: ProjectionStoreV2["Service"]) {
  const readOwnItems = (
    source: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">,
    throughOrdinal: number,
  ) =>
    store
      .getThreadRecords(source.thread.id, ["turnItems"], {
        turnItemRunIds: [
          ...source.runs.filter((run) => run.ordinal <= throughOrdinal).map((run) => run.id),
          ...(source.thread.historyOrigin === "v1_import" ? [null] : []),
        ],
      })
      .pipe(
        // Rewound runs and cancelled queued input are not part of the conversation.
        Effect.map(({ turnItems }) =>
          turnItems.filter(
            createOrchestrationV2TurnItemVisibility({
              runs: source.runs,
              attempts: source.attempts,
              items: turnItems,
            }),
          ),
        ),
      );
  // The source's timeline starts with what it inherited from its own fork ancestors.
  const readInheritedItems = Effect.fn("ProviderTurnStartService.readInheritedForkItems")(
    function* (thread: OrchestrationV2ThreadProjection["thread"]) {
      const segments: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
      const seen = new Set<ThreadId>([thread.id]);
      let forkedFrom = thread.forkedFrom;
      while (forkedFrom?.type === "run" && !seen.has(forkedFrom.threadId)) {
        const { threadId, runId } = forkedFrom;
        seen.add(threadId);
        const parent = yield* store
          .getThreadRecords(threadId, ["runs", "attempts"])
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          );
        const forkRun = parent?.runs.find((run) => run.id === runId);
        if (parent === null || forkRun === undefined) break;
        segments.unshift(yield* readOwnItems(parent, forkRun.ordinal));
        forkedFrom = parent.thread.forkedFrom;
      }
      return segments.flat();
    },
  );
  return { readInheritedItems, readOwnItems };
}

export function makeReadSwitchItems<E>(
  store: ProjectionStoreV2["Service"],
  readHandoffItems: (
    threadId: ThreadId,
    runIds: ReadonlyArray<RunId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, E>,
  mapError: (threadId: ThreadId, cause: unknown) => E,
) {
  const { readInheritedItems } = makeForkHistoryReader(store);
  return Effect.fn("Orchestrator.readProviderSwitchItems")(function* (
    thread: OrchestrationV2ThreadProjection["thread"],
    coveredRuns: ReadonlyArray<{ readonly id: RunId }>,
    includeInherited: boolean,
    legacyItems: ReadonlyArray<OrchestrationV2TurnItem>,
  ) {
    const inherited = includeInherited
      ? yield* readInheritedItems(thread).pipe(
          Effect.mapError((cause) => mapError(thread.id, cause)),
        )
      : [];
    return [
      ...inherited,
      ...legacyItems,
      ...(yield* readHandoffItems(
        thread.id,
        coveredRuns.map((run) => run.id),
      )),
    ];
  });
}
