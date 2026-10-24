import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import {
  OrchestratorMcpFailure,
  type ThreadReplicaCaptureInput,
  type ThreadReplicaCaptureResult,
  type ThreadReplicaRestoreInput,
  type ThreadReplicaRestoreResult,
  type ThreadReplicaRecoveryInput,
  type ThreadReplicaSettingInput,
  type ThreadReplicaReconcileInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadStatusResult,
  OrchestratorMcpThreadUnwatchResult,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpThreadWatchListResult,
  OrchestratorMcpThreadWatchResult,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadRetryInput,
  OrchestratorMcpThreadRetryResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendRelayed,
  type OrchestratorMcpThreadStatusInput,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWatch,
  type OrchestratorMcpThreadWatchInput,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { hostFailure } from "./hostFailure.ts";
import { withHostFanOutDeadline } from "./hostFanOutDeadline.ts";
import { type LaunchWatch, replicaStatus } from "./launchWatch.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import { rearmAfterRetry, rearmAfterSend, watchKeyOf } from "./launchWatchRearm.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import {
  assertLiveCaller,
  readCaller,
  unavailable,
  reauthorizationFailure,
} from "./threadAccess.ts";
import { boundedStatus, statusFromRead } from "./threadStatus.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/**
 * Routes the thread tools by host. A thread id belongs to the environment that
 * created it, so a thread is named by (host, threadId): an omitted host is
 * this environment, any other is an SSH alias whose own GOAT server is called
 * through SshRemoteDispatch as an outside client. That server judges the call
 * again; this side only makes sure the caller asks for no more than it has.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_FAN_OUT_LIMIT = 100;
const REMOTE_TIMEOUT_MS = 120_000;
const SENT_REQUEST_CACHE_LIMIT = 1_000;
const DEFAULT_WAIT_MS = 10 * 60 * 1_000;
const MAX_WAIT_MS = 60 * 60 * 1_000;
/** Extra time a remote wait gets to answer after its own timeout. */
const WAIT_ANSWER_MARGIN_MS = 60_000;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message: Array.from(message).slice(0, 2000).join("") });

type ListItem = OrchestratorMcpThreadListItem;

/** Newest first, as each environment lists its own; the host breaks the last tie. */
const newestFirst = (left: ListItem, right: ListItem) =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  right.threadId.localeCompare(left.threadId) ||
  (left.host ?? "").localeCompare(right.host ?? "");

/**
 * Merges the first `limit` threads of each environment into the first
 * `limit` overall. Each list must hold its own newest threads in the order
 * `newestFirst` uses, which makes the merged page exact.
 */
export function mergeHostThreadLists(
  lists: ReadonlyArray<{ readonly threads: ReadonlyArray<ListItem>; readonly total: number }>,
  limit: number,
): { readonly threads: Array<ListItem>; readonly total: number; readonly truncated: boolean } {
  const threads = lists
    .flatMap((list) => list.threads)
    .toSorted(newestFirst)
    .slice(0, limit);
  const total = lists.reduce((sum, list) => sum + list.total, 0);
  return { threads, total, truncated: total > threads.length };
}

const withoutHost = <T extends { readonly host?: unknown; readonly allHosts?: unknown }>(
  input: T,
): Omit<T, "host" | "allHosts"> => {
  const { host: _host, allHosts: _allHosts, ...rest } = input;
  return rest;
};

/**
 * A host older than turn capabilities refuses an argument it does not declare, so an empty
 * request is left out; a real one reaches it and fails there with nothing sent.
 */
const remoteSendArguments = (input: OrchestratorMcpThreadSendInput) => {
  const { capabilities, ...rest } = withoutHost(input);
  return capabilities === undefined || capabilities.length === 0 ? rest : { ...rest, capabilities };
};

/** Another machine's answer is untrusted: it must decode as the tool's own result. */
const decodeRemote =
  <A, E>(decode: (value: unknown) => Effect.Effect<A, E>, host: string, tool: string) =>
  (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(() =>
        failure("orchestration_error", `${host} returned a result ${tool} could not read.`),
      ),
    );

