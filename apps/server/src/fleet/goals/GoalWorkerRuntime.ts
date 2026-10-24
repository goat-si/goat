/**
 * How the goal controller touches threads: as the goal's owner thread, through the services
 * goat_thread_launch, goat_ssh_thread_launch, goat_thread_status and goat_thread_read use, or
 * through the same orchestration commands those tools dispatch. Nothing here grants anything the
 * owner lacks: each action is capped by the goal's runtime-mode ceiling and by the owner's current
 * mode, whichever is lower, needs the owner in default interaction mode, and checks the target
 * thread's modes again under the orchestrator's lock (DispatchModeLimit).
 */
import {
  CommandId,
  type FleetGoal,
  MessageId,
  type ModelSelection,
  OrchestratorMcpFailure,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { assertTargetWithinLimits } from "../../mcp/threadAccess.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import type { PullRequestObservation } from "./goalPlan.ts";
import type { WorkerRecord } from "./GoalStore.ts";

export interface OwnerAccess {
  readonly scope: McpInvocationScope;
  /** The lower of the goal's ceiling and the owner's current mode. */
  readonly runtimeMode: RuntimeMode;
  /** goat_ssh_thread_launch needs a full-access/default caller. */
  readonly canReachHosts: boolean;
}

export interface LaunchRequest {
  readonly goal: FleetGoal;
  readonly slot: number;
  readonly actionId: string;
  readonly host: string | null;
  readonly title: string;
  readonly message: string;
  readonly branch: string;
  readonly modelSelection: ModelSelection;
  /** Where the worktree starts; the goal's own workspace when absent. */
  readonly workspace?: { readonly baseRef: string; readonly startFromOrigin: boolean };
}

export interface Launched {
  readonly host: string | null;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
}

/** A worker thread as the runtime sees it; health comes from the Health service. */
export type WorkerReading =
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly message: string }
  | {
      readonly kind: "seen";
      readonly terminal: boolean;
      readonly runId: RunId | null;
      readonly runStatus: string | null;
      readonly lastActivityAt: string | null;
      readonly result: { readonly reported: boolean; readonly pullRequest: number | null } | null;
      /** When a usage limit on the latest run resets; null when unknown or not limited. */
      readonly usageLimitResetAt?: string | null;
    };

