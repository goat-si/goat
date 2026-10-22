import * as PressureNudger from "../fleet/pressure/PressureNudger.ts";
import { admitLaunch } from "./pressureAdmission.ts";
import {
  OrchestratorMcpFailure,
  ThreadReplicaCaptureResult,
  ThreadReplicaPayload,
  ThreadReplicaMetadata,
  THREAD_REPLICA_MAX_BYTES,
  THREAD_REPLICA_RETENTION_MS,
  ThreadReplicaRestoreResult,
  type ThreadReplicaRecoveryInput,
  MessageId,
  ModelSelection,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpRunFailure,
  OrchestratorMcpThreadWaitResult,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { localQuestionLauncher } from "../orchestration-v2/QuestionEscalationService.ts";
import { forkParked } from "../serverActivation.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as CompletionWebhook from "./completionWebhook.ts";
import {
  addPendingRun,
  clearAttempts,
  EXCERPT_MAX_CHARS,
  failureFromRemoteStatus,
  finishedWake,
  goneWake,
  isTerminalStatus,
  type LaunchWatch,
  LaunchWatchDocument,
  launchWatchId,
  type LaunchWatchTerminalStatus,
  type LaunchWatchWake,
  type LaunchWatchWebhookTarget,
  newLaunchWatch,
  normalizeHost,
  outageWake,
  questionKey,
  questionWake,
  recordContact,
  recordFailure,
  recordQuestion,
  recordFailedAttempt,
  RemoteRunFailureStatus,
  settleRun,
  wakeAttempt,
} from "./launchWatch.ts";
import { runFailure } from "./threadStatus.ts";

/**
 * Wakes a thread when a thread it launched finishes, so orchestrators do not
 * poll. The launcher's server records a watch at launch time and follows each
 * pending run over the connection it already has: this environment's
 * projections, or the SSH-dispatched MCP session of the target's host,
 * authorized as the launcher. A followed run that ends, a question the thread
 * waits on, and a host that stays unreachable each queue one message on the
 * launcher. Watches live in a JSON file under the state directory, so they
 * survive restarts without a database migration.
 *
 * A launch from outside any thread may opt into a launcherless watch. It is
 * followed the same way, at the runtime mode its caller was approved for, but
 * its reports go only to the completion webhook. It belongs to the outside
 * caller that launched (its MCP request namespace), and only that caller sees
 * it in goat_thread_status. Once its run is reported it stays dormant, like a
 * launcher's watch, so a later goat_thread_send from the same caller re-arms
 * it and that run reaches the webhook too.
 *
 * Dormant watches expire: a launcher's after a week without changes, a
 * launcherless one a week after it was last armed. An expired watch is treated
 * as gone, and a periodic sweep drops it and releases any inline secret.
 */

/** How long one local wait lasts before the follower looks for pending questions. */
const LOCAL_TICK_MS = 30_000;
/** The same for a remote thread; each tick is one long-poll over SSH. */
const REMOTE_TICK_MS = 2 * 60_000;
/** Extra time a remote wait gets to answer after its own timeout. */
const REMOTE_ANSWER_MARGIN_MS = 60_000;
/** Bound on one whole remote step, including SSH setup. */
const REMOTE_STEP_LIMIT_MS = REMOTE_TICK_MS + 3 * 60_000;
const REMOTE_READ_TIMEOUT_MS = 60_000;
/** A watch with nothing left to report is dropped this long after its last change. */
const DORMANT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * A launcherless watch has no thread that could unwatch it, so it is dropped
 * this long after it was last armed even while its run is still owed, for
 * example when the host never comes back or a question is never answered.
 */
const LAUNCHERLESS_RETENTION_MS = DORMANT_RETENTION_MS;
/** How often dormant watches past their retention are dropped while the server runs. */
const SWEEP_MS = 60 * 60_000;
/** Pause before retrying after a changed caller, an unqueued wake or an unsaved state. */
const RETRY_MS = 30_000;
const TAIL_WINDOW = 40;
const TAIL_PAGE = 20;
const TAIL_PAGES = 3;

export class LaunchWatchStoreError extends Data.TaggedError("LaunchWatchStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LaunchWatchTarget {
  readonly launcherThreadId: ThreadId;
  readonly host: string | null | undefined;
  readonly threadId: ThreadId;
}

/**
 * A watch's key. A null launcher names the launcherless watch of one outside
 * caller, identified by its MCP request namespace.
 */
export type LaunchWatchKey = Omit<LaunchWatchTarget, "launcherThreadId"> &
  (
    | { readonly launcherThreadId: ThreadId }
    | { readonly launcherThreadId: null; readonly owner: string }
  );

interface ExternalLaunchWatchInput {
  /** The outside caller's MCP request namespace; only it can see and re-arm the watch. */
  readonly owner: string;
  readonly host: string | null | undefined;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly title: string | null;
  readonly runId: RunId;
  /** The outside caller's runtime mode ceiling; the watch's remote reads never exceed it. */
  readonly ceiling: RuntimeMode;
  /** The launch's webhook choice, from CompletionWebhook.resolveRoute. */
  readonly route: CompletionWebhook.WebhookRoute;
}

export interface LaunchWatchServiceShape {
  /**
   * Starts watching, or adds a run to an existing watch. A null run leaves a
   * new watch dormant until the launcher's next send to the thread.
   */
  readonly register: (
    input: LaunchWatchTarget & {
      readonly projectId: ProjectId | null;
      readonly title: string | null;
      readonly runId: RunId | null;
      /** Also post reports to the completion webhook. Omitted keeps an existing watch's choice. */
      readonly notifyWebhook?: boolean;
      /** The launch's chosen webhook receiver. Omitted keeps an existing watch's choice. */
      readonly webhookTarget?: LaunchWatchWebhookTarget | null;
      readonly checkpointReplication?: "on" | "off";
      readonly replicaCeiling?: RuntimeMode;
    },
  ) => Effect.Effect<LaunchWatch, LaunchWatchStoreError>;
  /**
   * Adds a run to an existing watch; without a watch it does nothing. A null
   * launcher re-arms the launcherless watch an outside caller's launch made.
   */
  readonly rearm: (
    input: LaunchWatchKey & { readonly runId: RunId },
  ) => Effect.Effect<void, LaunchWatchStoreError>;
  /** The watch under this key, if any. */
  readonly find: (
    input: LaunchWatchKey,
  ) => Effect.Effect<LaunchWatch | null, LaunchWatchStoreError>;
  readonly unwatch: (input: LaunchWatchTarget) => Effect.Effect<boolean, LaunchWatchStoreError>;
  readonly list: (
    launcherThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<LaunchWatch>, LaunchWatchStoreError>;
  /** Up to `limit` watches of threads on other machines, from every launcher, most recently updated first. */
  readonly listRemote: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<LaunchWatch>, LaunchWatchStoreError>;
  /**
   * Watches a launch from outside any thread when the completion webhook takes
   * it (a notifyTarget or notifyWebhook on the launch, or `completionWebhook.externalLaunches`).
   * Returns null, touching nothing, otherwise.
   */
  readonly watchExternal: (
    input: ExternalLaunchWatchInput,
  ) => Effect.Effect<LaunchWatch | null, LaunchWatchStoreError>;
  /** Checks a launch's notifyWebhook/notifyTarget before the launch starts; see CompletionWebhook. */
  readonly resolveRoute: CompletionWebhook.CompletionWebhookShape["resolveRoute"];
  /** Frees what resolveRoute kept, for a launch that recorded no watch. */
  readonly releaseRoute: (route: CompletionWebhook.WebhookRoute) => Effect.Effect<void>;
  readonly recover: (
    input: ThreadReplicaRecoveryInput & { readonly launcherThreadId: ThreadId },
    authorize: ThreadReplicaService.ReplicaAuthorization,
  ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;
}

export class LaunchWatchService extends Context.Service<
  LaunchWatchService,
  LaunchWatchServiceShape
>()("goat/mcp/LaunchWatchService") {}

export const LAUNCH_WATCH_FILE = "thread-launch-watches.json";
/**
 * Launcherless watches live in their own file. Servers from before they existed
 * require a launcher thread and would set the whole shared file aside, losing
 * every ordinary watch; this way they keep reading LAUNCH_WATCH_FILE.
 */
export const LAUNCHERLESS_WATCH_FILE = "thread-launch-watches-launcherless.json";

/** What one follower step learned about the run it follows. */
type StepResult =
  | {
      readonly _tag: "Terminal";
      readonly status: LaunchWatchTerminalStatus;
      /**
       * The run that ended: the followed one, or the running turn a queued
       * message was promoted into, which carries on its work.
       */
      readonly runId: RunId;
    }
  | {
      readonly _tag: "Running";
      readonly questions: ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;
      readonly escalatesUserInput?: boolean;
      readonly retryIfNoNewQuestions?: boolean;
    }
  | { readonly _tag: "RunMissing" }
  | { readonly _tag: "Gone"; readonly reason: string }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "CallerChanged" }
  | { readonly _tag: "Unreachable"; readonly error: string };

interface Details {
  readonly title: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly excerpt: string | null;
  readonly prUrl: string | null;
  /**
   * A registered cloud run GOAT could only link: its attach run ends without a result, so
   * the completion webhook is not told it completed. The launching thread still hears why.
   */
  readonly linkOnlyRegistration: boolean;
  /** Why the run failed before its agent's first message, when it did. */
  readonly failure: OrchestratorMcpRunFailure | null;
}

const noDetails: Details = {
  title: null,
  branch: null,
  worktreePath: null,
  excerpt: null,
  prUrl: null,
  linkOnlyRegistration: false,
  failure: null,
};

class LauncherGone extends Data.TaggedError("LauncherGone")<{}> {}

/**
 * Orchestrator refusals a retry cannot change. A previously rejected command
 * is not one of them: the orchestrator also records a command that failed for
 * a passing reason as rejected, so the wake is retried under a fresh id.
 */
const PERMANENT_DISPATCH_ERRORS = new Set([
  "OrchestratorCommandRejectedError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
]);

const isPermanentDispatchFailure = (cause: Cause.Cause<unknown>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      PERMANENT_DISPATCH_ERRORS.has(String(error._tag)),
  });

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(LaunchWatchDocument));
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(LaunchWatchDocument));
const encodeReplicaPayload = Schema.encodeEffect(Schema.fromJsonString(ThreadReplicaPayload));
const decodeReplicaPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ThreadReplicaPayload),
);
const encodeReplicaMetadata = Schema.encodeEffect(Schema.fromJsonString(ThreadReplicaMetadata));
const encodeReplicaModel = Schema.encodeEffect(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeRequestIds = Schema.decodeUnknownEffect(
  Schema.Struct({ requestIds: Schema.Array(Schema.String) }),
);
const decodeFailureStatus = Schema.decodeUnknownEffect(RemoteRunFailureStatus);

const describe = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : String(error);

const lastText = (texts: ReadonlyArray<string | null | undefined>) =>
  texts.findLast((text): text is string => typeof text === "string" && text.trim().length > 0) ??
  null;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const config = yield* ServerConfig.ServerConfig;
  const webhook = yield* CompletionWebhook.CompletionWebhook;
  const settings = yield* ServerSettings.ServerSettingsService;
  const pressure = yield* Effect.serviceOption(PressureNudger.PressureAdmissionService);
  const replicas = yield* ThreadReplicaService.ThreadReplicaService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, LAUNCH_WATCH_FILE);
  const launcherlessPath = path.join(config.stateDir, LAUNCHERLESS_WATCH_FILE);
  const replicaDir = path.join(config.stateDir, "watch-replicas");
  const replicaFile = (watch: LaunchWatch, runId: RunId) =>
    path.join(
      replicaDir,
      ThreadReplicaService.replicaDigest(`${watch.id}:${watch.incarnation}:${runId}`) + ".json",
    );

  let watches = new Map<string, LaunchWatch>();
  /** What each state file holds on disk, so a save rewrites only the file that changed. */
  const onDisk = new Map<string, string>();
  /** First sightings of local questions whose escalation message has not landed yet. */
  const missingEscalations = new Map<string, Map<string, number>>();
  /** One follower per watch with runs to report; only touched while holding the lock. */
  const followers = new Map<
    string,
    { readonly incarnation: string; fiber: Fiber.Fiber<void> | undefined }
  >();

  const locked = lock.withPermits(1);

  const writeFile = (filePath: string, list: ReadonlyArray<LaunchWatch>) =>
    Effect.gen(function* () {
      const contents = `${yield* encodeDocument({ version: 1, watches: list })}\n`;
      // A file that never existed is only created once it has a watch to hold.
      if (onDisk.get(filePath) === contents || (list.length === 0 && !onDisk.has(filePath))) return;
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      onDisk.set(filePath, contents);
    });

  const persist = (next: Map<string, LaunchWatch>) =>
    Effect.gen(function* () {
      const all = [...next.values()];
      // Launcherless first: moving them out of the shared file must not lose them.
      yield* writeFile(
        launcherlessPath,
        all.filter((watch) => watch.launcherThreadId === null),
      );
      yield* writeFile(
        statePath,
        all.filter((watch) => watch.launcherThreadId !== null),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LaunchWatchStoreError({
            message: `Could not save launch watches: ${describe(cause)}`,
            cause,
          }),
      ),
      Effect.tap(() =>
        Effect.suspend(() => {
          const previous = watches;
          watches = next;
          for (const watchId of missingEscalations.keys()) {
            if (!next.has(watchId)) missingEscalations.delete(watchId);
          }
          return releaseDroppedTargets(previous, next);
        }),
      ),
    );

  /** An inline target's secret goes once the last saved watch that used it does. */
  const releaseDroppedTargets = (
    previous: Map<string, LaunchWatch>,
    next: Map<string, LaunchWatch>,
  ) => {
    const kept = new Set(
      [...next.values()].flatMap((watch) =>
        watch.webhookTarget?.type === "inline" && watch.webhookTarget.secretName !== null
          ? [watch.webhookTarget.secretName]
          : [],
      ),
    );
    return Effect.forEach(
      [...previous.values()],
      (watch) =>
        watch.webhookTarget?.type === "inline" &&
        watch.webhookTarget.secretName !== null &&
        !kept.has(watch.webhookTarget.secretName)
          ? webhook.release(watch.webhookTarget)
          : Effect.void,
      { discard: true },
    );
  };

  /**
   * Applies one change to the map and saves it; memory moves only after the
   * write lands. Dormant watches past their retention are dropped on the way.
   */
  const save = (change: (current: Map<string, LaunchWatch>) => void) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next = new Map(watches);
      change(next);
      for (const [watchId, watch] of next) {
        if (dormantExpired(watch, now)) next.delete(watchId);
      }
      // Deleting a watch and releasing its inline secret finish together, or a
      // shutdown in between leaves a secret that no saved watch refers to.
      return yield* Effect.uninterruptible(persist(next));
    });

  const loadFile = (filePath: string) =>
    Effect.gen(function* () {
      const raw = yield* fs.readFileString(filePath).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(error),
        ),
      );
      if (Option.isNone(raw)) return [];
      onDisk.set(filePath, raw.value);
      if (raw.value.trim().length === 0) return [];
      const decoded = yield* Effect.result(decodeDocument(raw.value));
      if (decoded._tag === "Success") return decoded.success.watches;
      // Keep the unreadable file for inspection instead of overwriting it.
      const aside = `${filePath}.corrupt-${yield* Clock.currentTimeMillis}`;
      yield* fs.rename(filePath, aside);
      onDisk.delete(filePath);
      yield* Effect.logWarning("launch watches: unreadable state file moved aside", {
        path: aside,
        cause: decoded.failure,
      });
      return [];
    });

  const load = Effect.gen(function* () {
    const ordinary = yield* loadFile(statePath);
    const launcherless = yield* loadFile(launcherlessPath);
    return {
      watches: [...ordinary, ...launcherless],
      // Earlier builds kept launcherless watches in the shared file.
      misplaced: ordinary.some((watch) => watch.launcherThreadId === null),
    };
  });

  // ── following ────────────────────────────────────────────────────────

  /**
   * The launcher's runtime mode; a remote call never asks for more. A
   * launcherless watch uses the mode its outside caller was approved for.
   */
  const launcherCeiling = (watch: LaunchWatch) =>
    watch.launcherThreadId === null
      ? Effect.succeed<RuntimeMode>(watch.ceiling ?? "approval-required")
      : threads
          .getThreadShell(watch.launcherThreadId)
          .pipe(
            Effect.flatMap((shell): Effect.Effect<RuntimeMode, LauncherGone> =>
              shell === null || shell.deletedAt !== null || shell.archivedAt !== null
                ? Effect.fail(new LauncherGone())
                : Effect.succeed(shell.runtimeMode),
            ),
          );

  const callHost = (
    watch: LaunchWatch,
    host: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    ssh.callHostTool(
      { host, tool, arguments: args, writes: false, timeoutMs },
      launcherCeiling(watch),
    );

  const localStep = (watch: LaunchWatch, runId: RunId) =>
    Effect.gen(function* () {
      yield* launcherCeiling(watch);
      const shell = yield* threads.getThreadShell(watch.threadId);
      if (shell === null || shell.deletedAt !== null) {
        return { _tag: "Gone", reason: "the thread was deleted." } satisfies StepResult;
      }
      if (shell.archivedAt !== null) {
        return { _tag: "Gone", reason: "the thread was archived." } satisfies StepResult;
      }
      const waited = yield* threads
        .waitForThread({
          projectId: watch.projectId ?? shell.projectId,
          threadId: watch.threadId,
          runId,
          timeoutMs: LOCAL_TICK_MS,
          ignoreRequestIds: reportedRequestIds(watch, runId),
        })
        .pipe(
          Effect.map((result) => ({ _tag: "Waited", result }) as const),
          Effect.catchTags({
            ThreadManagementRunNotFoundError: () => Effect.succeed({ _tag: "RunMissing" } as const),
            ThreadManagementThreadNotFoundError: () =>
              Effect.succeed({ _tag: "ThreadMissing" } as const),
          }),
        );
      if (waited._tag === "RunMissing") return { _tag: "RunMissing" } satisfies StepResult;
      if (waited._tag === "ThreadMissing") {
        return { _tag: "Gone", reason: "the thread was deleted." } satisfies StepResult;
      }
      const status = waited.result.run?.status;
      if (status !== undefined && isTerminalStatus(status)) {
        // The wait follows a promoted queued message into the run it joined.
        return {
          _tag: "Terminal",
          status,
          runId: waited.result.run?.id ?? runId,
        } satisfies StepResult;
      }
      const records = yield* threads.getThreadRecords(watch.threadId, ["runtimeRequests"]);
      const questions = records.runtimeRequests
        .filter((request) => request.status === "pending" && request.kind !== "dynamic_tool_call")
        .map((request) => ({ id: request.id as string, kind: request.kind as string }));
      const launcherThreadId = watch.launcherThreadId;
      if (launcherThreadId === null) return { _tag: "Running", questions } satisfies StepResult;
      const subagents =
        shell.launchedBy === undefined &&
        shell.lineage.parentThreadId === launcherThreadId &&
        shell.lineage.relationshipToParent === "subagent"
          ? (yield* threads.getThreadRecords(launcherThreadId, ["subagents"])).subagents
          : [];
      return {
        _tag: "Running",
        questions,
        escalatesUserInput: localQuestionLauncher(shell, subagents) === launcherThreadId,
      } satisfies StepResult;
    }).pipe(
      Effect.catchTags({
        LauncherGone: () => Effect.succeed({ _tag: "LauncherGone" } satisfies StepResult),
      }),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "Unreachable", error: describe(error) } satisfies StepResult),
      ),
    );

  const remoteFailure = (error: unknown): StepResult => {
    if (error instanceof LauncherGone) return { _tag: "LauncherGone" };
    if (error instanceof SshRemoteDispatch.SshRemoteDispatchError) {
      if (error.reason === "caller_changed") return { _tag: "CallerChanged" };
      if (error.reason === "remote_refused" && error.remoteCode === "thread_not_found") {
        return { _tag: "Gone", reason: `${error.message}` };
      }
      if (error.reason === "remote_refused" && error.remoteCode === "run_not_found") {
        return { _tag: "RunMissing" };
      }
    }
    return { _tag: "Unreachable", error: describe(error) };
  };

  const reportedRequestIds = (watch: LaunchWatch, runId: RunId) => {
    const prefix = `${runId}/`;
    return watch.reportedQuestions
      .filter((key) => key.startsWith(prefix))
      .map((key) => RuntimeRequestId.make(key.slice(prefix.length)));
  };

  const remoteStep = (
    watch: LaunchWatch,
    host: string,
    runId: RunId,
    capability: { ignoresQuestions: boolean },
  ) =>
    Effect.gen(function* () {
      const ignoreRequestIds = reportedRequestIds(watch, runId);
      const wait = (ignore: boolean) =>
        callHost(
          watch,
          host,
          "goat_thread_wait",
          {
            threadId: watch.threadId,
            runId,
            timeoutMs: REMOTE_TICK_MS,
            ...(ignore && ignoreRequestIds.length > 0 ? { ignoreRequestIds } : {}),
          },
          REMOTE_TICK_MS + REMOTE_ANSWER_MARGIN_MS,
        );
      const waited = yield* wait(capability.ignoresQuestions).pipe(
        Effect.catchTags({
          SshRemoteDispatchError: (error) =>
            capability.ignoresQuestions &&
            ignoreRequestIds.length > 0 &&
            error.reason === "remote_refused" &&
            error.message.includes(
              "goat_thread_wait does not take ignoreRequestIds, so nothing ran",
            )
              ? Effect.gen(function* () {
                  capability.ignoresQuestions = false;
                  return yield* wait(false);
                })
              : Effect.fail(error),
        }),
        Effect.flatMap(decodeWait),
      );
      if (!waited.timedOut && isTerminalStatus(waited.status)) {
        return {
          _tag: "Terminal",
          status: waited.status,
          runId: waited.runId ?? runId,
        } satisfies StepResult;
      }
      // Only user questions are listed remotely; approvals show up when the run ends.
      const listedQuestions = yield* callHost(
        watch,
        host,
        "goat_pending_request_list",
        { threadId: watch.threadId },
        REMOTE_READ_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap(decodeRequestIds),
        Effect.map((listed) => listed.requestIds.map((id) => ({ id, kind: "user_input" }))),
        Effect.catch((error) =>
          error instanceof LauncherGone
            ? Effect.fail(error)
            : Effect.logDebug("launch watch: pending requests unreadable", {
                host,
                cause: error,
              }).pipe(Effect.as([])),
        ),
      );
      const questions = [...listedQuestions];
      if (!waited.timedOut) {
        for (const id of waited.pendingRequestIds ?? []) {
          if (!questions.some((question) => question.id === id)) {
            questions.push({ id, kind: "user_input" });
          }
        }
      }
      return {
        _tag: "Running",
        questions,
        retryIfNoNewQuestions: !waited.timedOut,
      } satisfies StepResult;
    }).pipe(
      Effect.timeoutOption(REMOTE_STEP_LIMIT_MS),
      Effect.map((result) =>
        Option.getOrElse(result, (): StepResult => ({
          _tag: "Unreachable",
          error: `${host} did not answer in time.`,
        })),
      ),
      Effect.catch((error) => Effect.succeed(remoteFailure(error))),
    );

  const localDetails = (watch: LaunchWatch, runId: RunId) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(watch.threadId);
      const records = yield* threads.getThreadRecords(
        watch.threadId,
        ["messages", "providerThreads", "runs", "turnItems"],
        {
          messageRoles: ["assistant"],
          messageRunIds: [runId],
          runIds: [runId],
          turnItemRunIds: [runId],
          turnItemTypes: ["assistant_message", "error"],
        },
      );
      return {
        title: shell?.title ?? null,
        branch: shell?.branch ?? null,
        worktreePath: shell?.worktreePath ?? null,
        excerpt: lastText(records.messages.map((message) => message.text)),
        prUrl: shell?.linkedPullRequest?.url ?? null,
        linkOnlyRegistration: (records.providerThreads ?? []).some(
          (thread) =>
            thread.cloudTask?.attach === "registered" && thread.cloudTask.tracking === "link-only",
        ),
        failure: runFailure(
          records.runs.find((run) => run.id === runId) ?? null,
          records.turnItems,
        ),
      } satisfies Details;
    });

  /**
   * Reads the end of a remote transcript for the followed run's last answer.
   * Positions count every visible item while the messages view only filters,
   * so the read starts a fixed window before the end.
   */
  const remoteDetails = (
    watch: LaunchWatch,
    host: string,
    runId: RunId,
    status: LaunchWatchTerminalStatus,
  ) =>
    Effect.gen(function* () {
      const read = (args: Record<string, unknown>) =>
        callHost(
          watch,
          host,
          "goat_thread_read",
          { threadId: watch.threadId, ...args },
          REMOTE_READ_TIMEOUT_MS,
        ).pipe(Effect.flatMap(decodeRead));
      const head = yield* read({ view: "messages", limit: 1, runLimit: 1 });
      const start = head.thread.itemCount - TAIL_WINDOW - 1;
      let afterPosition: number | undefined = start < 0 ? undefined : start;
      const texts: Array<string | null> = [];
      for (let page = 0; page < TAIL_PAGES; page++) {
        const result = yield* read({
          view: "messages",
          limit: TAIL_PAGE,
          maxCharsPerItem: EXCERPT_MAX_CHARS,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        });
        for (const item of result.items) {
          if (item.type === "assistant_message" && item.runId === runId) texts.push(item.text);
        }
        if (!result.hasMore || result.nextPosition === null) break;
        afterPosition = result.nextPosition;
      }
      const excerpt = lastText(texts);
      // A run that failed before its agent spoke has nothing to quote; its status says why.
      const failure =
        status === "failed" && excerpt === null
          ? yield* callHost(
              watch,
              host,
              "goat_thread_status",
              { threadId: watch.threadId },
              REMOTE_READ_TIMEOUT_MS,
            ).pipe(
              Effect.flatMap(decodeFailureStatus),
              Effect.map((remote) => failureFromRemoteStatus(remote, runId)),
              Effect.catch((error) =>
                error instanceof LauncherGone
                  ? Effect.fail(error)
                  : Effect.logDebug("launch watch: failure status unreadable", {
                      host,
                      cause: error,
                    }).pipe(Effect.as(null)),
              ),
            )
          : null;
      return {
        title: head.thread.title,
        branch: head.thread.branch,
        worktreePath: head.thread.worktreePath,
        excerpt,
        prUrl: head.thread.linkedPullRequest?.url ?? null,
        // Registered runs live on their holder, whose own watch reads them locally.
        linkOnlyRegistration: false,
        failure,
      } satisfies Details;
    });

  /** Details make a wake more useful but never hold it back. */
  const detailsFor = (watch: LaunchWatch, runId: RunId, status: LaunchWatchTerminalStatus) =>
    (watch.host === null
      ? localDetails(watch, runId)
      : remoteDetails(watch, watch.host, runId, status)
    ).pipe(
      Effect.timeoutOption(REMOTE_READ_TIMEOUT_MS * 2),
      Effect.map(Option.getOrElse(() => noDetails)),
      Effect.catch((error) =>
        Effect.logDebug("launch watch: details unavailable", {
          watchId: watch.id,
          cause: error,
        }).pipe(Effect.as(noDetails)),
      ),
    );

  const wake = (launcherThreadId: ThreadId, message: LaunchWatchWake) =>
    threads.dispatch({
      type: "message.dispatch",
      commandId: message.commandId,
      threadId: launcherThreadId,
      messageId: message.messageId,
      text: message.text,
      notification: message.notification,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });

  /**
   * Sends a wake. A refusal the orchestrator will repeat settles it, with a
   * warning; any other failure (a storage failure, or a command id the
   * orchestrator recorded as rejected) leaves it owed, with the attempt
   * counted so the retry uses a fresh id. A settled wake that carries a
   * report also goes to the completion webhook, which never holds it back. A
   * launcherless watch has no wake: its report goes straight to the webhook.
   */
  const deliver = (
    watch: LaunchWatch,
    message: LaunchWatchWake,
    report?: Pick<
      CompletionWebhook.CompletionWebhookReport,
      "event" | "runId" | "requestId" | "status" | "title" | "prUrl"
    >,
  ): Effect.Effect<{ readonly delivered: boolean; readonly watch: LaunchWatch }> =>
    (watch.launcherThreadId === null
      ? Effect.succeed({ delivered: true, watch })
      : settleWake(watch, watch.launcherThreadId, message)
    ).pipe(
      Effect.tap((sent) =>
        sent.delivered && report !== undefined
          ? webhook.notify(
              watch,
              {
                ...report,
                id: message.commandId,
                summary: message.notification.summary,
                excerpt: message.notification.detail ?? null,
              },
              () =>
                current(watch.id, watch.incarnation)?.recovery === undefined &&
                current(watch.id, watch.incarnation) !== undefined,
            )
          : Effect.void,
      ),
    );

  const settleWake = (
    watch: LaunchWatch,
    launcherThreadId: ThreadId,
    message: LaunchWatchWake,
  ): Effect.Effect<{ readonly delivered: boolean; readonly watch: LaunchWatch }> =>
    wake(launcherThreadId, wakeAttempt(watch, message)).pipe(
      Effect.as({ delivered: true, watch: clearAttempts(watch, message) }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : isPermanentDispatchFailure(cause)
            ? Effect.logWarning("launch watch: wake refused", {
                watchId: watch.id,
                commandId: message.commandId,
                cause,
              }).pipe(Effect.as({ delivered: true, watch: clearAttempts(watch, message) }))
            : Effect.logWarning("launch watch: wake failed, will retry", {
                watchId: watch.id,
                commandId: message.commandId,
                cause,
              }).pipe(Effect.as({ delivered: false, watch: recordFailedAttempt(watch, message) })),
      ),
    );

  const releaseSlot = (watchId: string, incarnation: string) => {
    if (followers.get(watchId)?.incarnation === incarnation) {
      followers.delete(watchId);
      missingEscalations.delete(watchId);
    }
  };

  /** Starts a follower when a watch has runs to report and none is running. Call with the lock held. */
  const ensureFollower = (watch: LaunchWatch) =>
    Effect.gen(function* () {
      if (watch.pendingRuns.length === 0 || followers.has(watch.id)) return;
      const slot: { readonly incarnation: string; fiber: Fiber.Fiber<void> | undefined } = {
        incarnation: watch.incarnation,
        fiber: undefined,
      };
      followers.set(watch.id, slot);
      slot.fiber = yield* follow(watch.id, watch.incarnation).pipe(Effect.forkIn(layerScope));
    });

  type Plan =
    | { readonly _tag: "Exit" }
    | { readonly _tag: "Sleep"; readonly ms: number }
    | { readonly _tag: "Follow"; readonly watch: LaunchWatch; readonly runId: RunId };

  const current = (watchId: string, incarnation: string) => {
    const watch = watches.get(watchId);
    return watch?.incarnation === incarnation ? watch : undefined;
  };

  const launcherlessExpired = (watch: LaunchWatch, now: number) =>
    watch.launcherThreadId === null &&
    now - (watch.armedAt ?? watch.createdAt) >= LAUNCHERLESS_RETENTION_MS;

  /** A watch past its retention, which every operation treats as gone. */
  const expired = (watch: LaunchWatch, now: number) =>
    watch.recovery === undefined &&
    (launcherlessExpired(watch, now) ||
      (watch.pendingRuns.length === 0 &&
        watch.outage === null &&
        now - watch.updatedAt >= DORMANT_RETENTION_MS));

  /** An expired watch with nothing owed. One still owed is left to its follower to drop. */
  const dormantExpired = (watch: LaunchWatch, now: number) =>
    watch.pendingRuns.length === 0 && watch.outage === null && expired(watch, now);

  /**
   * Whether a launcherless watch can no longer report: the completion webhook,
   * its only destination, stopped taking it, or it outlived its retention.
   */
  const launcherlessStranded = (watch: LaunchWatch, now: number) =>
    watch.launcherThreadId !== null
      ? Effect.succeed(false)
      : webhook
          .wants(watch)
          .pipe(Effect.map((wanted) => !wanted || launcherlessExpired(watch, now)));

  /**
   * Applies a step result under the lock. Returns how long to pause before the
   * next step. A wake and the state recording it are not split by a shutdown:
   * stopping waits for both, so a restart does not repeat the wake.
   */
  const apply = (
    watchId: string,
    incarnation: string,
    runId: RunId,
    result: StepResult,
    details: Details,
  ) =>
    locked(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const watch = current(watchId, incarnation);
          if (
            watch === undefined ||
            watch.recovery !== undefined ||
            watch.detached ||
            !watch.pendingRuns.includes(runId)
          )
            return 0;
          const now = yield* Clock.currentTimeMillis;
          // Kept dormant once nothing is owed, so a later send can re-arm it.
          const keep = (next: LaunchWatch) => save((map) => map.set(watchId, next));
          if (result._tag !== "LauncherGone" && result._tag !== "CallerChanged") {
            // The launcher may have been archived while the step waited; a wake
            // queued on an archived thread would never run.
            const launcher = yield* Effect.result(launcherCeiling(watch));
            if (launcher._tag === "Failure") {
              if (launcher.failure instanceof LauncherGone) {
                yield* save((map) => map.delete(watchId));
                return 0;
              }
              return RETRY_MS;
            }
          }
          switch (result._tag) {
            case "Terminal": {
              missingEscalations.delete(watchId);
              const endedRunId = result.runId;
              // A promoted message ends with the run it joined; that run is reported once.
              if (endedRunId !== runId && watch.reportedRuns.includes(endedRunId)) {
                yield* keep(settleRun(recordContact(watch, now), runId, now));
                return 0;
              }
              const title = details.title ?? watch.title;
              const sent = yield* deliver(
                watch,
                finishedWake({ watch, runId: endedRunId, status: result.status, ...details }),
                details.linkOnlyRegistration
                  ? undefined
                  : {
                      event: "run.completed",
                      runId: endedRunId,
                      status: result.status,
                      title,
                      prUrl: details.prUrl,
                    },
              );
              if (!sent.delivered) {
                yield* keep(sent.watch);
                return RETRY_MS;
              }
              const settled = settleRun(recordContact(sent.watch, now), runId, now);
              yield* keep({
                ...(endedRunId === runId ? settled : settleRun(settled, endedRunId, now)),
                title,
              });
              return 0;
            }
            case "Running": {
              let next = recordContact(watch, now);
              const missing = missingEscalations.get(watchId) ?? new Map<string, number>();
              const pending = new Set(
                result.questions.map((question) => questionKey(runId, question.id)),
              );
              for (const key of missing.keys()) {
                if (!pending.has(key)) missing.delete(key);
              }
              let pause =
                result.retryIfNoNewQuestions &&
                result.questions.every((question) =>
                  next.reportedQuestions.includes(questionKey(runId, question.id)),
                )
                  ? RETRY_MS
                  : 0;
              for (const question of result.questions) {
                const key = questionKey(runId, question.id);
                if (next.reportedQuestions.includes(key)) {
                  missing.delete(key);
                  continue;
                }
                if (result.escalatesUserInput && question.kind === "user_input") {
                  const launcherThreadId = watch.launcherThreadId;
                  const messageId = MessageId.make(
                    `question-escalation:${watch.threadId}:${question.id}`,
                  );
                  const escalated =
                    launcherThreadId !== null &&
                    (yield* threads
                      .getThreadRecords(launcherThreadId, ["messages"], {
                        messageIds: [messageId],
                      })
                      .pipe(
                        Effect.map((records) =>
                          records.messages.some((message) => message.id === messageId),
                        ),
                        Effect.catch((error) =>
                          Effect.logDebug("launch watch: escalation message unreadable", {
                            cause: error,
                          }).pipe(Effect.as(false)),
                        ),
                      ));
                  if (escalated) {
                    next = recordQuestion(next, key, now);
                    missing.delete(key);
                    continue;
                  }
                  const firstSeen = missing.get(key) ?? now;
                  missing.set(key, firstSeen);
                  if (now - firstSeen < RETRY_MS) {
                    pause = RETRY_MS;
                    continue;
                  }
                }
                const sent = yield* deliver(
                  next,
                  questionWake({
                    watch: next,
                    runId,
                    requestId: question.id,
                    kind: question.kind,
                    title: null,
                  }),
                  {
                    event: "question",
                    runId,
                    requestId: question.id,
                    status: "waiting",
                    title: next.title,
                    prUrl: null,
                  },
                );
                next = sent.delivered ? recordQuestion(sent.watch, key, now) : sent.watch;
                if (sent.delivered) missing.delete(key);
                if (!sent.delivered) pause = RETRY_MS;
              }
              if (missing.size > 0) missingEscalations.set(watchId, missing);
              else missingEscalations.delete(watchId);
              if (next !== watch) yield* keep(next);
              return pause;
            }
            case "RunMissing":
              missingEscalations.delete(watchId);
              yield* Effect.logWarning("launch watch: followed run no longer exists", {
                watchId,
                runId,
              });
              yield* keep(settleRun(watch, runId, now));
              return 0;
            case "Gone": {
              const sent = yield* deliver(watch, goneWake({ watch, reason: result.reason }));
              if (!sent.delivered) {
                yield* keep(sent.watch);
                return RETRY_MS;
              }
              yield* save((map) => map.delete(watchId));
              return 0;
            }
            case "LauncherGone":
              yield* save((map) => map.delete(watchId));
              return 0;
            case "CallerChanged":
              return RETRY_MS;
            case "Unreachable":
              return yield* retryLater(watch, runId, result.error);
          }
        }),
      ),
    );

  /** Records a failed contact, telling the launcher once per outage. Call with the lock held. */
  const retryLater = (watch: LaunchWatch, runId: RunId, error: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { next, notify } = recordFailure(watch, now, error);
      let saved = next;
      if (notify && next.outage !== null) {
        const sent = yield* deliver(next, outageWake({ watch: next, outage: next.outage }), {
          event: "host.unavailable",
          runId,
          status: "unreachable",
          title: next.title,
          prUrl: null,
        });
        saved = sent.delivered
          ? sent.watch
          : { ...sent.watch, outage: { ...next.outage, notified: false } };
      }
      yield* save((map) => map.set(watch.id, saved));
      return Math.max(0, (saved.outage?.nextRetryAt ?? now) - now);
    });

  const plan = (watchId: string, incarnation: string) =>
    locked(
      Effect.gen(function* () {
        const watch = current(watchId, incarnation);
        const runId =
          watch?.recovery !== undefined || watch?.detached ? undefined : watch?.pendingRuns[0];
        if (watch === undefined || runId === undefined) {
          releaseSlot(watchId, incarnation);
          return { _tag: "Exit" } satisfies Plan;
        }
        const now = yield* Clock.currentTimeMillis;
        if (yield* launcherlessStranded(watch, now)) {
          const dropped = yield* save((map) => map.delete(watchId)).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("launch watch: stranded launcherless watch not dropped", {
                watchId,
                cause: error,
              }).pipe(Effect.as(false)),
            ),
          );
          if (dropped) {
            yield* Effect.logInfo(
              "launch watch: dropped a launcherless watch nothing can receive",
              {
                watchId,
              },
            );
            releaseSlot(watchId, incarnation);
            return { _tag: "Exit" } satisfies Plan;
          }
          return { _tag: "Sleep", ms: RETRY_MS } satisfies Plan;
        }
        if (watch.outage !== null && watch.outage.nextRetryAt > now) {
          return { _tag: "Sleep", ms: watch.outage.nextRetryAt - now } satisfies Plan;
        }
        return { _tag: "Follow", watch, runId } satisfies Plan;
      }),
    );

  const captureEnabled = Effect.fn("LaunchWatchService.captureEnabled")(function* (
    watch: LaunchWatch,
  ) {
    if (
      watch.host === null ||
      watch.launcherThreadId === null ||
      watch.recovery !== undefined ||
      watch.detached
    )
      return false;
    const currentSettings = yield* settings.getSettings;
    if (currentSettings.goatclaw.enabled) return false;
    const hostChoice = currentSettings.fleet.hosts?.[watch.host]?.checkpointReplication;
    return hostChoice !== "off" && (watch.checkpointReplication ?? hostChoice) === "on";
  });

  const capture = Effect.fn("LaunchWatchService.capture")(
    function* (watch: LaunchWatch, runId: RunId) {
      if (watch.host === null) return;
      const permit = yield* settings.checkpointReplicationPermit(watch.host);
      const claimed = yield* locked(
        Effect.gen(function* () {
          const active = current(watch.id, watch.incarnation);
          if (
            active === undefined ||
            !(yield* captureEnabled(active)) ||
            active.replicaAttempts?.includes(runId)
          )
            return false;
          yield* save((map) =>
            map.set(active.id, {
              ...active,
              replicaAttempts: [...(active.replicaAttempts ?? []), runId],
              replicaAttempt: { runId, reason: "capturing" },
            }),
          );
          return true;
        }),
      );
      if (!claimed || watch.host === null) return;
      const authorize = Effect.gen(function* () {
        const active = current(watch.id, watch.incarnation);
        if (
          active === undefined ||
          !(yield* captureEnabled(active)) ||
          active.replicaCeiling !== "full-access"
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Checkpoint capture is no longer authorized.",
          });
        const ceiling = yield* launcherCeiling(active);
        const launcher = yield* threads.getThreadShell(active.launcherThreadId!);
        if (ceiling !== "full-access" || launcher?.interactionMode !== "default")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Checkpoint capture requires full access and default interaction mode.",
          });
        return ceiling;
      });
      const result = yield* ssh
        .callHostTool(
          {
            host: watch.host,
            tool: "goat_thread_checkpoint_capture",
            arguments: { threadId: watch.threadId, runId },
            writes: true,
            requireReady: true,
            existingSessionOnly: true,
            timeoutMs: 150_000,
          },
          authorize,
        )
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ThreadReplicaCaptureResult)),
          Effect.result,
        );
      yield* locked(
        Effect.gen(function* () {
          const active = current(watch.id, watch.incarnation);
          if (active === undefined || active.recovery !== undefined || active.detached) return;
          const enabled = yield* captureEnabled(active);
          const authority = enabled ? yield* authorize.pipe(Effect.result) : null;
          if (!enabled || authority?._tag === "Failure") {
            yield* save((map) =>
              map.set(active.id, {
                ...active,
                replicaAttempt: { runId, reason: enabled ? "authority_changed" : "disabled" },
              }),
            );
            return;
          }
          const kept =
            result._tag === "Success" && result.success.status === "captured"
              ? result.success.replica
              : null;
          const reason =
            result._tag === "Failure"
              ? "capture_failed"
              : result.success.status === "skipped"
                ? result.success.reason
                : "captured";
          if (kept === null) {
            yield* save((map) =>
              map.set(active.id, { ...active, replicaAttempt: { runId, reason } }),
            );
            return;
          }
          const invalid = ThreadReplicaService.validateReplica(
            kept,
            yield* Clock.currentTimeMillis,
          );
          if (kept.sourceThreadId !== active.threadId || kept.runId !== runId || invalid !== null) {
            yield* save((map) =>
              map.set(active.id, {
                ...active,
                replicaAttempt: { runId, reason: invalid ?? "identity_mismatch" },
              }),
            );
            return;
          }
          yield* fs.makeDirectory(replicaDir, { recursive: true, mode: 0o700 });
          const file = replicaFile(active, runId);
          yield* Effect.gen(function* () {
            yield* writeFileStringAtomically({
              filePath: file,
              contents: yield* encodeReplicaPayload(kept),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            const { bundleBase64: _bundle, context: _context, ...metadata } = kept;
            const published = yield* permit.publish(
              Effect.gen(function* () {
                yield* authorize;
                yield* save((map) =>
                  map.set(active.id, {
                    ...active,
                    replica: metadata,
                    replicaAttempt: { runId, reason: "captured" },
                  }),
                );
              }),
            );
            if (Option.isNone(published)) {
              yield* save((map) =>
                map.set(active.id, {
                  ...active,
                  replicaAttempt: { runId, reason: "disabled" },
                }),
              );
              return;
            }
            if (active.replica !== undefined && active.replica.runId !== runId)
              yield* fs.remove(replicaFile(active, active.replica.runId)).pipe(Effect.ignore);
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                current(active.id, active.incarnation)?.replica?.runId === runId
                  ? Effect.void
                  : fs.remove(file).pipe(Effect.ignore),
              ),
            ),
          );
        }),
      );
    },
    Effect.catch(() => Effect.logWarning("launch watch: checkpoint capture failed")),
  );

  const knownRecovery = (
    recovery: NonNullable<LaunchWatch["recovery"]>,
  ): ThreadReplicaRestoreResult | undefined =>
    recovery.status === "launched" && recovery.threadId !== null && recovery.runId !== null
      ? {
          operationId: recovery.request.operationId,
          status: "launched",
          threadId: recovery.threadId,
          runId: recovery.runId,
        }
      : undefined;

  const recover: LaunchWatchServiceShape["recover"] = Effect.fn("LaunchWatchService.recover")(
    function* (input, authorize) {
      authorize = authorize.pipe(
        Effect.tap(() => ThreadReplicaService.assertCheckpointProfilesDisabled(settings)),
      );
      const admitted = yield* locked(
        Effect.gen(function* () {
          yield* ensureLoaded;
          const watch = watches.get(keyOf(input).id);
          if (watch === undefined || watch.host === null)
            return yield* new OrchestratorMcpFailure({
              code: "not_found",
              message: "No checkpoint watch exists.",
            });
          const authority = yield* authorize;
          if (
            authority.runtimeMode !== "full-access" ||
            authority.interactionMode !== "default" ||
            watch.replicaCeiling !== "full-access"
          )
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message:
                "Recovery requires current full access and the stored full-access capture grant.",
            });
          const destinationHost = normalizeHost(input.destinationHost);
          if (watch.recovery !== undefined) {
            const prior = watch.recovery;
            if (
              prior.capturedRunId !== input.expectedRunId ||
              prior.destinationHost !== destinationHost ||
              prior.request.projectId !== input.destinationProjectId ||
              (yield* encodeReplicaModel(prior.request.modelSelection ?? null)) !==
                (yield* encodeReplicaModel(input.modelSelection ?? null))
            )
              return yield* new OrchestratorMcpFailure({
                code: "conflict",
                message:
                  "This watch already has a recovery operation with a different checkpoint, destination or model.",
              });
            return { watch, payload: null, recovery: prior };
          }
          if (pressure._tag === "Some")
            yield* admitLaunch(destinationHost).pipe(
              Effect.provideService(PressureNudger.PressureAdmissionService, pressure.value),
            );
          if (watch.replica === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "not_found",
              message: "No retained checkpoint exists for this watch.",
            });
          if (watch.replica.runId !== input.expectedRunId)
            return yield* new OrchestratorMcpFailure({
              code: "conflict",
              message: "The retained checkpoint changed; read watch status again.",
            });
          if (destinationHost === watch.host)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Recovery needs a different destination.",
            });
          const file = replicaFile(watch, input.expectedRunId);
          if (!(yield* fs.exists(file)))
            return yield* new OrchestratorMcpFailure({
              code: "not_found",
              message: "Retained checkpoint is missing.",
            });
          if ((yield* fs.stat(file)).size > THREAD_REPLICA_MAX_BYTES * 2)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Retained checkpoint is oversized.",
            });
          const payload = yield* fs.readFileString(file).pipe(
            Effect.flatMap(decodeReplicaPayload),
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Retained checkpoint is corrupt or unreadable.",
                }),
            ),
          );
          const invalid = ThreadReplicaService.validateReplica(
            payload,
            yield* Clock.currentTimeMillis,
          );
          const { bundleBase64: _bundle, context: _context, ...metadata } = payload;
          if (
            invalid !== null ||
            (yield* encodeReplicaMetadata(metadata)) !==
              (yield* encodeReplicaMetadata(watch.replica))
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Retained checkpoint refused: ${invalid ?? "identity_mismatch"}.`,
            });
          const request = {
            operationId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
            projectId: input.destinationProjectId,
            ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          };
          const recovery: NonNullable<LaunchWatch["recovery"]> = {
            request,
            destinationHost,
            requestDigest: yield* ThreadReplicaService.replicaRestoreDigest({
              ...request,
              replica: payload,
            }),
            capturedRunId: payload.runId,
            capturedDigest: payload.sha256,
            sourceRunId: watch.pendingRuns[0] ?? payload.runId,
            status: "reserved",
            threadId: null,
            runId: null,
            sourceInterrupted: false,
          };
          const atCommit = yield* authorize;
          if (atCommit.runtimeMode !== "full-access" || atCommit.interactionMode !== "default")
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Recovery authorization changed before reservation.",
            });
          yield* save((map) => map.set(watch.id, { ...watch, recovery }));
          return { watch, payload, recovery };
        }),
      );
      const { watch, payload, recovery } = admitted;
      const known = knownRecovery(recovery);
      if (known !== undefined) return known;
      const oldFollower = followers.get(watch.id);
      if (oldFollower?.incarnation === watch.incarnation && oldFollower.fiber !== undefined) {
        yield* Fiber.interrupt(oldFollower.fiber);
        yield* locked(
          Effect.sync(() => {
            if (followers.get(watch.id) === oldFollower) releaseSlot(watch.id, watch.incarnation);
          }),
        );
      }
      if (payload !== null)
        yield* locked(
          save((map) => {
            const active = current(watch.id, watch.incarnation);
            if (
              active?.recovery?.request.operationId === recovery.request.operationId &&
              active.recovery.status === "reserved"
            )
              map.set(watch.id, {
                ...active,
                recovery: { ...active.recovery, status: "launch_unknown" },
              });
          }),
        );
      const guarded = authorize.pipe(
        Effect.tap((caller) =>
          caller.runtimeMode === "full-access" && caller.interactionMode === "default"
            ? Effect.void
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Recovery authorization changed.",
                }),
              ),
        ),
      );
      const reconcileInput = {
        operationId: recovery.request.operationId,
        requestDigest: recovery.requestDigest,
      };
      const result =
        recovery.destinationHost === null
          ? payload === null
            ? yield* replicas.reconcile(reconcileInput, guarded)
            : yield* replicas.restore({ ...recovery.request, replica: payload }, guarded)
          : yield* ssh
              .callHostTool(
                {
                  host: recovery.destinationHost,
                  tool:
                    payload === null
                      ? "goat_thread_checkpoint_reconcile"
                      : "goat_thread_checkpoint_restore",
                  arguments:
                    payload === null ? reconcileInput : { ...recovery.request, replica: payload },
                  writes: true,
                  requireReady: true,
                  existingSessionOnly: true,
                  timeoutMs: 180_000,
                },
                guarded.pipe(Effect.map((caller) => caller.runtimeMode)),
              )
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(ThreadReplicaRestoreResult)),
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "host_unavailable",
                      message:
                        "Recovery launch outcome is unknown. Retry this same recovery to reconcile; do not start another launch.",
                    }),
                ),
              );
      if (
        result.operationId !== recovery.request.operationId ||
        (result.status === "launched" && result.runId === null)
      )
        return yield* new OrchestratorMcpFailure({
          code: "conflict",
          message: "Destination recovery identity did not match.",
        });
      const committed = yield* locked(
        Effect.gen(function* () {
          const active = current(watch.id, watch.incarnation);
          if (
            active?.recovery === undefined ||
            active.recovery.request.operationId !== result.operationId
          )
            return result;
          const alreadyKnown = knownRecovery(active.recovery);
          if (alreadyKnown !== undefined) return alreadyKnown;
          if (result.status === "refused") {
            // The destination persisted a terminal non-launch tombstone; delayed requests cannot launch.
            const { recovery: _retired, ...resumed } = active;
            yield* save((map) => map.set(watch.id, resumed));
            yield* ensureFollower(resumed);
            return result;
          }
          const now = yield* Clock.currentTimeMillis;
          const nextStatus = result.status;
          yield* save((map) => {
            map.set(watch.id, {
              ...active,
              ...(nextStatus === "launched" ? { notifyWebhook: false, webhookTarget: null } : {}),
              recovery: {
                ...active.recovery!,
                status: nextStatus,
                threadId: result.threadId,
                runId: result.runId,
              },
            });
            if (result.status === "launched" && result.runId !== null && !active.detached) {
              const replacement = addPendingRun(
                newLaunchWatch({
                  launcherThreadId: input.launcherThreadId,
                  host: recovery.destinationHost,
                  threadId: result.threadId,
                  projectId: recovery.destinationHost === null ? recovery.request.projectId : null,
                  title: active.title,
                  incarnation: result.operationId,
                  notifyWebhook: active.notifyWebhook,
                  webhookTarget: active.webhookTarget,
                  now,
                }),
                result.runId,
                now,
              );
              if (!map.has(replacement.id)) map.set(replacement.id, replacement);
            }
          });
          if (result.status === "launched") {
            const replacement = watches.get(
              launchWatchId({
                launcherThreadId: input.launcherThreadId,
                host: recovery.destinationHost,
                threadId: result.threadId,
              }),
            );
            if (replacement !== undefined) yield* ensureFollower(replacement);
          }
          return result;
        }),
      );
      if (committed.status === "launched")
        yield* interruptRetired().pipe(Effect.forkIn(layerScope));
      return committed;
    },
    Effect.mapError((error) =>
      isMcpFailure(error)
        ? error
        : new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "Recovery state could not be saved.",
          }),
    ),
  );

  const interruptRetired = Effect.fn("LaunchWatchService.interruptRetired")(
    function* () {
      for (const snapshot of watches.values()) {
        const retired = snapshot.recovery;
        if (
          retired === undefined ||
          retired.status !== "launched" ||
          retired.sourceInterrupted ||
          snapshot.host === null
        )
          continue;
        const result = yield* ssh
          .callHostTool(
            {
              host: snapshot.host,
              tool: "goat_thread_interrupt",
              writes: true,
              requireReady: true,
              existingSessionOnly: true,
              arguments: {
                threadId: snapshot.threadId,
                runId: retired.sourceRunId,
                clientRequestId: `recovery-fence:${retired.request.operationId}`,
              },
              timeoutMs: REMOTE_READ_TIMEOUT_MS,
            },
            Effect.gen(function* () {
              yield* ThreadReplicaService.assertCheckpointProfilesDisabled(settings);
              const mode = yield* launcherCeiling(snapshot);
              const launcher =
                snapshot.launcherThreadId === null
                  ? null
                  : yield* threads.getThreadShell(snapshot.launcherThreadId);
              if (
                mode !== "full-access" ||
                snapshot.replicaCeiling !== "full-access" ||
                launcher?.interactionMode !== "default"
              )
                return yield* new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Source interruption is no longer authorized.",
                });
              return mode;
            }),
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult)),
            Effect.result,
          );
        if (
          result._tag === "Failure" ||
          result.success.threadId !== snapshot.threadId ||
          (result.success.runId !== null && result.success.runId !== retired.sourceRunId)
        )
          continue;
        yield* locked(
          save((map) => {
            const currentWatch = current(snapshot.id, snapshot.incarnation);
            if (currentWatch?.recovery?.request.operationId === retired.request.operationId)
              map.set(snapshot.id, {
                ...currentWatch,
                recovery: { ...currentWatch.recovery, sourceInterrupted: true },
              });
          }),
        );
      }
    },
    Effect.catch(() => Effect.logWarning("launch watch: retired source interruption pending")),
  );

  /** Follows one watch's pending runs until none is left or the watch goes away. */
  const follow = (watchId: string, incarnation: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const capability = { ignoresQuestions: true };
      while (true) {
        const next = yield* plan(watchId, incarnation);
        if (next._tag === "Exit") return;
        if (next._tag === "Sleep") {
          yield* Effect.sleep(next.ms);
          continue;
        }
        const { watch, runId } = next;
        const result =
          watch.host === null
            ? yield* localStep(watch, runId)
            : yield* remoteStep(watch, watch.host, runId, capability);
        if (result._tag === "Terminal" && result.status === "completed")
          yield* capture(watch, result.runId);
        const details =
          result._tag === "Terminal"
            ? yield* detailsFor(watch, result.runId, result.status)
            : noDetails;
        const pause = yield* apply(watchId, incarnation, runId, result, details).pipe(
          Effect.catch((error) =>
            Effect.logWarning("launch watch: state not saved, will retry", {
              watchId,
              cause: error,
            }).pipe(Effect.as(RETRY_MS)),
          ),
        );
        if (pause > 0) yield* Effect.sleep(pause);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("launch watch follower stopped", { watchId, cause }).pipe(
              Effect.andThen(locked(Effect.sync(() => releaseSlot(watchId, incarnation)))),
            ),
      ),
    );

  // ── public operations ────────────────────────────────────────────────

  const keyOf = (input: LaunchWatchKey) => {
    const host = normalizeHost(input.host);
    const owner = input.launcherThreadId === null ? input.owner : null;
    return {
      host,
      id: launchWatchId({
        launcherThreadId: input.launcherThreadId,
        owner,
        host,
        threadId: input.threadId,
      }),
    };
  };

  /** The watch under an id unless it outlived its retention. Call with the lock held. */
  const live = (id: string, now: number) => {
    const watch = watches.get(id);
    return watch === undefined || expired(watch, now) ? undefined : watch;
  };

  /**
   * A new watch's incarnation. One replacing an expired watch keeps its
   * incarnation, so a follower still winding down follows the replacement.
   */
  const incarnationFor = (id: string) => {
    const previous = watches.get(id)?.incarnation;
    return previous === undefined
      ? crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(
              (cause) => new LaunchWatchStoreError({ message: "Could not start a watch.", cause }),
            ),
          )
      : Effect.succeed(previous);
  };

  let loaded = false;

  /**
   * Reads the state file once, then resumes its followers. Call with the lock
   * held. Until a read succeeds every operation fails, so a file that could
   * not be read is never overwritten with a partial set of watches.
   */
  const ensureLoaded = Effect.gen(function* () {
    if (loaded) return;
    const stored = yield* load.pipe(
      Effect.mapError(
        (cause) =>
          new LaunchWatchStoreError({
            message: `Could not read launch watches at ${statePath}: ${describe(cause)}`,
            cause,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    // Keep only watches that still owe a report or changed recently.
    watches = new Map(
      stored.watches
        .filter((watch) => !expired(watch, now))
        .map((watch) => [
          watch.id,
          watch.replicaAttempt?.reason === "capturing"
            ? {
                ...watch,
                replicaAttempt: { ...watch.replicaAttempt, reason: "capture_interrupted" },
              }
            : watch,
        ]),
    );
    loaded = true;
    yield* releaseDroppedTargets(
      new Map(stored.watches.map((watch) => [watch.id, watch])),
      watches,
    );
    if (
      stored.misplaced ||
      stored.watches.some((watch) => watch.replicaAttempt?.reason === "capturing")
    ) {
      yield* persist(watches).pipe(
        Effect.catch((error) =>
          Effect.logWarning("launch watches: launcherless watches not moved to their own file", {
            cause: error,
          }),
        ),
      );
    }
    yield* Effect.forEach([...watches.values()], ensureFollower, { discard: true });
  });

  const register: LaunchWatchServiceShape["register"] = (input) =>
    locked(
      Effect.gen(function* () {
        yield* ensureLoaded;
        const { host, id } = keyOf(input);
        const now = yield* Clock.currentTimeMillis;
        const existing = live(id, now);
        const base =
          existing ??
          newLaunchWatch({
            launcherThreadId: input.launcherThreadId,
            host,
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            incarnation: yield* incarnationFor(id),
            notifyWebhook: input.notifyWebhook ?? false,
            webhookTarget: input.webhookTarget ?? null,
            now,
          });
        if (base.recovery !== undefined) return base;
        const replicaCeiling =
          base.replicaCeiling ??
          input.replicaCeiling ??
          (host !== null ? yield* launcherCeiling(base) : undefined);
        const withMeta = {
          ...base,
          ...(input.checkpointReplication === undefined
            ? {}
            : { checkpointReplication: input.checkpointReplication }),
          ...(replicaCeiling === undefined ? {} : { replicaCeiling }),
          projectId: base.projectId ?? input.projectId,
          title: input.title ?? base.title,
          notifyWebhook: input.notifyWebhook ?? base.notifyWebhook,
          webhookTarget:
            input.webhookTarget === undefined ? base.webhookTarget : input.webhookTarget,
        };
        const watch = input.runId === null ? withMeta : addPendingRun(withMeta, input.runId, now);
        yield* save((map) => map.set(id, watch));
        yield* ensureFollower(watch);
        return watch;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof LaunchWatchStoreError
            ? cause
            : new LaunchWatchStoreError({
                message: "Could not register checkpoint replication.",
                cause,
              }),
        ),
      ),
    );

  const rearm: LaunchWatchServiceShape["rearm"] = (input) =>
    locked(
      Effect.gen(function* () {
        yield* ensureLoaded;
        const { id } = keyOf(input);
        const existing = watches.get(id);
        if (existing === undefined || existing.recovery !== undefined || existing.detached) return;
        const now = yield* Clock.currentTimeMillis;
        if (expired(existing, now)) {
          // Past its retention it is gone; re-arming must not revive its webhook.
          yield* save((map) => map.delete(id));
          return;
        }
        const watch = addPendingRun(existing, input.runId, now);
        if (watch === existing) return;
        yield* save((map) => map.set(id, watch));
        yield* ensureFollower(watch);
      }),
    );

  const withReplicationChoice = Effect.fn("LaunchWatchService.withReplicationChoice")(function* (
    watch: LaunchWatch,
  ) {
    if (watch.launcherThreadId === null) return { ...watch, checkpointReplication: "off" as const };
    const config = yield* settings.getSettings.pipe(Effect.option);
    const choice =
      Option.isSome(config) && watch.host !== null
        ? config.value.fleet.hosts?.[watch.host]?.checkpointReplication
        : "off";
    return {
      ...watch,
      checkpointReplication:
        choice === "off"
          ? ("off" as const)
          : (watch.checkpointReplication ?? choice ?? ("off" as const)),
    };
  });

  const find: LaunchWatchServiceShape["find"] = (input) =>
    locked(
      Effect.gen(function* () {
        yield* ensureLoaded;
        const watch = live(keyOf(input).id, yield* Clock.currentTimeMillis);
        return watch === undefined ? null : yield* withReplicationChoice(watch);
      }),
    );

  const unwatch: LaunchWatchServiceShape["unwatch"] = (input) =>
    Effect.gen(function* () {
      const detached = yield* locked(
        Effect.gen(function* () {
          yield* ensureLoaded;
          const { id } = keyOf(input);
          if (!watches.has(id)) return { removed: false, fiber: undefined } as const;
          yield* save((map) => {
            const watch = map.get(id)!;
            if (watch.recovery !== undefined) map.set(id, { ...watch, detached: true });
            else map.delete(id);
          });
          const slot = followers.get(id);
          followers.delete(id);
          return { removed: true, fiber: slot?.fiber } as const;
        }),
      );
      if (detached.fiber !== undefined) yield* Fiber.interrupt(detached.fiber);
      return detached.removed;
    });

  const list: LaunchWatchServiceShape["list"] = (launcherThreadId) =>
    locked(ensureLoaded).pipe(
      Effect.flatMap(() =>
        Effect.forEach(
          [...watches.values()]
            .filter((watch) => watch.launcherThreadId === launcherThreadId && !watch.detached)
            .toSorted((left, right) => right.updatedAt - left.updatedAt),
          withReplicationChoice,
        ),
      ),
    );

  const listRemote: LaunchWatchServiceShape["listRemote"] = (limit) =>
    locked(ensureLoaded).pipe(
      Effect.map(() =>
        [...watches.values()]
          // A launcherless watch has no thread to show as its launcher.
          .filter((watch) => watch.host !== null && watch.launcherThreadId !== null)
          .toSorted((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, limit),
      ),
    );

  const watchExternal: LaunchWatchServiceShape["watchExternal"] = (input) =>
    Effect.gen(function* () {
      if (!(yield* webhook.watchesExternal(input.route))) return null;
      return yield* locked(
        Effect.gen(function* () {
          yield* ensureLoaded;
          const host = normalizeHost(input.host);
          const id = launchWatchId({
            launcherThreadId: null,
            owner: input.owner,
            host,
            threadId: input.threadId,
          });
          const now = yield* Clock.currentTimeMillis;
          const existing = live(id, now);
          const base =
            existing === undefined
              ? newLaunchWatch({
                  launcherThreadId: null,
                  owner: input.owner,
                  ceiling: input.ceiling,
                  host,
                  threadId: input.threadId,
                  projectId: input.projectId,
                  title: input.title,
                  incarnation: yield* incarnationFor(id),
                  notifyWebhook: input.route.notifyWebhook,
                  webhookTarget: input.route.webhookTarget,
                  now,
                })
              : // The latest launch's choice wins, as it does for register.
                {
                  ...existing,
                  notifyWebhook: input.route.notifyWebhook,
                  webhookTarget: input.route.webhookTarget,
                };
          const watch = addPendingRun(base, input.runId, now);
          yield* save((map) => map.set(id, watch));
          yield* ensureFollower(watch);
          return watch;
        }),
      );
    });

  // ── start ────────────────────────────────────────────────────────────

  yield* forkParked(
    locked(ensureLoaded).pipe(
      Effect.catch((error) =>
        Effect.logWarning("launch watches: state unreadable; retrying on next use", {
          path: statePath,
          cause: error,
        }),
      ),
    ),
  );

  // A dormant watch has no follower to notice that it expired, so sweep them.
  const sweep = locked(
    Effect.gen(function* () {
      if (!loaded) return;
      const now = yield* Clock.currentTimeMillis;
      if ([...watches.values()].some((watch) => dormantExpired(watch, now))) yield* save(() => {});
      const expiredCopies = [...watches.values()].filter(
        (watch) =>
          watch.replica !== undefined &&
          now - Date.parse(watch.replica.capturedAt) >= THREAD_REPLICA_RETENTION_MS,
      );
      if (expiredCopies.length > 0)
        yield* save((map) => {
          for (const watch of expiredCopies) {
            const { replica, ...rest } = watch;
            map.set(watch.id, {
              ...rest,
              replicaAttempt: { runId: replica!.runId, reason: "expired" },
            });
          }
        });
      const retained = new Set(
        [...watches.values()].flatMap((watch) =>
          watch.replica === undefined ? [] : [replicaFile(watch, watch.replica.runId)],
        ),
      );
      for (const name of yield* fs.readDirectory(replicaDir).pipe(Effect.orElseSucceed(() => []))) {
        const file = path.join(replicaDir, name);
        if (/^[a-f0-9]{64}\.json$/u.test(name) && !retained.has(file))
          yield* fs.remove(file).pipe(Effect.ignore);
      }
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("launch watches: expired watches not dropped", { cause: error }),
    ),
  );
  yield* forkParked(Effect.forever(Effect.sleep(SWEEP_MS).pipe(Effect.andThen(sweep))));
  yield* forkParked(
    Effect.forever(Effect.sleep(REMOTE_TICK_MS).pipe(Effect.andThen(interruptRetired()))),
  );

  return LaunchWatchService.of({
    register,
    recover,
    rearm,
    find,
    unwatch,
    list,
    listRemote,
    watchExternal,
    resolveRoute: webhook.resolveRoute,
    releaseRoute: (route) => webhook.release(route.webhookTarget),
  });
});

export const layerWithoutDependencies = Layer.effect(LaunchWatchService, make);

export const layer = layerWithoutDependencies.pipe(Layer.provide(CompletionWebhook.layer));