const decodeList = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeInterrupt = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult);
const decodeRetry = Schema.decodeUnknownEffect(OrchestratorMcpThreadRetryResult);
const decodeStatus = Schema.decodeUnknownEffect(OrchestratorMcpThreadStatusResult);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A stored watch as the watch tools show it. */
function watchView(watch: LaunchWatch): OrchestratorMcpThreadWatch {
  return {
    ...(watch.host === null ? {} : { host: watch.host }),
    threadId: watch.threadId,
    title: watch.title,
    pendingRunIds: watch.recovery === undefined ? [...watch.pendingRuns] : [],
    replicaStatus: replicaStatus(watch),
    lastReportedRunId: watch.reportedRuns.at(-1) ?? null,
    hostUnavailableSince: watch.outage === null ? null : iso(watch.outage.since),
    createdAt: iso(watch.createdAt),
    updatedAt: iso(watch.updatedAt),
  };
}

const storeFailure = (error: LaunchWatchService.LaunchWatchStoreError) =>
  failure("orchestration_error", error.message);

export interface HostThreadsMcpServiceShape {
  readonly reconcileCheckpoint: (
    scope: McpInvocationScope,
    input: ThreadReplicaReconcileInput,
  ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;
  readonly configureReplication: (
    scope: McpInvocationScope,
    input: ThreadReplicaSettingInput,
  ) => Effect.Effect<ThreadReplicaSettingInput, OrchestratorMcpFailure>;
  readonly captureCheckpoint: (
    scope: McpInvocationScope,
    input: ThreadReplicaCaptureInput,
  ) => Effect.Effect<ThreadReplicaCaptureResult, OrchestratorMcpFailure>;
  readonly restoreCheckpoint: (
    scope: McpInvocationScope,
    input: ThreadReplicaRestoreInput,
  ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;
  readonly recoverCheckpoint: (
    scope: McpInvocationScope,
    input: ThreadReplicaRecoveryInput,
  ) => Effect.Effect<ThreadReplicaRestoreResult, OrchestratorMcpFailure>;

  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  /**
   * Where a thread's current run is, here or on a host, with the caller's own
   * watch on it. Never waits on the run.
   */
  readonly threadStatus: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadStatusInput,
  ) => Effect.Effect<OrchestratorMcpThreadStatusResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
  readonly retryThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadRetryInput,
  ) => Effect.Effect<OrchestratorMcpThreadRetryResult, OrchestratorMcpFailure>;
  /**
   * Calls one of a host's own read-only tools, such as goat_project_list, and
   * decodes the answer as `decode` reads that tool's result, tagged with the host.
   */
  readonly readOnHost: <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      /** Defaults to the thread-tool deadline. Host status passes a shorter one. */
      readonly timeoutMs?: number;
      readonly requireReady?: true;
      /** Ask the host for a session that may answer approvals; see SshHostToolCall. */
      readonly approvals?: boolean;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) => Effect.Effect<A & { readonly host: string }, OrchestratorMcpFailure>;
  /** Starts or re-arms the calling thread's watch on a thread here or on a host. */
  readonly watchThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWatchInput,
  ) => Effect.Effect<OrchestratorMcpThreadWatchResult, OrchestratorMcpFailure>;
  readonly unwatchThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWatchInput,
  ) => Effect.Effect<OrchestratorMcpThreadUnwatchResult, OrchestratorMcpFailure>;
  readonly listWatches: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpThreadWatchListResult, OrchestratorMcpFailure>;
  readonly writeOnHost: <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly approvals?: boolean;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) => Effect.Effect<A & { readonly host: string }, OrchestratorMcpFailure>;
}

export class HostThreadsMcpService extends Context.Service<
  HostThreadsMcpService,
  HostThreadsMcpServiceShape
>()("goat/mcp/HostThreadsMcpService") {}

