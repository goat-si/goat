import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2RunStatus,
  ProjectId,
  ModelSelection,
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

const STOP_HINT =
  "Stop these reports with goat_thread_unwatch; goat_thread_watch_list shows every watch.";

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
}): LaunchWatchWake {
  const { watch } = input;
  const name = named(watch, input.title);
  const excerpt = input.excerpt === null ? null : truncate(input.excerpt, EXCERPT_MAX_CHARS);
  const place = [
    input.branch === null ? null : `branch ${input.branch}`,
    input.worktreePath === null ? null : `worktree ${input.worktreePath}`,
  ].filter((part) => part !== null);
  const lines = [
    `${name} (${identity(watch)}) finished run ${input.runId} with status ${input.status}.`,
    ...(place.length === 0 ? [] : [`It ran on ${place.join(", ")}.`]),
    ...(excerpt === null ? [] : ["", "Last assistant message of that run:", excerpt]),
    "",
    `Read it with goat_thread_read ${toolArgs(watch)}. A goat_thread_send to it is reported the same way when that run ends. ${STOP_HINT}`,
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
        ? `Read it with goat_pending_request_read {host: "${watch.host}", threadId: "${watch.threadId}", requestId: "${input.requestId}"} and answer with goat_pending_request_respond using the same host, threadId, and requestId (reason required) if you can decide, or forward it to the user.`
        : `Read it with goat_pending_request_read {threadId: "${watch.threadId}", requestId: "${input.requestId}"} and answer with goat_pending_request_respond if you can decide, or leave it to the user.`
      : watch.host !== null
        ? `It can be answered in that thread from a client connected to ${watch.host}.`
        : input.kind === null
          ? "Read the request in that thread from a GOAT client and tell the user."
          : "An approval can only be given in that thread from a GOAT client, so tell the user.";
  return {
    ...wakeIds(watch, `question:${questionKey(input.runId, input.requestId)}`),
    text: `${name} (${identity(watch)}) is waiting on ${request} (${input.requestId}) in run ${input.runId} and cannot continue until it is answered. ${answer} ${STOP_HINT}`,
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
    text: `host_unavailable: GOAT cannot reach ${where(watch)} to follow ${named(watch, null).toLowerCase()} (${identity(watch)}). ${outage.failures} attempts failed, the last with: ${truncate(outage.lastError, 500)} It keeps retrying with backoff and reports the run once it reaches the host again; the thread itself may still be running there. ${watch.replica === undefined ? "No checkpoint copy is available." : `A checkpoint from ${watch.replica.capturedAt} (${watch.replica.bytes} bytes) is retained. Explicit recovery is available through goat_thread_handoff_host; the disconnected source can still produce external side effects.`} ${STOP_HINT}`,
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
