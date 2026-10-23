import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2RunStatus,
  ProjectId,
  ModelSelection,
  OrchestrationV2ProviderFailureClass,
  OrchestratorMcpRunFailure,
  RunId,
  RuntimeMode,
  ThreadId,
  ThreadReplicaMetadata,
  type ThreadReplicaStatus,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

/**
 * Decisions and messages for launch watches, kept free of I/O so they can be
 * tested directly. A launch watch is a launcher thread's standing request to
 * hear about another thread it started (goat_thread_launch,
 * goat_ssh_thread_launch) or asked to watch; LaunchWatchService stores and
 * follows them. A launch from outside any thread can opt into a launcherless
 * watch, which has no thread to wake and reports only to the completion webhook.
 */

export const LaunchWatchOutage = Schema.Struct({
  /** When this run of failed contacts began (epoch ms). */
  since: Schema.Number,
  /** Numbers outage episodes, so each one is reported at most once. */
  episode: Schema.Number,
  failures: Schema.Number,
  notified: Schema.Boolean,
  nextRetryAt: Schema.Number,
  lastError: Schema.String,
});
export type LaunchWatchOutage = typeof LaunchWatchOutage.Type;

/**
 * Where a launch routed its webhook reports, kept with the watch so it survives a restart. A
 * named target is looked up in settings on each post; an inline one keeps its signing secret
 * in the server secret store under `secretName`, never in this file.
 */
export const LaunchWatchWebhookTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("named"), name: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("inline"),
    url: Schema.String,
    secretName: Schema.NullOr(Schema.String),
  }),
]);
export type LaunchWatchWebhookTarget = typeof LaunchWatchWebhookTarget.Type;

const WatchRecovery = Schema.Struct({
  request: Schema.Struct({
    operationId: Schema.String,
    projectId: ProjectId,
    modelSelection: Schema.optional(ModelSelection),
  }),
  destinationHost: Schema.NullOr(Schema.String),
  capturedRunId: RunId,
  capturedDigest: Schema.String,
  requestDigest: Schema.String,
  sourceRunId: RunId,
  status: Schema.Literals(["reserved", "launch_unknown", "launched"]),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  sourceInterrupted: Schema.Boolean,
});

