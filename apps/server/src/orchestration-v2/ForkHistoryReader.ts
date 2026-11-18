import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2Run,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type { IdAllocatorV2 } from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { forkHistoryItemBytes, type ForkHistoryPage } from "./ForkHistoryPage.ts";
import { unsentManualContinuationSource } from "./manualContinuation.ts";

const HISTORY_BYTES = 256 * 1024;
const HISTORY_ITEMS = 256;
const PAGE_ITEMS = 16;
const MAX_ANCESTORS = 64;

type SourceThread = OrchestrationV2ThreadProjection["thread"];
type HistoryBudget = { bytes: number; items: number };
const historyBudget = (): HistoryBudget => ({ bytes: HISTORY_BYTES - 2, items: HISTORY_ITEMS });

function retain(budget: HistoryBudget, items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const retained: OrchestrationV2TurnItem[] = [];
  for (const item of items) {
    if (budget.items <= 0 || budget.bytes <= 0) break;
    const bytes = forkHistoryItemBytes(item);
    if (bytes > budget.bytes) continue;
    budget.bytes -= bytes;
    budget.items--;
    retained.push(item);
  }
  return retained;
}

export function makeForkHistoryReader(store: ProjectionStoreV2["Service"]) {
  const read = Effect.fn("ForkHistoryReader.read")(function* (
    threadId: ThreadId,
    runIds: ReadonlyArray<RunId> | undefined,
    scope: Omit<ForkHistoryPage, "before" | "maxBytes" | "limit">,
    budget: HistoryBudget,
  ) {
    let before: ForkHistoryPage["before"];
    const newestFirst: OrchestrationV2TurnItem[] = [];
    for (let scanned = 0; scanned < HISTORY_ITEMS && budget.items > 0 && budget.bytes > 0;) {
      const limit = Math.min(PAGE_ITEMS, budget.items);
      const page = yield* store.getTurnStartHistory(threadId, runIds, {
        ...scope,
        before,
        maxBytes: budget.bytes,
        limit,
      });
      newestFirst.push(...retain(budget, page));
      scanned += page.length;
      const last = page.at(-1);
      if (last === undefined || page.length < limit) break;
      before = { ordinal: last.ordinal, id: last.id };
    }
    return newestFirst.reverse();
  });

  const readOwnItems = (
    source: Pick<OrchestrationV2ThreadProjection, "thread">,
    throughRunOrdinal: number,
    budget = historyBudget(),
  ) =>
    read(
      source.thread.id,
      undefined,
      {
        throughRunOrdinal,
        includeImported: source.thread.historyOrigin === "v1_import",
        visibleOnly: true,
      },
      budget,
    );

  const readInheritedItems = Effect.fn("ForkHistoryReader.readInheritedItems")(function* (
    thread: SourceThread,
    budget: HistoryBudget,
    excludeItemId?: TurnItemId,
  ) {
    const segments: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
    const seen = new Set<ThreadId>([thread.id]);
    let parentPoint = thread.forkedFrom;
    while (
      parentPoint?.type === "run" &&
      !seen.has(parentPoint.threadId) &&
      seen.size <= MAX_ANCESTORS &&
      budget.items > 0 &&
      budget.bytes > 0
    ) {
      const { threadId, runId } = parentPoint;
      seen.add(threadId);
      const parent = yield* store
        .getThread(threadId)
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      if (parent === null) break;
      const run = yield* store.getRun(threadId, runId);
      if (run === undefined) break;
      segments.push(
        yield* read(
          threadId,
          undefined,
          {
            throughRunOrdinal: run.ordinal,
            includeImported: parent.historyOrigin === "v1_import",
            visibleOnly: true,
            excludeItemId,
          },
          budget,
        ),
      );
      parentPoint = parent.forkedFrom;
    }
    return segments.reverse().flat();
  });

  const readForkHistory = Effect.fn("ForkHistoryReader.readForkHistory")(function* (
    source: Pick<OrchestrationV2ThreadProjection, "thread">,
    throughRunOrdinal: number,
  ) {
    const budget = historyBudget();
    const own = yield* readOwnItems(source, throughRunOrdinal, budget);
    return [...(yield* readInheritedItems(source.thread, budget)), ...own];
  });
  return { read, readInheritedItems, readOwnItems, readForkHistory };
}

export function makeReadSwitchItems<E>(
  store: ProjectionStoreV2["Service"],
  mapError: (threadId: ThreadId, cause: unknown) => E,
  userTurnItem: IdAllocatorV2["Service"]["derive"]["userTurnItem"],
) {
  const { read, readInheritedItems } = makeForkHistoryReader(store);
  return Effect.fn("Orchestrator.readProviderSwitchItems")(function* (
    projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">,
    coveredRuns: ReadonlyArray<{ readonly id: RunId }>,
    includeInherited: boolean,
    legacyItems: ReadonlyArray<OrchestrationV2TurnItem>,
    continuation: Pick<OrchestrationV2Run, "manualContinuationOfRunId">,
  ) {
    const { thread } = projection;
    const replay = unsentManualContinuationSource(continuation, projection);
    const excluded =
      replay === undefined ? undefined : userTurnItem({ messageId: replay.userMessageId });
    const budget = historyBudget();
    const own = yield* read(
      thread.id,
      coveredRuns.map((run) => run.id),
      {
        includeImported: false,
        excludeItemId: excluded,
      },
      budget,
    ).pipe(Effect.mapError((cause) => mapError(thread.id, cause)));
    const legacy = retain(budget, legacyItems);
    const inherited = includeInherited
      ? yield* readInheritedItems(thread, budget, excluded).pipe(
          Effect.mapError((cause) => mapError(thread.id, cause)),
        )
      : [];
    return [...inherited, ...legacy, ...own];
  });
}

export function makeReadHandoffItems<E>(
  store: ProjectionStoreV2["Service"],
  mapError: (threadId: ThreadId, cause: unknown) => E,
) {
  const { read } = makeForkHistoryReader(store);
  return (threadId: ThreadId, runIds?: ReadonlyArray<RunId | null>) =>
    read(
      threadId,
      runIds?.filter((id) => id !== null),
      {
        includeImported: runIds === undefined || runIds.includes(null),
      },
      historyBudget(),
    ).pipe(Effect.mapError((cause) => mapError(threadId, cause)));
}
