import type {
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  OrchestratorMcpReviewRound,
} from "@goat/contracts";

/**
 * Evidence for continuing a review round in its reviewer's native conversation. A round counts
 * only through its brief attempt: the provider completed a turn for the brief on a recorded native
 * thread. Steering restarts, restart continuations and slash commands never count, because they
 * can complete a turn without the provider reading the brief.
 */
export interface ReviewChildRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "rollbackRequestId">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly attempts: ReadonlyArray<OrchestrationV2RunAttempt>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

type ReviewTask = Pick<OrchestrationV2Subagent, "id" | "prompt" | "continuedFrom">;

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const isTerminalRun = (run: Pick<OrchestrationV2Run, "status">) =>
  TERMINAL_RUN_STATUSES.has(run.status);

export const isSlashPrompt = (text: string) => text.trimStart().startsWith("/");

/** The task's runs. The original task owns the child's runs that no later task claimed. */
function reviewTaskRuns(
  child: Pick<ReviewChildRecords, "runs">,
  task: Pick<OrchestrationV2Subagent, "id">,
  isOriginal: boolean,
): ReadonlyArray<OrchestrationV2Run> {
  return child.runs.filter((run) =>
    isOriginal ? run.delegatedTaskId === undefined : run.delegatedTaskId === task.id,
  );
}

/** The run that carried the task's brief: its first run that is not a restart continuation. */
function briefRun(
  child: Pick<ReviewChildRecords, "runs">,
  task: Pick<OrchestrationV2Subagent, "id">,
  isOriginal: boolean,
): OrchestrationV2Run | undefined {
  return reviewTaskRuns(child, task, isOriginal)
    .filter((run) => run.restartContinuationOfRunId === undefined)
    .toSorted((left, right) => left.ordinal - right.ordinal)[0];
}

/** Attempts that sent the brief: the initial one, and retries only before any steering restart. */
function briefAttempts(
  child: Pick<ReviewChildRecords, "attempts">,
  run: Pick<OrchestrationV2Run, "id">,
): ReadonlyArray<OrchestrationV2RunAttempt> {
  const attempts = child.attempts.filter((attempt) => attempt.runId === run.id);
  const steered = attempts.some((attempt) => attempt.reason === "steering_restart");
  return attempts.filter(
    (attempt) =>
      attempt.reason === "initial" ||
      (!steered && (attempt.reason === "retry" || attempt.reason === "provider_recovery")),
  );
}

const nativeIdOf = (attempt: Pick<OrchestrationV2RunAttempt, "nativeThreadId">) =>
  attempt.nativeThreadId === undefined || attempt.nativeThreadId.startsWith("pending:")
    ? undefined
    : attempt.nativeThreadId;

const hasProviderTurn = (
  child: Pick<ReviewChildRecords, "providerTurns">,
  attempt: Pick<OrchestrationV2RunAttempt, "id">,
  completedOnly: boolean,
) =>
  child.providerTurns.some(
    (turn) => turn.runAttemptId === attempt.id && (!completedOnly || turn.status === "completed"),
  );

/**
 * The native conversation an earlier round's brief completed on, with the attempt that shows it.
 * Undefined when no brief attempt completed a provider turn on a recorded native thread.
 */
function reviewBaseline(
  child: ReviewChildRecords,
  task: ReviewTask,
  isOriginal: boolean,
): { readonly nativeThreadId: string; readonly attempt: OrchestrationV2RunAttempt } | undefined {
  if (isSlashPrompt(task.prompt)) return undefined;
  const run = briefRun(child, task, isOriginal);
  if (run === undefined) return undefined;
  const attempt = briefAttempts(child, run)
    .filter((candidate) => hasProviderTurn(child, candidate, true))
    .toSorted((left, right) => right.attemptOrdinal - left.attemptOrdinal)[0];
  const nativeThreadId = attempt === undefined ? undefined : nativeIdOf(attempt);
  return attempt === undefined || nativeThreadId === undefined
    ? undefined
    : { nativeThreadId, attempt };
}

/**
 * Why the earlier round cannot be continued, or undefined when it can. Callers check task
 * ownership, role, status and the child thread's lineage first.
 */
