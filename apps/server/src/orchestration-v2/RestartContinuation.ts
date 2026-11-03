import { MAX_CONTINUATION_CHAIN } from "./ContinuationChain.ts";
import { runRanAfter } from "@goat/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@goat/shared/projectSettings";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as CodexSurvivors from "../provider/CodexSurvivors.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { survivorQueuedRuns } from "./goat/CodexSurvivorQueuedRuns.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  continuationFailedBeforePrompt,
  isAwaitedWork,
  isRestartContinuationSource,
  cancelledBeforeStart,
  isRestartNoteSource,
  neverStarted,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

const CONTINUATION_LOOP_WINDOW_MS = 5 * 60 * 1_000;

export const makeRestartContinuation = Effect.fn("RestartContinuation.make")(function* (
  starter: ProviderTurnStart.ProviderTurnStartServiceV2["Service"],
) {
  const survivors = yield* Effect.serviceOption(CodexSurvivors.CodexSurvivors);
  const outbox = yield* Effect.serviceOption(EffectOutbox.EffectOutboxV2);
  return (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) => {
    const continuation = continueRestartedRun(input).pipe(
      Effect.provideService(ProviderTurnStart.ProviderTurnStartServiceV2, starter),
    );
    const withSurvivors = Option.isSome(survivors)
      ? continuation.pipe(Effect.provideService(CodexSurvivors.CodexSurvivors, survivors.value))
      : continuation;
    return Option.isSome(outbox)
      ? withSurvivors.pipe(Effect.provideService(EffectOutbox.EffectOutboxV2, outbox.value))
      : withSurvivors;
  };
});

function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  if (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  )
    return true;
  const waitingRequest = projection.runtimeRequests.some(
    (request) =>
      request.kind !== "dynamic_tool_call" &&
      request.kind !== "auth_refresh" &&
      request.responseCapability.type !== "message" &&
      (request.status === "pending" ||
        ((request.status === "expired" || request.status === "cancelled") &&
          request.responseCapability.type === "not_resumable" &&
          turn !== undefined &&
          turn.id === request.providerTurnId)),
  );
  if (waitingRequest) return true;
  return projection.turnItems.some(
    (item) =>
      item.type === "secret_request" &&
      item.runId === source.id &&
      (item.secretStatus === "pending" ||
        (item.secretStatus === "cancelled" &&
          item.completedAt !== null &&
          source.completedAt !== null &&
          DateTime.Equivalence(item.completedAt, source.completedAt))),
  );
}

/** App-owned delegations continue in their own threads and report back. */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    return (
      work !== undefined &&
      isAwaitedWork(work) &&
      awaitingProviderThreadId(item, projection.runs) === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(cancelledRosterTaskWork(task)),
      ))
  );
}

