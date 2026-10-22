import {
  ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpRunFailure,
  type OrchestratorMcpThreadPhase,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadStatusResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { cloudTaskView } from "./cloudTaskView.ts";

/**
 * The phase goat_thread_status reports, from facts the thread already records:
 * the described run's status and the kind of request it waits on. Like Codex's
 * derived thread status, nothing extra is stored; every reader gets the same
 * answer from the same projection.
 */

/** Requests only the user can answer. Anything else pending is an approval. */
const USER_INPUT_KINDS: ReadonlySet<string> = new Set(["user_input", "auth_refresh"]);
/** Provider tool calls GOAT answers itself; they never hold a run for a person. */
const SELF_ANSWERED_KINDS: ReadonlySet<string> = new Set(["dynamic_tool_call"]);

export const LAST_MESSAGE_EXCERPT_CHARS = 280;
/** goat_thread_status is a cheap poll; a provider error can be megabytes. */
export const LAST_ERROR_CHARS = 500;
/** A failure's message is the one thing a launcher needs to act on, so it gets more room. */
const FAILURE_MESSAGE_CHARS = 1_000;

export function threadPhase(
  runStatus: OrchestrationV2RunStatus | "idle" | null,
  pendingKind: string | null,
): OrchestratorMcpThreadPhase {
  switch (runStatus) {
    case null:
    case "idle":
      return "idle";
    case "preparing":
    case "queued":
      return "queued";
    case "starting":
      return "starting";
    case "running":
    case "waiting": {
      if (pendingKind !== null && !SELF_ANSWERED_KINDS.has(pendingKind)) {
        return USER_INPUT_KINDS.has(pendingKind) ? "waiting_input" : "waiting_approval";
      }
      return runStatus;
    }
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return runStatus;
  }
}

export function isTerminalPhase(phase: OrchestratorMcpThreadPhase): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "interrupted" ||
    phase === "cancelled" ||
    phase === "rolled_back"
  );
}