/**
 * The caller's current runtime mode, reloaded each time. Changing a thread on
 * another machine also needs default interaction mode: the remote session
 * carries only a runtime-mode ceiling, and the remote treats an outside client
 * as default, so it could not hold a plan-mode caller to plan mode.
 */
const authorize = (writes: boolean) =>
  readCaller().pipe(
    Effect.tap(assertLiveCaller),
    Effect.flatMap((caller) =>
      writes && caller.limits.interactionMode !== "default"
        ? Effect.fail(
            failure(
              "interaction_mode_escalation_denied",
              `Changing a thread on another machine needs a caller in default interaction mode; this caller is in ${caller.limits.interactionMode} mode.`,
            ),
          )
        : Effect.succeed(caller.limits.runtimeMode),
    ),
  );

const make = Effect.gen(function* () {
  const local = yield* OrchestratorMcpService.OrchestratorMcpService;
  const results = yield* ThreadResultService.ThreadResultService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const coordinator = yield* RemoteDispatchCoordinator.RemoteDispatchCoordinator;
  // Only words an error better, so a layer without report bindings goes without.
  const reports = yield* Effect.serviceOption(RemoteReportService.RemoteReportService);
  // Required: an optional lookup resolved at layer build silently refused every profiled send.
  const fleet = yield* FleetSync.GoatclawFleetSync;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launchWatches = yield* LaunchWatchService.LaunchWatchService;
  const replicas = yield* ThreadReplicaService.ThreadReplicaService;
  const replicaAuthorization = (scope: McpInvocationScope) =>
    readCaller().pipe(
      Effect.tap(assertLiveCaller),
      Effect.tap(() =>
        scope.reauthorize === undefined
          ? Effect.void
          : scope
              .reauthorize(["orchestration:operate"])
              .pipe(Effect.mapError(reauthorizationFailure)),
      ),
      Effect.tap(() =>
        scope.readOnly || scope.client?.access === "read-only"
          ? Effect.fail(failure("capability_denied", "Checkpoint operations require write access."))
          : Effect.void,
      ),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );

  /** Only an agent inside a GOAT thread owns watches; it is woken in that thread. */
  const watcherOf = (scope: McpInvocationScope): Effect.Effect<ThreadId, OrchestratorMcpFailure> =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "invalid_request",
            "Watching a thread needs an agent running inside a GOAT thread.",
          ),
        )
      : Effect.succeed(scope.thread.threadId);

  /**
   * A thread started from another machine names hosts as that machine knows them.
   * One this machine cannot reach may still be reachable from there, so say where
   * this thread came from and how to hand the call back. A send is handed back by
   * `relay` when that machine declared at launch that it delivers them.
   */
  const unknownHostFailure = (
    scope: McpInvocationScope,
    host: string,
    error: SshRemoteDispatch.SshRemoteDispatchError,
    relay: ((originLabel: string) => Effect.Effect<unknown, OrchestratorMcpFailure>) | undefined,
  ) =>
    (scope.thread === undefined || Option.isNone(reports)
      ? Effect.succeed(null)
      : reports.value.origin(scope.thread.threadId).pipe(Effect.orElseSucceed(() => null))
    ).pipe(
      Effect.flatMap((origin) =>
        origin !== null && origin.relaySend && relay !== undefined
          ? relay(origin.originLabel)
          : Effect.fail(
              origin === null
                ? hostFailure(error)
                : failure(
                    "invalid_request",
                    `${error.message} This thread was started from ${origin.originLabel}, which may reach ${host}. To have it delivered from there, call ${goatCallText("origin.report")} with status progress, naming host ${host}, the thread, and the message; the origin can forward it.`,
                  ),
            ),
      ),
    );

  /**
   * Hands a send to the launching machine, which delivers it as its launcher
   * thread. The caller must still be allowed to change a thread on another machine.
   */
  const relaySend =
    (
      scope: McpInvocationScope,
      input: OrchestratorMcpThreadSendInput & { readonly host: string },
    ) =>
    (originLabel: string) =>
      Effect.gen(function* () {
        yield* authorize(true).pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        );
        if (scope.thread === undefined || Option.isNone(reports))
          return yield* failure("invalid_request", "Only a launched thread can relay a send.");
        yield* reports.value
          .relay(scope.thread.threadId, {
            host: input.host,
            threadId: input.threadId,
            message: input.message,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.capabilities?.length ? { capabilities: input.capabilities } : {}),
            ...(input.clientRequestId === undefined
              ? {}
              : { clientRequestId: input.clientRequestId }),
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "relay_unsupported" && (input.capabilities?.length ?? 0) > 0
                ? failure(
                    "invalid_request",
                    `${originLabel} runs a GOAT that cannot relay turn capabilities; nothing was sent. Send without capabilities, or update ${originLabel}.`,
                  )
                : error.reason === "relay_queue_full"
                  ? failure(
                      "invalid_request",
                      `${originLabel} has not collected this thread's earlier relayed sends yet; nothing was sent. Try again once it has.`,
                    )
                  : failure("orchestration_error", `Could not hand the send to ${originLabel}.`),
            ),
          );
        return {
          threadId: input.threadId,
          delivery: "relayed",
          via: originLabel,
        } satisfies OrchestratorMcpThreadSendRelayed;
      });

  const call = (
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs?: number;
      readonly requireReady?: true;
      readonly approvals?: boolean;
      /** Only goat_thread_send relays through the origin. */
      readonly relay?: (originLabel: string) => Effect.Effect<unknown, OrchestratorMcpFailure>;
    },
  ) =>
    dispatch
      .callHostTool(
        {
          host: input.host,
          tool: input.tool,
          arguments: input.arguments,
          writes: input.writes,
          timeoutMs: input.timeoutMs ?? REMOTE_TIMEOUT_MS,
          ...(input.requireReady === true ? { requireReady: true } : {}),
          ...(input.approvals === true ? { approvals: true } : {}),
        },
        authorize(input.writes).pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      )
      .pipe(
        Effect.catch((error) =>
          !(error instanceof SshRemoteDispatch.SshRemoteDispatchError)
            ? Effect.fail(error)
            : error.reason === "host_unknown"
              ? unknownHostFailure(scope, input.host, error, input.relay)
              : Effect.fail(hostFailure(error)),
        ),
      );

  /** One call to a host's own thread tool, decoded and tagged with the host. */
  const onHost = <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs?: number;
      readonly requireReady?: true;
      readonly approvals?: boolean;
      readonly relay?: (originLabel: string) => Effect.Effect<unknown, OrchestratorMcpFailure>;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) =>
    call(scope, input).pipe(
      Effect.flatMap(decodeRemote(decode, input.host, input.tool)),
      Effect.map((result) => ({ ...result, host: input.host })),
    );

  const listOnHost = Effect.fn("HostThreadsMcpService.listOnHost")(function* (
    scope: McpInvocationScope,
    host: string,
    input: OrchestratorMcpThreadListInput,
  ) {
    const args = withoutHost(input);
    const everyProject = args.projectId === undefined;
    const result = yield* onHost(
      scope,
      {
        host,
        tool: "goat_thread_list",
        // The caller has no thread on that host, so it has no project there either.
        arguments: everyProject ? { ...args, allProjects: true } : args,
        writes: false,
      },
      decodeList,
    ).pipe(
      Effect.catch((error) =>
        everyProject && error.code === "target_required"
          ? Effect.fail(
              failure(
                "invalid_request",
                `GOAT on ${host} is too old to list every project; update GOAT there or pass one of its projectIds, which ${goatCallText("project.list")} with this host lists.`,
              ),
            )
          : Effect.fail(error),
      ),
    );
    return {
      ...result,
      currentThreadId: null,
      threads: result.threads.map((thread) => ({
        ...thread,
        host,
        ...(thread.projectId === undefined && result.projectId !== null
          ? { projectId: result.projectId }
          : {}),
      })),
    } satisfies OrchestratorMcpThreadListResult;
  });

  const listEverywhere = Effect.fn("HostThreadsMcpService.listEverywhere")(function* (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) {
    if (input.host !== undefined || input.projectId !== undefined || input.cursor !== undefined) {
      return yield* failure(
        "invalid_request",
        "allHosts lists every project everywhere and has no cursor; omit host, projectId, and cursor.",
      );
    }
    const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_FAN_OUT_LIMIT);
    const filters = {
      statuses: input.statuses,
      titleContains: input.titleContains,
      settled: input.settled,
      snoozed: input.snoozed,
      includeSubagents: input.includeSubagents,
      limit,
    };
    const hosts = yield* dispatch.connectedHosts;
    const [here, remote] = yield* Effect.all(
      [
        local.listThreads(scope, { ...filters, allProjects: true }),
        Effect.forEach(
          hosts,
          (host) =>
            listOnHost(scope, host, filters).pipe(
              withHostFanOutDeadline(host),
              Effect.result,
              Effect.map((result) => ({ host, result })),
            ),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const listed: Array<OrchestratorMcpThreadListResult> = [here];
    const unavailableHosts: Array<{ host: string; code: string; message: string }> = [];
    for (const { host, result } of remote) {
      if (result._tag === "Success") listed.push(result.success);
      else
        unavailableHosts.push({ host, code: result.failure.code, message: result.failure.message });
    }
    const merged = mergeHostThreadLists(listed, limit);
    return {
      projectId: null,
      currentThreadId: here.currentThreadId,
      threads: merged.threads,
      nextCursor: null,
      total: merged.total,
      truncated: merged.truncated,
      unavailableHosts,
    } satisfies OrchestratorMcpThreadListResult;
  });

  const readThread: HostThreadsMcpServiceShape["readThread"] = (scope, input) =>
    Effect.gen(function* () {
      const read =
        input.host === undefined
          ? local.readThread(scope, input).pipe(
              Effect.flatMap((read) =>
                results.forRun(input.threadId, read.thread.latestRunId).pipe(
                  Effect.mapError(unavailable),
                  Effect.map((result) => ({ ...read, result })),
                ),
              ),
            )
          : onHost(
              scope,
              {
                host: input.host,
                tool: "goat_thread_read",
                arguments: withoutHost(input),
                writes: false,
              },
              decodeRead,
            );
      const watch = yield* launchWatches
        .find(watchKeyOf(scope, { host: input.host, threadId: input.threadId }))
        .pipe(Effect.mapError(storeFailure));
      const result: OrchestratorMcpThreadReadResult = yield* read;
      return watch === null ? result : { ...result, replicaStatus: replicaStatus(watch) };
    });

  const watchThread: HostThreadsMcpServiceShape["watchThread"] = Effect.fn(
    "HostThreadsMcpService.watchThread",
  )(function* (scope, input) {
    const launcherThreadId = yield* watcherOf(scope);
    if (input.host === undefined && input.threadId === launcherThreadId) {
      return yield* failure("invalid_request", "A thread cannot watch itself.");
    }
    if (
      input.host !== undefined &&
      (yield* coordinator
        .isTaskThread(input.host, input.threadId)
        .pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "Unable to read remote task ownership."),
          ),
        ))
    ) {
      return yield* failure(
        "invalid_request",
        `This remote thread backs a delegated task. Use ${goatCallText("task.read")} and ${goatCallText("task.cancel")}; its completion is already delivered to its parent.`,
      );
    }
    // Reading the thread checks the caller may see it, here or on the host.
    const read = yield* readThread(scope, {
      threadId: input.threadId,
      ...(input.host === undefined ? {} : { host: input.host }),
      limit: 1,
      runLimit: 1,
    });
    const replicaGrant = yield* replicaAuthorization(scope);
    if (
      input.checkpointReplication === "on" &&
      (input.host === undefined ||
        replicaGrant.runtimeMode !== "full-access" ||
        replicaGrant.interactionMode !== "default")
    )
      return yield* failure(
        "capability_denied",
        "Checkpoint replication needs a remote watch and full access in default interaction mode.",
      );
    const watch = yield* launchWatches
      .register({
        ...(input.checkpointReplication === undefined
          ? {}
          : { checkpointReplication: input.checkpointReplication }),
        replicaCeiling: replicaGrant.runtimeMode,
        launcherThreadId,
        host: input.host,
        threadId: input.threadId,
        projectId: input.host === undefined ? read.thread.projectId : null,
        title: read.thread.title,
        // An idle thread's latest run is reported unless this watcher heard about it already.
        runId: read.thread.activeRunId ?? read.thread.latestRunId,
      })
      .pipe(Effect.mapError(storeFailure));
    return { watch: watchView(watch) } satisfies OrchestratorMcpThreadWatchResult;
  });

  const threadStatus: HostThreadsMcpServiceShape["threadStatus"] = Effect.fn(
    "HostThreadsMcpService.threadStatus",
  )(function* (scope, input) {
    const watch = yield* launchWatches
      .find(watchKeyOf(scope, { host: input.host, threadId: input.threadId }))
      .pipe(Effect.mapError(storeFailure));
    const status =
      input.host === undefined
        ? yield* local.threadStatus(scope, { threadId: input.threadId })
        : yield* onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_status",
              arguments: withoutHost(input),
              writes: false,
            },
            decodeStatus,
          ).pipe(
            Effect.catchIf(
              (error) => error.message.includes(SshRemoteDispatch.REMOTE_THREAD_STATUS_UNSUPPORTED),
              () =>
                readThread(scope, {
                  threadId: input.threadId,
                  host: input.host,
                  limit: 1,
                  runLimit: 2,
                }).pipe(Effect.map(statusFromRead)),
            ),
            Effect.catchIf(
              (error) => error.code === "host_unavailable" && watch !== null,
              () =>
                Effect.succeed({
                  host: input.host,
                  threadId: input.threadId,
                  title: watch?.title ?? "Remote thread",
                  phase: "waiting" as const,
                  terminal: false,
                  run: null,
                  queuedRunId: null,
                  pendingRequest: null,
                  lastActivityAt: iso(watch!.updatedAt),
                  lastMessage: null,
                  lastError: "Source host is unavailable; run state is unknown.",
                  remoteUnavailable: true,
                }),
            ),
          );
    return boundedStatus({
      ...status,
      ...(watch === null ? {} : { replicaStatus: replicaStatus(watch) }),
      watch:
        watch === null
          ? null
          : {
              // Only the next run; a thread sent to many times queues many.
              pendingRunIds: watch.pendingRuns.slice(0, 1),
              pendingRunCount: watch.pendingRuns.length,
              lastReportedRunId: watch.reportedRuns.at(-1) ?? null,
              webhook: watch.notifyWebhook || watch.webhookTarget !== null,
            },
    }) satisfies OrchestratorMcpThreadStatusResult;
  });

  // The caller may lose a successful response and retry after the review
  // finishes. Reuse that response before applying new-send lifecycle checks.
  // Direct SSH sends have no local durable request receipt. After eviction or
  // restart they still pass the new-send checks; relay handoffs can recover
  // their receipt from RemoteReportService below.
  const sentRequests = new Map<string, OrchestratorMcpThreadSendResult>();
  const rememberSentRequest = (key: string, result: OrchestratorMcpThreadSendResult) => {
    sentRequests.set(key, result);
    if (sentRequests.size > SENT_REQUEST_CACHE_LIMIT) {
      const oldest = sentRequests.keys().next().value;
      if (oldest !== undefined) sentRequests.delete(oldest);
    }
  };

  return HostThreadsMcpService.of({
    listThreads: (scope, input) =>
      input.allHosts === true
        ? listEverywhere(scope, input)
        : input.host === undefined
          ? local.listThreads(scope, input)
          : listOnHost(scope, input.host, input),
    readThread,
    threadStatus,
    waitForThread: (scope, input) => {
      if (input.host === undefined) return local.waitForThread(scope, input);
      const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
      const { ignoreRequestIds, ...args } = withoutHost(input);
      return onHost(
        scope,
        {
          host: input.host,
          tool: "goat_thread_wait",
          arguments: {
            ...args,
            timeoutMs,
            ...(ignoreRequestIds === undefined ? {} : { ignoreRequestIds }),
          },
          writes: false,
          // A remote that times out answers timedOut:true; only silence past that is unavailability.
          timeoutMs: timeoutMs + WAIT_ANSWER_MARGIN_MS,
        },
        decodeWait,
      );
    },
    sendToThread: (scope, input) =>
      Effect.gen(function* () {
        const host = input.host;
        const requestKey =
          host === undefined || input.clientRequestId === undefined
            ? undefined
            : [
                scope.requestNamespace,
                scope.thread?.threadId ?? "",
                host,
                input.threadId,
                input.clientRequestId,
              ]
                .map(encodeURIComponent)
                .join(":");
        const delivered = requestKey === undefined ? undefined : sentRequests.get(requestKey);
        if (delivered !== undefined) return delivered;
        // Relay requests survive report collection, cache eviction and restarts.
        // A receipt acknowledges the earlier handoff; it does not enqueue a send.
        if (
          host !== undefined &&
          input.clientRequestId !== undefined &&
          scope.thread !== undefined &&
          Option.isSome(reports)
        ) {
          const receipt = yield* reports.value
            .relayReceipt(scope.thread.threadId, input.clientRequestId)
            .pipe(
              Effect.mapError(() =>
                failure("orchestration_error", "Unable to read the remote relay receipt."),
              ),
            );
          if (receipt !== null) {
            const result = {
              host,
              threadId: input.threadId,
              delivery: "relayed",
              via: receipt.originLabel,
            } satisfies OrchestratorMcpThreadSendResult;
            if (requestKey !== undefined) rememberSentRequest(requestKey, result);
            return result;
          }
        }
        // With goatclaw on, the send takes a lane here and carries the caller's ceiling, admitted by
        // the same rule as the launch that started the thread.
        const admission =
          host === undefined
            ? undefined
            : yield* local.admitRemoteSend(scope, {
                host,
                threadId: input.threadId,
                ...(input.clientRequestId === undefined
                  ? {}
                  : { clientRequestId: input.clientRequestId }),
              });
        const ceiling = admission?.ceiling;
        const ceilingAdvice =
          host !== undefined && ceiling !== undefined
            ? yield* FleetSync.syncBeforeForwarding(fleet, host)
            : undefined;
        const forwarded = ceiling === undefined ? {} : { permissionProfileCeiling: ceiling };
        const sent = yield* (
          host === undefined
            ? local
                .sendToThread(scope, input)
                .pipe(Effect.map((result): OrchestratorMcpThreadSendResult => result))
            : coordinator.taskOrigin(host, input.threadId).pipe(
                Effect.mapError((error) => failure("orchestration_error", error.message)),
                Effect.flatMap((originThreadId) =>
                  threads
                    .assertReviewTaskSendAllowed({
                      threadId: input.threadId,
                      ...(originThreadId === null ? {} : { senderThreadId: originThreadId }),
                      host,
                      createdBy: "agent",
                    })
                    .pipe(
                      Effect.mapError((error) =>
                        failure(
                          error._tag === "ThreadManagementReviewTaskFinishedError"
                            ? "thread_not_sendable"
                            : "orchestration_error",
                          error.message,
                        ),
                      ),
                    ),
                ),
                Effect.andThen(() =>
                  onHost(
                    scope,
                    {
                      host,
                      tool: "goat_thread_send",
                      // The remote sees an outside client; a thread's queue or steer still means "like
                      // steering" there, which its auto now does.
                      arguments:
                        scope.thread !== undefined &&
                        (input.mode === "queue" || input.mode === "steer")
                          ? { ...remoteSendArguments(input), ...forwarded, mode: "auto" }
                          : { ...remoteSendArguments(input), ...forwarded },
                      writes: true,
                      // A relayed send arrives as the origin's launcher thread, without this ceiling.
                      ...(ceiling === undefined
                        ? { relay: relaySend(scope, { ...input, host }) }
                        : {}),
                    },
                    decodeSend,
                  ),
                ),
              )
        ).pipe(
          Effect.onExit((exit) =>
            admission === undefined
              ? Effect.void
              : admission.settle(exit._tag === "Success").pipe(Effect.ignore),
          ),
          Effect.tap((result) => rearmAfterSend(launchWatches, scope, input, result)),
          // A send to a remote thread this one launched follows its reports again.
          Effect.tap((result) =>
            host === undefined || result.delivery === "relayed"
              ? Effect.void
              : coordinator
                  .resume(host, input.threadId)
                  .pipe(
                    Effect.catch(() =>
                      Effect.logWarning("Could not resume SSH report observation."),
                    ),
                  ),
          ),
        );
        const result =
          ceilingAdvice === undefined || sent.delivery === "relayed"
            ? sent
            : { ...sent, ceiling: ceilingAdvice };
        if (requestKey !== undefined) rememberSentRequest(requestKey, result);
        return result;
      }),
    interruptThread: (scope, input) =>
      input.host === undefined
        ? local.interruptThread(scope, input)
        : onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_interrupt",
              arguments: withoutHost(input),
              writes: true,
            },
            decodeInterrupt,
          ),
    retryThread: (scope, input) =>
      (input.host === undefined
        ? local.retryThread(scope, input)
        : onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_retry",
              arguments: withoutHost(input),
              writes: true,
            },
            decodeRetry,
          )
      ).pipe(Effect.tap((result) => rearmAfterRetry(launchWatches, input, result))),
    readOnHost: (scope, input, decode) => onHost(scope, { ...input, writes: false }, decode),
    reconcileCheckpoint: (scope, input) => replicas.reconcile(input, replicaAuthorization(scope)),
    configureReplication: (scope, input) =>
      replicas.configureHost(
        input,
        replicaAuthorization(scope).pipe(
          Effect.tap(
            () =>
              scope
                .reauthorize?.(["settings:write"])
                .pipe(Effect.mapError(reauthorizationFailure)) ?? Effect.void,
          ),
        ),
      ),
    captureCheckpoint: (scope, input) => replicas.capture(input, replicaAuthorization(scope)),
    restoreCheckpoint: (scope, input) => replicas.restore(input, replicaAuthorization(scope)),
    recoverCheckpoint: (scope, input) =>
      watcherOf(scope).pipe(
        Effect.flatMap((launcherThreadId) =>
          launchWatches.recover({ ...input, launcherThreadId }, replicaAuthorization(scope)),
        ),
      ),
    watchThread,
    unwatchThread: (scope, input) =>
      Effect.gen(function* () {
        const launcherThreadId = yield* watcherOf(scope);
        const removed = yield* launchWatches
          .unwatch({ launcherThreadId, host: input.host, threadId: input.threadId })
          .pipe(Effect.mapError(storeFailure));
        return {
          ...(input.host === undefined ? {} : { host: input.host }),
          threadId: input.threadId,
          removed,
        } satisfies OrchestratorMcpThreadUnwatchResult;
      }),
    listWatches: (scope) =>
      Effect.gen(function* () {
        const launcherThreadId = yield* watcherOf(scope);
        const watches = yield* launchWatches
          .list(launcherThreadId)
          .pipe(Effect.mapError(storeFailure));
        return { watches: watches.map(watchView) } satisfies OrchestratorMcpThreadWatchListResult;
      }),
    writeOnHost: (scope, input, decode) => onHost(scope, { ...input, writes: true }, decode),
  });
});

export const layer = Layer.effect(HostThreadsMcpService, make);