export class GoalWorkerRuntime extends Context.Service<
  GoalWorkerRuntime,
  {
    /** The owner's current authority, or why the goal cannot act now. */
    readonly owner: (
      goal: FleetGoal,
    ) => Effect.Effect<OwnerAccess | { readonly unavailable: string }>;
    readonly observeWorker: (
      access: OwnerAccess,
      goal: FleetGoal,
      worker: WorkerRecord,
    ) => Effect.Effect<WorkerReading>;
    readonly observePullRequest: (
      goal: FleetGoal,
      number: number,
    ) => Effect.Effect<PullRequestObservation>;
    readonly observeIssue: (
      goal: FleetGoal,
      number: number,
    ) => Effect.Effect<"open" | "closed" | "unknown">;
    /**
     * The thread a launch under this action id started: null when it is known not to exist, a
     * failure when that cannot be told now (the caller must not treat that as absence).
     */
    readonly findLaunched: (
      access: OwnerAccess,
      goal: FleetGoal,
      actionId: string,
      host: string | null,
    ) => Effect.Effect<Launched | null, OrchestratorMcpFailure>;
    readonly launch: (
      access: OwnerAccess,
      request: LaunchRequest,
    ) => Effect.Effect<Launched, OrchestratorMcpFailure>;
    /** Queues a message; with a model selection, the run continues on that model. */
    readonly followUp: (
      access: OwnerAccess,
      goal: FleetGoal,
      worker: WorkerRecord,
      message: string,
      actionId: string,
      modelSelection?: ModelSelection,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly interrupt: (
      access: OwnerAccess,
      worker: WorkerRecord,
      actionId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/fleet/goals/GoalWorkerRuntime") {}

/**
 * A local worker's thread id comes from its launch action id. It is set when the thread is
 * created and never changes, so an unclear launch is resolved by asking whether that thread
 * exists, and a repeated launch cannot create a second one.
 */
export const workerThreadId = (actionId: string) => ThreadId.make("fleet-goal:" + actionId);

const TITLE_LIMIT = 200;
export const workerTitle = (goalTitle: string, slot: number, attempt: number) =>
  (goalTitle + " · s" + slot + " a" + attempt).slice(0, TITLE_LIMIT);

const RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
/**
 * The mode a worker action may use: the lowest of the goal's worker mode, the goal's stored
 * ceiling and the owner's current mode (the last two are already folded into access).
 */
export const effectiveRuntimeMode = (
  access: Pick<OwnerAccess, "runtimeMode">,
  goal: Pick<FleetGoal, "spec">,
): RuntimeMode =>
  RANK[goal.spec.workers.runtimeMode] < RANK[access.runtimeMode]
    ? goal.spec.workers.runtimeMode
    : access.runtimeMode;

const pullRequestNumber = (
  pullRequest: { readonly url: string; readonly number?: number | undefined },
  repository: string | null,
) => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(pullRequest.url);
  if (repository !== null && match !== null && match[1]!.toLowerCase() !== repository.toLowerCase())
    return null;
  return pullRequest.number ?? (match === null ? null : Number(match[2]));
};

/** Why a goal will not act on another machine for now. */
export const REMOTE_WORKERS_DISABLED =
  "Goal workers run on this machine only for now; workers on other machines are not supported yet.";

const remoteDisabled = () =>
  Effect.fail(
    new OrchestratorMcpFailure({ code: "capability_denied", message: REMOTE_WORKERS_DISABLED }),
  );

const notSendable = (message: string) =>
  new OrchestratorMcpFailure({ code: "thread_not_sendable", message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hostThreads = yield* HostThreadsMcpService.HostThreadsMcpService;
  const launches = yield* ThreadLaunchMcpService.ThreadLaunchMcpService;
  const watches = yield* LaunchWatchService.LaunchWatchService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const owner: GoalWorkerRuntime["Service"]["owner"] = (goal) =>
    Effect.gen(function* () {
      if (goal.owner.kind !== "thread" || goal.owner.threadId === null)
        return {
          unavailable: "Goals owned by an outside MCP client are not supported yet (#493).",
        };
      const shell = yield* threads
        .getThreadShell(goal.owner.threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (shell === undefined) return { unavailable: "The owner thread could not be read." };
      if (shell === null || shell.deletedAt !== null)
        return { unavailable: "The owner thread was deleted." };
      if (shell.archivedAt !== null) return { unavailable: "The owner thread is archived." };
      if (shell.interactionMode !== "default")
        return { unavailable: "The owner thread is in plan mode; workers would act beyond it." };
      const runtimeMode = yield* resolveRuntimeMode(
        shell.runtimeMode,
        goal.owner.runtimeModeCeiling,
      ).pipe(Effect.orElseSucceed(() => shell.runtimeMode));
      const descriptor = yield* environment.getDescriptor;
      const scope: McpInvocationScope = {
        environmentId: descriptor.environmentId,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: yield* Clock.currentTimeMillis,
        requestNamespace: "fleet-goal:" + goal.id,
        thread: {
          threadId: shell.id,
          providerSessionId: "fleet-goal:" + goal.id,
          providerInstanceId: shell.providerInstanceId,
        },
        client: undefined,
      };
      return {
        scope,
        runtimeMode,
        canReachHosts: runtimeMode === "full-access",
      } satisfies OwnerAccess;
    });

  const asOwner = <A, E, R>(access: OwnerAccess, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, access.scope));

  /**
   * A local worker must still exist, not be archived, fit the owner's modes, and allow the
   * send (review tasks keep their own rules). The orchestrator re-checks the modes under its
   * lock through DispatchModeLimit. A remote host checks its own threads.
   */
  const localTarget = (access: OwnerAccess, worker: WorkerRecord, runtimeMode: RuntimeMode) =>
    Effect.gen(function* () {
      const threadId = worker.threadId!;
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => notSendable("The worker thread could not be read.")));
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
        return yield* notSendable("The worker thread is archived or deleted.");
      yield* assertTargetWithinLimits({ runtimeMode, interactionMode: "default" }, shell);
      yield* threads
        .assertReviewTaskSendAllowed({
          threadId,
          senderThreadId: access.scope.thread!.threadId,
          createdBy: "agent",
        })
        .pipe(Effect.mapError(() => notSendable("This review task does not take messages.")));
      return shell;
    });

  const underLimit = <A, E, R>(runtimeMode: RuntimeMode, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(DispatchModeLimit, { runtimeMode, interactionMode: "default" }),
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The command was refused.",
          }),
      ),
    );

  return GoalWorkerRuntime.of({
    owner,
    observeWorker: (access, goal, worker) =>
      Effect.gen(function* () {
        if (worker.threadId === null)
          return { kind: "unknown", message: "No thread yet." } as const;
        const target = {
          threadId: worker.threadId,
          ...(worker.host === null ? {} : { host: worker.host }),
        };
        const status = yield* asOwner(access, hostThreads.threadStatus(access.scope, target)).pipe(
          Effect.result,
        );
        if (status._tag === "Failure")
          return status.failure.code === "thread_not_found"
            ? ({ kind: "missing" } as const)
            : ({ kind: "unknown", message: status.failure.message } as const);
        const seen = status.success;
        let result: Extract<WorkerReading, { kind: "seen" }>["result"] = null;
        if (seen.terminal) {
          const read = yield* asOwner(
            access,
            hostThreads.readThread(access.scope, {
              ...target,
              limit: 1,
              runLimit: 1,
              maxCharsPerItem: 200,
            }),
          ).pipe(Effect.option);
          const reported = read._tag === "Some" ? read.value.result : undefined;
          if (reported !== undefined && reported !== null) {
            const numbers = reported.pullRequests.flatMap((pullRequest) => {
              const number = pullRequestNumber(pullRequest, goal.spec.repo);
              return number === null ? [] : [number];
            });
            result = { reported: reported.reportedAt !== null, pullRequest: numbers[0] ?? null };
          }
        }
        // A usage-limited local run says when its limit resets; the goal resumes it then.
        const usageLimitResetAt =
          worker.host === null && seen.run?.status === "failed"
            ? ((yield* threads
                .getThreadShell(worker.threadId)
                .pipe(Effect.orElseSucceed(() => null)))?.usageLimitResetAt ?? null)
            : null;
        return {
          kind: "seen",
          terminal: seen.terminal,
          runId: seen.run?.runId ?? null,
          runStatus: seen.run?.status ?? null,
          lastActivityAt: seen.lastActivityAt,
          result,
          usageLimitResetAt,
        } as const;
      }),
    observePullRequest: (goal, number) =>
      Effect.gen(function* () {
        const repository = goal.spec.repo;
        const projectId = goal.spec.project.projectId;
        if (repository === null || projectId === null)
          return {
            kind: "unknown",
            message: "Set spec.repo and spec.project.projectId to observe pull requests.",
          } as const;
        const read = yield* pullRequests
          .checks({ projectId, repository, number })
          .pipe(Effect.result);
        if (read._tag === "Failure")
          return {
            kind: "unknown",
            message: "PR #" + number + ": " + read.failure.message,
          } as const;
        if (read.success === null)
          return { kind: "unknown", message: "PR #" + number + " was not found." } as const;
        const checks = read.success.checks;
        const failing = checks.some(
          (check) =>
            check.status === "failure" ||
            check.status === "cancelled" ||
            check.status === "action-required",
        );
        return {
          kind: "seen",
          state: read.success.state,
          checks:
            checks.length === 0
              ? null
              : failing
                ? "failing"
                : checks.some((check) => check.status === "pending")
                  ? "pending"
                  : "passing",
        } as const;
      }),
    observeIssue: (goal, number) =>
      goal.spec.repo === null
        ? Effect.succeed("unknown" as const)
        : spawner
            .string(
              ChildProcess.make(
                "gh",
                [
                  "issue",
                  "view",
                  String(number),
                  "--repo",
                  goal.spec.repo,
                  "--json",
                  "state",
                  "--jq",
                  ".state",
                ],
                { stdin: "ignore", stderr: "ignore" },
              ),
            )
            .pipe(
              Effect.timeout("15 seconds"),
              Effect.map((output) => {
                const state = output.trim().toUpperCase();
                return state === "CLOSED"
                  ? ("closed" as const)
                  : state === "OPEN"
                    ? ("open" as const)
                    : ("unknown" as const);
              }),
              Effect.orElseSucceed(() => "unknown" as const),
            ),
    findLaunched: (access, _goal, actionId, host) => {
      if (host === null)
        return threads.getThreadShell(workerThreadId(actionId)).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Could not read whether the worker thread exists.",
              }),
          ),
          Effect.map((shell) =>
            shell === null || shell.deletedAt !== null
              ? null
              : { host: null, threadId: shell.id, runId: shell.latestRunId },
          ),
        );
      // A remote launch has no id of ours on the remote, so the watch it registered is the record.
      return watches.list(access.scope.thread!.threadId).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not read the launch watches.",
            }),
        ),
        Effect.map((list) => {
          const found = list.find(
            (watch) =>
              (watch.host ?? null) === host && watch.title?.endsWith("[" + actionId + "]") === true,
          );
          return found === undefined ? null : { host, threadId: found.threadId, runId: null };
        }),
      );
    },
    launch: (access, request) =>
      Effect.gen(function* () {
        const { goal } = request;
        const runtimeMode = effectiveRuntimeMode(access, goal);
        const workspace = request.workspace ?? goal.spec.workers.workspace;
        if (request.host === null) {
          const projectId = goal.spec.project.projectId;
          if (projectId === null)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Set spec.project.projectId to launch workers on this machine.",
            });
          const launched = yield* asOwner(
            access,
            launches.launch(
              access.scope,
              {
                projectId,
                title: request.title,
                message: request.message,
                modelSelection: request.modelSelection,
                runtimeMode,
                interactionMode: "default",
                workspaceStrategy: {
                  type: "worktree",
                  branch: request.branch,
                  baseRef: workspace.baseRef,
                  startFromOrigin: workspace.startFromOrigin,
                },
                // The goal follows its workers itself; the owner thread is not woken per run.
                notifyOnCompletion: false,
              },
              { runtimeMode, interactionMode: "default" },
              { threadId: workerThreadId(request.actionId) },
            ),
          );
          return { host: null, threadId: launched.threadId, runId: launched.runId };
        }
        // Goal workers run on this machine only until remote authority is carried end to end:
        // a remote session re-reads the owner's current mode instead of the goal's ceiling, and a
        // remote launch has no durable action→thread record yet.
        return yield* remoteDisabled();
      }),
    followUp: (access, goal, worker, message, actionId, modelSelection) => {
      if (worker.threadId === null) return Effect.void;
      const runtimeMode = effectiveRuntimeMode(access, goal);
      if (worker.host !== null) return remoteDisabled();
      // The goal acts after its owner's turn ends, when goat_thread_send would refuse an idle
      // caller. The action id is the command id, so a repeated pass delivers once.
      return localTarget(access, worker, runtimeMode).pipe(
        Effect.andThen(
          underLimit(
            runtimeMode,
            threads.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(actionId),
              threadId: worker.threadId,
              messageId: MessageId.make(actionId),
              text: message,
              attachments: [],
              senderThreadId: access.scope.thread!.threadId,
              dispatchMode: { type: "queue_after_active" },
              ...(modelSelection === undefined ? {} : { modelSelection }),
              createdBy: "agent",
              creationSource: "server",
            }),
          ),
        ),
        Effect.asVoid,
      );
    },
    interrupt: (access, worker, actionId) =>
      worker.threadId === null
        ? Effect.void
        : worker.host === null
          ? // Stopping work uses the owner's own authority, so a lowered worker mode cannot block it.
            localTarget(access, worker, access.runtimeMode).pipe(
              Effect.flatMap((shell) =>
                shell.activeRunId === null
                  ? Effect.void
                  : underLimit(
                      access.runtimeMode,
                      threads.dispatch({
                        type: "run.interrupt",
                        commandId: CommandId.make(actionId),
                        threadId: shell.id,
                        runId: shell.activeRunId,
                        reason: "The fleet goal no longer needs this worker.",
                      }),
                    ),
              ),
              Effect.asVoid,
            )
          : asOwner(
              access,
              hostThreads.interruptThread(access.scope, {
                threadId: worker.threadId,
                host: worker.host,
              }),
            ).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GoalWorkerRuntime, make);