/** Settled runs require a live session so stale crash records cannot wake them. */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" &&
      !neverStarted(candidate) &&
      (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Adapters remain ready during turns; only stopped or failed sessions rule out liveness.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (settled) return hasOpenAwaitedWork(projection, providerThread) ? run : undefined;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    const survivorService = yield* Effect.serviceOption(CodexSurvivors.CodexSurvivors);
    const binding = Option.isSome(survivorService)
      ? (yield* survivorService.value.list).find(
          (candidate) => candidate.threadId === input.threadId,
        )
      : undefined;
    const survivor =
      binding !== undefined &&
      binding.instanceId === source?.providerInstanceId &&
      (binding.sourceRunId === source?.id ||
        binding.sourceRunId === source?.restartContinuationOfRunId);
    if (binding !== undefined && !survivor) return;
    if (
      !survivor &&
      (!enabled ||
        !resolveProjectSettings(enabled, projection.thread.projectId).settings
          .continueThreadsAfterServerUpdate)
    )
      return;
    const existingContinuation = survivor
      ? projection.runs.find((run) => run.restartContinuationOfRunId === source?.id)
      : undefined;
    const messageExists = projection.messages.some((message) => message.id === messageId);
    if (!survivor && messageExists) return;
    if (
      !source ||
      !(
        isRestartContinuationSource(source, projection.providerTurns) ||
        continuationFailedBeforePrompt(source, projection.providerTurns) ||
        (survivor &&
          source.status === "starting" &&
          source.restartContinuationOfRunId !== undefined)
      ) ||
      restartContinuationBlocked(
        projection,
        source,
        yield* DateTime.now,
        isRestartNoteSource(source, projection.providerTurns),
      )
    )
      return;
    const outbox = yield* Effect.serviceOption(EffectOutbox.EffectOutboxV2);
    const queuedRuns =
      survivor && Option.isSome(outbox)
        ? yield* survivorQueuedRuns(
            outbox.value,
            { threadId: input.threadId, restartContinuationOfRunId: binding?.sourceRunId },
            projection,
          )
        : new Set<RunId>();
    if (
      projection.runs.some(
        (run) =>
          !queuedRuns.has(run.id) &&
          run.id !== source.id &&
          run.id !== existingContinuation?.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          runRanAfter(run, source),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    const loopWindowStart =
      DateTime.toEpochMillis(source.completedAt ?? source.requestedAt) -
      CONTINUATION_LOOP_WINDOW_MS;
    for (
      let run: OrchestrationV2Run | undefined = source;
      run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
      run = projection.runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
    ) {
      if (DateTime.toEpochMillis(run.requestedAt) < loopWindowStart) break;
      chainLength += 1;
    }
    if (!survivor && chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds:
          survivor && binding !== undefined
            ? [
                ...new Set([
                  source.id,
                  binding.sourceRunId,
                  ...(source.restartContinuationOfRunId === undefined
                    ? []
                    : [source.restartContinuationOfRunId]),
                ]),
              ]
            : [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    if (
      sourceRecords.turnItems.some(
        (item) =>
          (item.runId === source.id ||
            (survivor &&
              (item.runId === binding?.sourceRunId ||
                item.runId === source.restartContinuationOfRunId))) &&
          item.type === "run_interrupt_request",
      )
    )
      return;
    // A parent's Stop reaches its open delegated tasks through an effect a restart can cut short.
    const { lineage, forkedFrom } = projection.thread;
    const taskId =
      source.delegatedTaskId ?? (forkedFrom?.type === "node" ? forkedFrom.nodeId : undefined);
    if (
      lineage.relationshipToParent === "subagent" &&
      lineage.parentThreadId !== null &&
      taskId !== undefined
    ) {
      const task = (yield* threads.getThreadRecords(lineage.parentThreadId, [
        "subagents",
      ])).subagents.find((candidate) => candidate.id === taskId);
      // A settled task no longer owns later work in its thread.
      const parentRunId =
        task !== undefined && task.result === null && isOrchestrationV2WorkActive(task.status)
          ? task.runId
          : null;
      if (
        parentRunId !== null &&
        (yield* threads.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [parentRunId],
        })).turnItems.length > 0
      )
        return;
    }
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    if (
      survivor &&
      (existingContinuation !== undefined ||
        (source.status === "starting" && source.restartContinuationOfRunId !== undefined))
    ) {
      const existing = existingContinuation ?? source;
      if (existing.status === "starting") {
        const starter = yield* Effect.serviceOption(ProviderTurnStart.ProviderTurnStartServiceV2);
        if (Option.isNone(starter))
          return yield* Effect.die(
            "Provider turn start service is unavailable for survivor adoption",
          );
        yield* starter.value.start({ threadId: input.threadId, runId: existing.id });
      }
      return;
    }
    if (messageExists) return;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    const text =
      noteText === undefined
        ? CONTINUE_PROMPT
        : note.settled
          ? noteText
          : `${noteText}\n\n${CONTINUE_PROMPT}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text,
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: note.settled
            ? "GOAT restarted and stopped background work"
            : "GOAT restarted and resumed this turn",
          detail: text,
        },
        attachments: [],
        modelSelection: source.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // Disabled instances cannot resume; still run success cleanup so delegated children recover without futile retries.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }),
        }),
      );
  },
  // Declined child continuations still owe parent results; existing continuation runs settle them instead.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