export const LaunchWatch = Schema.Struct({
  id: Schema.String,
  /** Fresh whenever an absent watch is registered, so a stale follower cannot act on it. */
  incarnation: Schema.String,
  checkpointReplication: Schema.optional(Schema.Literals(["on", "off"])),
  replicaCeiling: Schema.optional(RuntimeMode),
  replica: Schema.optional(ThreadReplicaMetadata),
  replicaAttempt: Schema.optional(Schema.Struct({ runId: RunId, reason: Schema.String })),
  replicaAttempts: Schema.optional(Schema.Array(RunId)),
  recovery: Schema.optional(WatchRecovery),
  /** Unwatch detaches reports; it cannot erase a retired source's fence. */
  detached: Schema.optional(Schema.Boolean),
  /** Null for a launch from outside any thread, whose reports go only to the completion webhook. */
  launcherThreadId: Schema.NullOr(ThreadId),
  /**
   * The outside caller a launcherless watch belongs to (its MCP request namespace),
   * so another outside caller cannot see or re-arm it. Null for a thread launcher's
   * watch, and for launcherless watches from before owners were recorded.
   */
  owner: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * The runtime mode a launcherless watch's remote reads run at: what its outside
   * caller was approved for at launch. A thread launcher's current mode is used instead.
   */
  ceiling: Schema.NullOr(RuntimeMode).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** SSH alias of the target's environment; null for this environment. */
  host: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  /** The target's project, for targets in this environment. */
  projectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(Schema.String),
  /** Runs still to report, oldest first. */
  pendingRuns: Schema.Array(RunId),
  /** The most recently reported runs, so a run is never reported twice. */
  reportedRuns: Schema.Array(RunId),
  /** The most recently reported pending requests, keyed by questionKey. */
  reportedQuestions: Schema.Array(Schema.String),
  /** Number of the last outage episode that ended; the next one counts from it. */
  lastEpisode: Schema.Number,
  outage: Schema.NullOr(LaunchWatchOutage),
  /**
   * Wakes that failed to queue, by their first command id: how many attempts
   * were made. A retry uses a fresh command id, since the orchestrator records
   * a failed command as rejected and would refuse the same id again.
   */
  deliveryAttempts: Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Whether reports also go to the default completion webhook (`completionWebhook.url`). */
  notifyWebhook: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The one receiver this launch chose; when set, the default webhook never gets its reports. */
  webhookTarget: Schema.NullOr(LaunchWatchWebhookTarget).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** When a run was last added; a launcherless watch's retention counts from it. */
  armedAt: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type LaunchWatch = typeof LaunchWatch.Type;

export const replicaStatus = (watch: LaunchWatch): ThreadReplicaStatus => ({
  checkpointReplication: watch.checkpointReplication ?? "off",
  replica:
    watch.replica === undefined
      ? null
      : {
          runId: watch.replica.runId,
          capturedAt: watch.replica.capturedAt,
          bytes: watch.replica.bytes,
          sha256: watch.replica.sha256,
          contextSha256: watch.replica.contextSha256,
          repositoryKey: watch.replica.repositoryKey,
        },
  skippedReason:
    watch.replicaAttempt?.reason === "captured" ? null : (watch.replicaAttempt?.reason ?? null),
  recovery:
    watch.recovery === undefined
      ? null
      : {
          operationId: watch.recovery.request.operationId,
          status: watch.recovery.status,
          destinationHost: watch.recovery.destinationHost,
          threadId: watch.recovery.threadId,
          runId: watch.recovery.runId,
          sourceInterruptPending: !watch.recovery.sourceInterrupted,
        },
});

export const LaunchWatchDocument = Schema.Struct({
  version: Schema.Literal(1),
  watches: Schema.Array(LaunchWatch),
});
export type LaunchWatchDocument = typeof LaunchWatchDocument.Type;

const REPORTED_LIMIT = 20;
/** Failed contacts in a row before the launcher hears that the host is unavailable. */
export const OUTAGE_NOTICE_FAILURES = 3;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
export const EXCERPT_MAX_CHARS = 1_500;
/** A wake quotes only the start of the last message; the thread holds the rest. */
const WAKE_EXCERPT_LINES = 4;
const WAKE_EXCERPT_MAX_CHARS = 400;
const SUMMARY_MAX_CHARS = 120;

/** Run statuses after which a run does no more work. */
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
] as const satisfies ReadonlyArray<OrchestrationV2RunStatus>;
export type LaunchWatchTerminalStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export const isTerminalStatus = (status: string): status is LaunchWatchTerminalStatus =>
  (TERMINAL_RUN_STATUSES as ReadonlyArray<string>).includes(status);

/** SSH aliases resolve trimmed (SshRemoteDispatch.resolveHost), so watches key them the same way. */
export function normalizeHost(host: string | null | undefined): string | null {
  const trimmed = host?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

export function launchWatchId(input: {
  readonly launcherThreadId: string | null;
  readonly owner?: string | null;
  readonly host: string | null;
  readonly threadId: string;
}): string {
  const owner = input.launcherThreadId === null ? (input.owner ?? null) : null;
  return [
    input.launcherThreadId ?? "",
    input.host ?? "",
    input.threadId,
    ...(owner === null ? [] : [owner]),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function newLaunchWatch(input: {
  readonly launcherThreadId: ThreadId | null;
  readonly owner?: string | null;
  readonly ceiling?: RuntimeMode | null;
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly title: string | null;
  readonly incarnation: string;
  readonly notifyWebhook: boolean;
  readonly webhookTarget?: LaunchWatchWebhookTarget | null;
  readonly now: number;
}): LaunchWatch {
  return {
    id: launchWatchId(input),
    incarnation: input.incarnation,
    launcherThreadId: input.launcherThreadId,
    owner: input.launcherThreadId === null ? (input.owner ?? null) : null,
    ceiling: input.ceiling ?? null,
    host: input.host,
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    pendingRuns: [],
    reportedRuns: [],
    reportedQuestions: [],
    lastEpisode: 0,
    outage: null,
    deliveryAttempts: {},
    notifyWebhook: input.notifyWebhook,
    webhookTarget: input.webhookTarget ?? null,
    armedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** The wake to send on this attempt: the first keeps its ids, later ones get fresh ones. */
export function wakeAttempt(watch: LaunchWatch, wake: LaunchWatchWake): LaunchWatchWake {
  const attempt = watch.deliveryAttempts[wake.commandId] ?? 0;
  if (attempt === 0) return wake;
  return {
    ...wake,
    commandId: CommandId.make(`${wake.commandId}:attempt-${attempt}`),
    messageId: MessageId.make(`${wake.messageId}:attempt-${attempt}`),
  };
}

/** Records a failed attempt at a wake, so the next one uses fresh ids. */
export function recordFailedAttempt(watch: LaunchWatch, wake: LaunchWatchWake): LaunchWatch {
  return {
    ...watch,
    deliveryAttempts: {
      ...watch.deliveryAttempts,
      [wake.commandId]: (watch.deliveryAttempts[wake.commandId] ?? 0) + 1,
    },
  };
}

/** Forgets the attempts at a wake once it is settled. */
export function clearAttempts(watch: LaunchWatch, wake: LaunchWatchWake): LaunchWatch {
  if (!(wake.commandId in watch.deliveryAttempts)) return watch;
  const { [wake.commandId]: _settled, ...rest } = watch.deliveryAttempts;
  return { ...watch, deliveryAttempts: rest };
}

const keepRecent = <A>(values: ReadonlyArray<A>, value: A) =>
  [...values.filter((existing) => existing !== value), value].slice(-REPORTED_LIMIT);

/** Adds a run to report; a run already pending or reported is left alone. */
export function addPendingRun(watch: LaunchWatch, runId: RunId, now: number): LaunchWatch {
  if (watch.pendingRuns.includes(runId) || watch.reportedRuns.includes(runId)) return watch;
  return { ...watch, pendingRuns: [...watch.pendingRuns, runId], armedAt: now, updatedAt: now };
}

/** Moves a run from pending to reported, whether or not a wake went out for it. */
export function settleRun(watch: LaunchWatch, runId: RunId, now: number): LaunchWatch {
  return {
    ...watch,
    pendingRuns: watch.pendingRuns.filter((pending) => pending !== runId),
    reportedRuns: keepRecent(watch.reportedRuns, runId),
    updatedAt: now,
  };
}

export const questionKey = (runId: RunId, requestId: string) => `${runId}/${requestId}`;

export function recordQuestion(watch: LaunchWatch, key: string, now: number): LaunchWatch {
  return { ...watch, reportedQuestions: keepRecent(watch.reportedQuestions, key), updatedAt: now };
}

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/**
 * Records one failed contact. The third failure in a row asks for the single
 * host_unavailable notice of this episode; later failures only back off.
 */
export function recordFailure(
  watch: LaunchWatch,
  now: number,
  error: string,
): { readonly next: LaunchWatch; readonly notify: boolean } {
  const current = watch.outage ?? {
    since: now,
    episode: watch.lastEpisode + 1,
    failures: 0,
    notified: false,
    nextRetryAt: now,
    lastError: error,
  };
  const failures = current.failures + 1;
  const notify = !current.notified && failures >= OUTAGE_NOTICE_FAILURES;
  return {
    next: {
      ...watch,
      outage: {
        ...current,
        failures,
        notified: current.notified || notify,
        nextRetryAt: now + backoffMs(failures),
        lastError: error,
      },
      updatedAt: now,
    },
    notify,
  };
}

/** A successful contact ends the outage episode. */
export function recordContact(watch: LaunchWatch, now: number): LaunchWatch {
  return watch.outage === null
    ? watch
    : { ...watch, lastEpisode: watch.outage.episode, outage: null, updatedAt: now };
}

function notificationOutcome(
  status: LaunchWatchTerminalStatus,
): OrchestrationV2Notification["outcome"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "cancelled";
  }
}

export interface LaunchWatchWake {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const where = (watch: LaunchWatch) =>
  watch.host === null ? "this environment" : `host ${watch.host}`;

const named = (watch: LaunchWatch, title: string | null) => {
  const label = title ?? watch.title;
  return label === null ? "Launched thread" : `Launched thread "${label}"`;
};

const identity = (watch: LaunchWatch) => `threadId ${watch.threadId}, ${where(watch)}`;

const toolArgs = (watch: LaunchWatch) =>
  watch.host === null
    ? `{threadId: "${watch.threadId}"}`
    : `{threadId: "${watch.threadId}", host: "${watch.host}"}`;

/** The goat_call form, which works whether or not the target tool is listed. */
const call = (path: string, args: string) => `goat_call {path: "${path}", args: ${args}}`;

const stopHint = (watch: LaunchWatch) =>
  `Stop these reports with ${call("thread.unwatch", toolArgs(watch))}.`;

/** The first lines of a message, cut at a line or word; says when it left text out. */
function briefExcerpt(text: string): { readonly text: string; readonly cut: boolean } {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const head = lines.slice(0, WAKE_EXCERPT_LINES).join("\n");
  const short = truncate(head, WAKE_EXCERPT_MAX_CHARS);
  return { text: short, cut: short !== lines.join("\n") };
}

/**
 * Command and message ids derive from the watch and the event, so a wake
 * replayed after a crash between dispatch and the state write is a receipt
 * replay, not a second message.
 */
const wakeIds = (watch: LaunchWatch, event: string) => {
  const key = `launch-watch:${watch.id}:${event}`;
  return {
    commandId: CommandId.make(`server:${key}`),
    messageId: MessageId.make(`message:${key}`),
  };
};

export function finishedWake(input: {
  readonly watch: LaunchWatch;
  readonly runId: RunId;
  readonly status: LaunchWatchTerminalStatus;
  readonly title: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly excerpt: string | null;
  /** Why the run failed before its agent's first message, when it did. */
  readonly failure?: OrchestratorMcpRunFailure | null;
}): LaunchWatchWake {
  const { watch } = input;
  if (input.status === "failed" && input.excerpt === null && input.failure != null) {
    return launchFailedWake({ ...input, failure: input.failure });
  }
  const name = named(watch, input.title);
  // The UI shows the longer detail; the agent reads the rest from the thread when it needs it.
  const excerpt = input.excerpt === null ? null : truncate(input.excerpt, EXCERPT_MAX_CHARS);
  const brief = input.excerpt === null ? null : briefExcerpt(input.excerpt);
  const place = [
    input.branch === null ? null : `branch ${input.branch}`,
    input.worktreePath === null ? null : `worktree ${input.worktreePath}`,
  ].filter((part) => part !== null);
  const read = call("thread.read", toolArgs(watch));
  const lines = [
    `${name} (${identity(watch)}) finished run ${input.runId} with status ${input.status}${place.length === 0 ? "" : ` on ${place.join(", ")}`}.`,
    ...(brief === null ? [] : ["Last message:", brief.text]),
    `${brief?.cut === true ? `The message continues; read it with ${read}.` : `Read the thread with ${read}.`} ${stopHint(watch)}`,
  ];
  return {
    ...wakeIds(watch, `run:${input.runId}`),
    text: lines.join("\n"),
    notification: {
      source: { kind: "background_task" },
      outcome: notificationOutcome(input.status),
      summary: truncate(`${name} ${input.status.replace("_", " ")}`, SUMMARY_MAX_CHARS),
      ...(excerpt === null ? {} : { detail: excerpt }),
    },
  };
}

/**
 * What a host's goat_thread_status says about a failed run. A host from before
 * `failure` existed still names the thread's last error, so its launcher hears that much.
 */
export const RemoteRunFailureStatus = Schema.Struct({
  run: Schema.NullOr(Schema.Struct({ runId: Schema.String })),
  lastError: Schema.NullOr(Schema.String),
  lastErrorClass: Schema.optional(Schema.NullOr(OrchestrationV2ProviderFailureClass)),
  failure: Schema.optional(Schema.NullOr(OrchestratorMcpRunFailure)),
});
export type RemoteRunFailureStatus = typeof RemoteRunFailureStatus.Type;

const OLDER_HOST_PREPARATION_PREFIX = "Workspace preparation failed";

export function failureFromRemoteStatus(
  status: RemoteRunFailureStatus,
  runId: RunId,
): OrchestratorMcpRunFailure | null {
  if (status.run?.runId !== runId) return null;
  if (status.failure !== undefined) return status.failure;
  if (status.lastError === null) return null;
  return {
    runId,
    stage: status.lastError.startsWith(OLDER_HOST_PREPARATION_PREFIX)
      ? "workspace_preparation"
      : "before_first_message",
    errorClass: status.lastErrorClass ?? "unknown",
    retryable: null,
    message: status.lastError,
    log: null,
    canRetry: false,
  };
}

const AUTH_FAILURE = /authenticat|credential|permission denied|could not read username/i;

/** One concrete next step for a run that failed before its agent started. */
function suggestedAction(failure: OrchestratorMcpRunFailure, host: string | null): string {
  const machine = host === null ? "this machine" : host;
  if (failure.stage === "workspace_preparation") {
    if (failure.retryable === true || /timed out|no progress|stalled/i.test(failure.message))
      return `Git on ${machine} was slow or stuck, which a retry usually gets past. If the retry fails the same way, run the same git fetch in that repository on ${machine} to see whether the remote or the local repository is slow.`;
    if (AUTH_FAILURE.test(failure.message))
      return `Fix Git credentials or SSH access for that repository on ${machine}, then retry.`;
    if (/setup script/i.test(failure.message))
      return "Fix the project's setup script (its output is in the log), then retry.";
    return `Check the base ref, branch and repository named in the error on ${machine}, then retry or launch again with a corrected workspace.`;
  }
  switch (failure.errorClass) {
    case "usage_limit":
      return "The provider's usage limit is reached. Launch again after it resets, or with another model.";
    case "permission_error":
      return `The provider refused to start. Check its sign-in and permissions on ${machine}, then launch again.`;
    case "transport_error":
      return `The provider could not be reached from ${machine}. Launch again once it is reachable.`;
    case "validation_error":
      return "The provider rejected the request, often the model or its options. Launch again with a supported model.";
    default:
      return "Read the thread, then send it a new message or launch again.";
  }
}

/** Keeps the end of a log, where a failure shows. */
const tail = (text: string, max: number) =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;

function launchFailedWake(input: {
  readonly watch: LaunchWatch;
  readonly runId: RunId;
  readonly status: LaunchWatchTerminalStatus;
  readonly title: string | null;
  readonly failure: OrchestratorMcpRunFailure;
}): LaunchWatchWake {
  const { watch, failure } = input;
  const name = named(watch, input.title);
  const stage =
    failure.stage === "workspace_preparation"
      ? "while GOAT prepared its workspace"
      : "before its agent's first message";
  const kind = [
    `error class ${failure.errorClass}`,
    failure.retryable === null ? null : failure.retryable ? "retryable" : "not retryable",
  ]
    .filter((part) => part !== null)
    .join(", ");
  const retry = failure.canRetry
    ? `Retry with ${call("thread.retry", toolArgs(watch))}; the user can also press Retry on the failure in that thread. This watch reports the retried run.`
    : failure.stage === "workspace_preparation"
      ? `Retry it from a GOAT client connected to ${watch.host ?? "this environment"} (Retry on the failure in that thread), or launch again.`
      : null;
  const log = failure.log === null ? null : tail(failure.log, EXCERPT_MAX_CHARS * 2);
  const lines = [
    `${name} (${identity(watch)}) failed ${stage}, in run ${input.runId} (${kind}).`,
    "",
    truncate(failure.message, EXCERPT_MAX_CHARS),
    ...(log === null ? [] : ["", "Preparation log (last lines, redacted):", log]),
    "",
    `Suggested action: ${suggestedAction(failure, watch.host)}`,
    ...(retry === null ? [] : [retry]),
    `${call("thread.status", toolArgs(watch))} shows the same failure. ${stopHint(watch)}`,
  ];
  const detail = truncate(
    log === null ? failure.message : `${failure.message}\n\n${tail(log, EXCERPT_MAX_CHARS / 2)}`,
    EXCERPT_MAX_CHARS,
  );
  return {
    ...wakeIds(watch, `run:${input.runId}`),
    text: lines.join("\n"),
    notification: {
      source: { kind: "background_task" },
      outcome: "failed",
      summary: truncate(
        `${name} failed ${failure.stage === "workspace_preparation" ? "preparing its workspace" : "before starting"}`,
        SUMMARY_MAX_CHARS,
      ),
      detail,
    },
  };
}

export function questionWake(input: {
  readonly watch: LaunchWatch;
  readonly runId: RunId;
  readonly requestId: string;
  readonly kind: string | null;
  readonly title: string | null;
}): LaunchWatchWake {
  const { watch } = input;
  const name = named(watch, input.title);
  const request =
    input.kind === null ? "a request" : `a ${input.kind.replaceAll("_", " ")} request`;
  const answer =
    input.kind === "user_input"
      ? watch.host !== null
        ? `Read it with ${call("pending_request.read", `{host: "${watch.host}", threadId: "${watch.threadId}", requestId: "${input.requestId}"}`)} and answer with pending_request.respond using the same host, threadId, and requestId (reason required) if you can decide, or forward it to the user.`
        : `Read it with ${call("pending_request.read", `{threadId: "${watch.threadId}", requestId: "${input.requestId}"}`)} and answer with pending_request.respond if you can decide, or leave it to the user.`
      : watch.host !== null
        ? `It can be answered in that thread from a client connected to ${watch.host}.`
        : input.kind === null
          ? "Read the request in that thread from a GOAT client and tell the user."
          : "An approval can only be given in that thread from a GOAT client, so tell the user.";
  return {
    ...wakeIds(watch, `question:${questionKey(input.runId, input.requestId)}`),
    text: `${name} (${identity(watch)}) is waiting on ${request} (${input.requestId}) in run ${input.runId} and cannot continue until it is answered. ${answer} ${stopHint(watch)}`,
    notification: {
      source: { kind: "background_task" },
      outcome: "updated",
      summary: truncate(`${name} is waiting for an answer`, SUMMARY_MAX_CHARS),
    },
  };
}

export function outageWake(input: {
  readonly watch: LaunchWatch;
  readonly outage: LaunchWatchOutage;
}): LaunchWatchWake {
  const { watch, outage } = input;
  return {
    ...wakeIds(watch, `outage:${watch.incarnation}:${outage.episode}`),
    text: `host_unavailable: GOAT cannot reach ${where(watch)} to follow ${named(watch, null).toLowerCase()} (${identity(watch)}). ${outage.failures} attempts failed, the last with: ${truncate(outage.lastError, 500)} It keeps retrying with backoff and reports the run once it reaches the host again; the thread itself may still be running there. ${watch.replica === undefined ? "No checkpoint copy is available." : `A checkpoint from ${watch.replica.capturedAt} (${watch.replica.bytes} bytes) is retained. Explicit recovery is available through thread.handoff_host; the disconnected source can still produce external side effects.`} ${stopHint(watch)}`,
    notification: {
      source: { kind: "background_task" },
      outcome: "unknown",
      summary: truncate(
        `Cannot reach ${watch.host ?? "this environment"} to follow a launched thread`,
        SUMMARY_MAX_CHARS,
      ),
    },
  };
}

export function goneWake(input: {
  readonly watch: LaunchWatch;
  readonly reason: string;
}): LaunchWatchWake {
  const { watch } = input;
  const name = named(watch, null);
  return {
    ...wakeIds(watch, `gone:${watch.incarnation}`),
    text: `${name} (${identity(watch)}) can no longer be followed: ${input.reason} GOAT stopped watching it.`,
    notification: {
      source: { kind: "background_task" },
      outcome: "unknown",
      summary: truncate(`${name} can no longer be followed`, SUMMARY_MAX_CHARS),
    },
  };
}
