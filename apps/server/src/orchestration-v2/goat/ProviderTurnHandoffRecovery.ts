import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@goat/provider-core/server/handoffBudget";
import { modelSelectionsEqual } from "@goat/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ContextHandoffService from "../ContextHandoffService.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { missedTurnInputRuns } from "./MissedTurnInput.ts";

export const makeProviderTurnHandoffRecovery = Effect.gen(function* () {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  return Effect.fn("ProviderTurnStartService.makeHandoffRecovery")(function* ({
    threadId,
    projection,
    providerThread,
    run,
    session,
    cwd,
    userText,
    restartNote,
    attachments,
  }: {
    readonly threadId: ThreadId;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs" | "messages"
    >;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly run: OrchestrationV2Run;
    readonly session: ProviderAdapter.ProviderAdapterV2SessionRuntime;
    readonly cwd: string | null;
    readonly userText: string;
    readonly restartNote: string;
    readonly attachments: OrchestrationV2ThreadProjection["messages"][number]["attachments"];
  }) {
    const tokenCap = yield* handoffTokenCapConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
    );
    const handoffContextForThread = (
      loadedProviderThread: OrchestrationV2ProviderThread,
      resumeFellBack = false,
    ) => {
      const measuredContext = latestNativeContextUsage(projection, providerThread);
      const previousSelection =
        measuredContext?.modelSelection ??
        projection.runs.findLast(
          (source) =>
            source.ordinal < run.ordinal &&
            source.startedAt !== null &&
            source.providerThreadId === providerThread.id,
        )?.modelSelection;
      const sameSelection =
        previousSelection === undefined ||
        modelSelectionsEqual(previousSelection, run.modelSelection);
      const sameNativeThread =
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const knownModelWindow = session.getModelContextWindow?.(run.modelSelection, cwd);
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage,
        knownModelWindow,
      });
      const settledHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
          handoff.delivery?.status !== "pending",
      );
      const deliveredItemIds = new Set(
        settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
      );
      const coveredItemIds = new Set([
        ...deliveredItemIds,
        ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
      ]);
      const deliveredAttemptIds = new Set(
        projection.providerTurns.map((turn) => turn.runAttemptId),
      );
      const acceptedAttempts = projection.attempts.filter(
        (source) =>
          source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
      );
      const nativeInputRunIds = new Set(
        acceptedAttempts
          .filter(
            (source) =>
              source.nativeThreadId !== undefined &&
              source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
          )
          .map((source) => source.runId),
      );
      const legacyInputRunIds = new Set(
        acceptedAttempts
          .filter((source) => source.nativeThreadId === undefined)
          .map((source) => source.runId),
      );
      const legacyRecoveredRunIds = new Set(
        projection.runs
          .filter(
            (source) =>
              source.providerThreadId === providerThread.id &&
              settledHandoffs.some(
                (handoff) =>
                  handoff.strategy === "full_thread_summary" &&
                  handoff.fromProviderThreadIds.includes(providerThread.id) &&
                  source.ordinal >= handoff.coveredRunOrdinals.from &&
                  source.ordinal <= handoff.coveredRunOrdinals.to,
              ),
          )
          .map((source) => source.id),
      );
      // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
      const nativeContextEstimate = Effect.gen(function* () {
        return sameNativeThread
          ? (yield* projectionStore.getTurnStartHistory(threadId)).reduce((sum, item) => {
              const acceptedNatively =
                item.providerThreadId === providerThread.id &&
                item.runId !== null &&
                (nativeInputRunIds.has(item.runId) ||
                  (legacyInputRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    !legacyRecoveredRunIds.has(item.runId)));
              if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                return sum;
              const historical = historicalMessage(item);
              const nativeAttachments =
                item.type === "user_message" && acceptedNatively
                  ? attachmentTokenAllowance(item.attachments)
                  : 0;
              return (
                sum +
                (historical === null ? 0 : Buffer.byteLength(historical.text)) +
                nativeAttachments
              );
            }, 0)
          : 0;
      });
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      const budgetProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
      };
      // The resume fallback summary already covers every earlier run in order. A
      // retry copy after it would rank older missed requests as the newest history.
      const missedRuns = resumeFellBack
        ? []
        : missedTurnInputRuns(projection, run, deliveredAttemptIds);
      const missedRunIds = new Set(missedRuns.map((source) => source.id));
      return {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        coveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        missedRuns,
        missedRunIds,
        budget: Effect.gen(function* () {
          return handoffBudget({
            tokenCap,
            modelContextWindow,
            userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
            attachments,
            providerThread: budgetProviderThread,
            nativeContextEstimate:
              budgetProviderThread.contextUsage?.usedTokens === undefined
                ? yield* nativeContextEstimate
                : 0,
          });
        }),
      };
    };
    const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
      function* (context: ReturnType<typeof handoffContextForThread>) {
        const { missedRunIds, coveredItemIds, missedRuns } = context;
        const missedItems =
          missedRunIds.size === 0
            ? []
            : (yield* projectionStore.getTurnStartHistory(threadId, [...missedRunIds])).filter(
                (item) =>
                  item.runId !== null &&
                  missedRunIds.has(item.runId) &&
                  !coveredItemIds.has(item.id) &&
                  historicalMessage(item) !== null,
              );
        const firstMissedRun = missedRuns[0];
        const lastMissedRun = missedRuns.at(-1);
        const retryHandoff =
          missedItems.length === 0 || firstMissedRun === undefined || lastMissedRun === undefined
            ? []
            : [
                yield* contextHandoffService.prepareProviderHandoff({
                  threadId: projection.thread.id,
                  targetRunId: run.id,
                  transferId: null,
                  fromProviderThreadIds: [providerThread.id],
                  toProviderThreadId: providerThread.id,
                  fromProviderInstanceId: run.providerInstanceId,
                  toProviderInstanceId: run.providerInstanceId,
                  coveredRunOrdinals: {
                    from: firstMissedRun.ordinal,
                    to: lastMissedRun.ordinal,
                  },
                  strategy: "delta_since_target_last_seen",
                  items: missedItems,
                  runs: projection.runs,
                  createdAt: yield* DateTime.now,
                }),
              ];
        return retryHandoff;
      },
    );
    const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
      function* () {
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: (yield* projectionStore.getTurnStartHistory(threadId)).filter(
            (item) =>
              item.runId === null ||
              projection.runs.some(
                (source) => source.id === item.runId && source.ordinal < run.ordinal,
              ),
          ),
          createdAt,
        });
        return { handoff, transferId, createdAt };
      },
    );
    const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
    const withRecoveryHandoff = (
      handoff: OrchestrationV2ContextHandoff,
      effectiveHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>,
    ) => {
      // Delivery ranks later handoffs as newer history. Pending handoffs from
      // earlier runs predate this summary; handoffs for this run (provider-switch
      // delta, merge-back) are newer and must stay last.
      return [
        ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
        handoff,
        ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
      ];
    };

    return { handoffContextForThread, prepareRetryHandoff, recoveryHandoff, withRecoveryHandoff };
  });
});