export function excerpt(text: string, max = LAST_MESSAGE_EXCERPT_CHARS): string {
  const trimmed = text.trim();
  // Cut before splitting, so a huge text is not turned into an array of characters.
  const chars = Array.from(trimmed.slice(0, max * 2));
  return chars.length <= max && trimmed.length <= max * 2
    ? chars.join("")
    : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Why a run failed before its agent said anything, from its error item: during workspace
 * preparation (with the preparation log), or when its provider would not start it.
 */
export function runFailure(
  run: Pick<OrchestrationV2Run, "id" | "status" | "workspacePreparation"> | null,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestratorMcpRunFailure | null {
  if (run === null || run.status !== "failed") return null;
  const ofRun = items.filter((item) => item.runId === run.id);
  if (ofRun.some((item) => item.type === "assistant_message")) return null;
  const error = ofRun
    .flatMap((item) => (item.type === "error" && item.status === "failed" ? [item] : []))
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  if (error === undefined) return null;
  const preparation = error.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE;
  return {
    runId: run.id,
    stage: preparation ? "workspace_preparation" : "before_first_message",
    errorClass: error.failure.class,
    retryable: error.failure.retryable,
    message: error.failure.message,
    log: error.failure.log ?? null,
    canRetry: preparation && run.workspacePreparation !== undefined,
  };
}

/** Keeps the end of a log, where the failure is. */
function logTail(log: string): string {
  return log.length <= ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS
    ? log
    : `…${log.slice(log.length - ORCHESTRATION_V2_PROVIDER_FAILURE_LOG_MAX_CHARS + 1)}`;
}

/**
 * Bounds the parts of a status a thread controls, for a status from any host,
 * including one from a GOAT that predates the bounds.
 */
export function boundedStatus<
  S extends Pick<
    OrchestratorMcpThreadStatusResult,
    "lastMessage" | "lastError" | "cloudTask" | "failure"
  >,
>(status: S) {
  const { cloudTask: rawCloudTask, failure, ...fields } = status;
  const cloudTask = cloudTaskView(rawCloudTask);
  return {
    ...fields,
    ...(cloudTask === undefined ? {} : { cloudTask }),
    ...(failure === undefined
      ? {}
      : {
          failure:
            failure === null
              ? null
              : {
                  ...failure,
                  message: excerpt(failure.message, FAILURE_MESSAGE_CHARS),
                  log: failure.log === null ? null : logTail(failure.log),
                },
        }),
    lastMessage:
      status.lastMessage === null
        ? null
        : { ...status.lastMessage, excerpt: excerpt(status.lastMessage.excerpt) },
    lastError: status.lastError === null ? null : excerpt(status.lastError, LAST_ERROR_CHARS),
  };
}

const iso = (value: DateTime.DateTime | null | undefined) =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

/**
 * A local thread's status from its shell and the runs it names (the active and
 * latest run), with those runs' turn items for the message excerpt.
 * A pending request counts only while the described run is live.
 */
export function statusFromShell(
  shell: OrchestrationV2ThreadShell,
  runs: ReadonlyArray<OrchestrationV2Run>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Omit<OrchestratorMcpThreadStatusResult, "watch"> {
  const describedRunId = shell.activeRunId ?? shell.latestRunId;
  const run = runs.find((candidate) => candidate.id === describedRunId) ?? null;
  const latest = runs.find((candidate) => candidate.id === shell.latestRunId) ?? null;
  const runStatus = run?.status ?? (describedRunId === null ? null : shell.status);
  const live = runStatus === "running" || runStatus === "waiting";
  const request = live ? shell.pendingRuntimeRequest : null;
  const phase = threadPhase(runStatus, request?.kind ?? null);
  // Shell rows carry no message bodies, so the latest message comes from the runs' items.
  const message =
    items
      .flatMap((item) =>
        (item.type === "user_message" || item.type === "assistant_message") &&
        item.text.trim().length > 0
          ? [item]
          : [],
      )
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .at(-1) ?? null;
  return boundedStatus({
    threadId: shell.id,
    title: shell.title,
    phase,
    terminal: isTerminalPhase(phase),
    run:
      run === null
        ? null
        : {
            runId: run.id,
            status: run.status,
            requestedAt: DateTime.formatIso(run.requestedAt),
            startedAt: iso(run.startedAt),
            completedAt: iso(run.completedAt),
          },
    queuedRunId:
      run !== null &&
      latest !== null &&
      latest.id !== run.id &&
      threadPhase(latest.status, null) === "queued"
        ? latest.id
        : null,
    pendingRequest:
      request === null
        ? null
        : {
            requestId: request.id,
            kind: request.kind,
            since: DateTime.formatIso(request.createdAt),
          },
    lastActivityAt: DateTime.formatIso(shell.updatedAt),
    lastMessage:
      message === null
        ? null
        : {
            role: message.type === "user_message" ? "user" : "assistant",
            excerpt: excerpt(message.text),
            at: DateTime.formatIso(message.updatedAt),
          },
    lastError: shell.lastError ?? null,
    lastErrorClass: shell.lastErrorClass ?? null,
    failure: runFailure(run, items),
  });
}

/**
 * The status of a thread on a host whose GOAT predates goat_thread_status, from
 * a one-item goat_thread_read. That read names no request kind, so a run with
 * open requests is reported as waiting.
 */
export function statusFromRead(
  read: OrchestratorMcpThreadReadResult,
): Omit<OrchestratorMcpThreadStatusResult, "watch"> {
  const thread = read.thread;
  const describedRunId = thread.activeRunId ?? thread.latestRunId;
  const run = read.recentRuns.find((candidate) => candidate.runId === describedRunId) ?? null;
  const status = run?.status ?? thread.status;
  const pending = thread.pendingRequestCount > 0 && (status === "running" || status === "waiting");
  const phase = pending ? "waiting" : threadPhase(status, null);
  return {
    ...(read.cloudTask === undefined ? {} : { cloudTask: read.cloudTask }),
    ...(read.host === undefined ? {} : { host: read.host }),
    threadId: thread.threadId,
    title: thread.title,
    phase,
    terminal: isTerminalPhase(phase),
    run:
      run === null
        ? null
        : {
            runId: run.runId,
            status: run.status,
            requestedAt: run.requestedAt,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
          },
    queuedRunId:
      thread.activeRunId !== null &&
      thread.latestRunId !== null &&
      thread.latestRunId !== thread.activeRunId
        ? thread.latestRunId
        : null,
    pendingRequest: pending ? { requestId: null, kind: null, since: null } : null,
    lastActivityAt: thread.updatedAt,
    lastMessage: null,
    lastError: null,
  };
}