export function reviewContinuationRefusal(input: {
  readonly child: ReviewChildRecords & {
    readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "text">>;
    readonly providerThreads: ReadonlyArray<
      Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">
    >;
    readonly activeProviderThreadId: OrchestrationV2AppThread["activeProviderThreadId"];
  };
  readonly earlier: ReviewTask;
  readonly isOriginal: boolean;
}): string | undefined {
  const { child, earlier, isOriginal } = input;
  if (child.thread.rollbackRequestId !== undefined)
    return "This reviewer's conversation was rolled back; start a fresh review.";
  if (child.runs.some((run) => !isTerminalRun(run)))
    return "This reviewer's thread still has a turn running or queued; wait for it to finish.";
  const earlierRuns = reviewTaskRuns(child, earlier, isOriginal);
  if (earlierRuns.some((run) => run.status === "rolled_back"))
    return "This reviewer's conversation was rolled back; start a fresh review.";
  const messageText = new Map(child.messages.map((message) => [message.id, message.text]));
  const latest = child.runs
    .filter((run) => !isSlashPrompt(messageText.get(run.userMessageId) ?? ""))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (latest === undefined || !earlierRuns.some((run) => run.id === latest.id))
    return "continueFrom must name the latest review round in that reviewer's thread.";
  const baseline = reviewBaseline(child, earlier, isOriginal);
  if (baseline === undefined)
    return "GOAT has no record of that round's brief completing in a provider conversation, so it cannot be continued; start a fresh review.";
  const baselineRun = child.runs.find((run) => run.id === baseline.attempt.runId);
  const replaced = child.attempts.some((attempt) => {
    const run = child.runs.find((candidate) => candidate.id === attempt.runId);
    const later =
      run !== undefined &&
      baselineRun !== undefined &&
      (run.ordinal > baselineRun.ordinal ||
        (run.id === baselineRun.id && attempt.attemptOrdinal > baseline.attempt.attemptOrdinal));
    return (
      later &&
      hasProviderTurn(child, attempt, false) &&
      nativeIdOf(attempt) !== baseline.nativeThreadId
    );
  });
  const active = child.providerThreads.find(
    (providerThread) => providerThread.id === child.activeProviderThreadId,
  );
  if (replaced || active?.nativeThreadRef?.nativeId !== baseline.nativeThreadId)
    return "This reviewer's provider conversation changed after that round; start a fresh review.";
  return undefined;
}

/** Which conversation a review task's round ran in, from the records the provider boundary keeps. */
export function reviewRound(input: {
  readonly child: ReviewChildRecords;
  readonly task: ReviewTask & Pick<OrchestrationV2Subagent, "status">;
  readonly earlier: ReviewTask | undefined;
  readonly earlierIsOriginal: boolean;
  readonly compactions: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId">>;
}): OrchestratorMcpReviewRound {
  const { child, task } = input;
  const continuedFrom: NodeId | null = task.continuedFrom ?? null;
  const runs = continuedFrom === null ? [] : reviewTaskRuns(child, task, false);
  const lastRunOrdinal = Math.max(0, ...runs.map((run) => run.ordinal));
  const compacted = input.compactions.some((item) => {
    const run = child.runs.find((candidate) => candidate.id === item.runId);
    return run !== undefined && (continuedFrom === null || run.ordinal <= lastRunOrdinal);
  });
  if (continuedFrom === null) return { continuedFrom, conversation: "new", compacted };
  const conversation = ((): OrchestratorMcpReviewRound["conversation"] => {
    if (
      child.thread.rollbackRequestId !== undefined ||
      runs.some((run) => run.status === "rolled_back")
    )
      return "rewound";
    const baseline =
      input.earlier === undefined
        ? undefined
        : reviewBaseline(child, input.earlier, input.earlierIsOriginal);
    if (baseline === undefined) return "unverified";
    const runIds = new Set(runs.map((run) => run.id));
    const sent = child.attempts.filter(
      (attempt) => runIds.has(attempt.runId) && hasProviderTurn(child, attempt, false),
    );
    if (
      sent.some(
        (attempt) => (nativeIdOf(attempt) ?? baseline.nativeThreadId) !== baseline.nativeThreadId,
      )
    )
      return "recovered";
    if (sent.some((attempt) => nativeIdOf(attempt) === undefined)) return "unverified";
    const brief = briefRun(child, task, false);
    const briefDone =
      brief !== undefined &&
      briefAttempts(child, brief).some((attempt) => hasProviderTurn(child, attempt, true));
    if (briefDone) return "continued";
    const terminal =
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.status === "interrupted";
    if (!terminal) return "starting";
    return sent.some((attempt) => hasProviderTurn(child, attempt, true))
      ? "unverified"
      : "not_started";
  })();
  return { continuedFrom, conversation, compacted };
}
