/**
 * How the goal controller touches threads: as the goal's owner (its GOAT thread, or the outside
 * MCP client session that declared it), through the services goat_thread_launch,
 * goat_ssh_thread_launch, goat_thread_status and goat_thread_read use, or through the same
 * orchestration commands those tools dispatch. Nothing here grants anything the owner lacks: each
 * action is capped by the goal's runtime-mode ceiling and by the owner's current mode, whichever is
 * lower, needs the owner in default interaction mode, and checks the target thread's modes again
 * under the orchestrator's lock (DispatchModeLimit). Each action also runs the caller's `confirm`
 * as its last step before a command is handed to the orchestrator.
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as McpClientAuthority from "../../auth/McpClientAuthority.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { assertTargetWithinLimits } from "../../mcp/threadAccess.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as FleetSync from "../../goatclaw/FleetSync.ts";
import * as SshRemoteDispatch from "../../sshRemote/SshRemoteDispatch.ts";
import { RescheduleNotAllowed } from "../health/Rescheduler.ts";
import type { PullRequestObservation } from "./goalPlan.ts";
import {
  makeRemoteWorkers,
  RemoteAuthorityLost,
  RemoteLaunchUnconfirmed,
  remoteMarker,
  remoteTitle,
} from "./GoalRemoteWorkers.ts";
import type { WorkerRecord } from "./GoalStore.ts";

/**
 * The owner may no longer take this action: its authority, mode or the goal changed after the
 * action was planned. Nothing was handed to the orchestrator for the step that was refused.
 */
export class GoalOwnerAuthorityLost extends Schema.TaggedError<GoalOwnerAuthorityLost>()(
  "GoalOwnerAuthorityLost",
  {
    message: Schema.String,
    /** The goal itself moved on (a new generation or a deletion): replan, nothing is blocked. */
    goalChanged: Schema.Boolean,
  },
) {}

/** The controller's last check before an action's command is handed to the orchestrator. */
export type ActionConfirm = Effect.Effect<void, GoalOwnerAuthorityLost>;

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

export { RemoteLaunchUnconfirmed } from "./GoalRemoteWorkers.ts";

/** What a move to another host may do, as the Rescheduler's request carries it. */
export interface MoveAuthority {
  readonly runtimeMode: RuntimeMode;
  readonly callerRuntimeMode: RuntimeMode;
  readonly authorize: Effect.Effect<RuntimeMode, RescheduleNotAllowed>;
  /** For writes to the moved attempt's own host: its interrupt. */
  readonly authorizeSource: Effect.Effect<RuntimeMode, RescheduleNotAllowed>;
  readonly allowedHosts?: ReadonlyArray<string>;
  readonly excludeHosts?: ReadonlyArray<string>;
  readonly permissionProfileCeiling?: import("@goat/contracts").PermissionProfile;
  readonly prepareCeiling?: (host: string) => Effect.Effect<void>;
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
      /** The thread's model on another host, read every pass; absent for a local worker. */
      readonly modelSelection?: ModelSelection | null;
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
      confirm: ActionConfirm,
    ) => Effect.Effect<
      Launched,
      OrchestratorMcpFailure | GoalOwnerAuthorityLost | RemoteLaunchUnconfirmed
    >;
    /** Queues a message; with a model selection, the run continues on that model. */
    readonly followUp: (
      access: OwnerAccess,
      goal: FleetGoal,
      worker: WorkerRecord,
      message: string,
      actionId: string,
      confirm: ActionConfirm,
      modelSelection?: ModelSelection,
    ) => Effect.Effect<void, OrchestratorMcpFailure | GoalOwnerAuthorityLost>;
    readonly interrupt: (
      access: OwnerAccess,
      worker: WorkerRecord,
      actionId: string,
      confirm: ActionConfirm,
    ) => Effect.Effect<void, OrchestratorMcpFailure | GoalOwnerAuthorityLost>;
    /** The goal's project folder and repository, read where the project lives. */
    readonly project: (
      goal: FleetGoal,
    ) => Effect.Effect<{ readonly cwd: string; readonly canonicalKey: string | null } | null>;
    /** The authority a move of this goal's worker off sourceHost to another host carries. */
    readonly moveAuthority: (
      access: OwnerAccess,
      goal: FleetGoal,
      confirm: ActionConfirm,
      sourceHost: string,
    ) => Effect.Effect<MoveAuthority, OrchestratorMcpFailure>;
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
/** Whether `mode` allows at least what `planned` does. */
export const runtimeModeCovers = (mode: RuntimeMode, planned: RuntimeMode) =>
  RANK[mode] >= RANK[planned];

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

/** goat_ssh_thread_launch needs a full-access caller; a goal's remote work is held to the same. */
export const REMOTE_WORKERS_NEED_FULL_ACCESS =
  "Workers on another host need a goal whose owner holds full access now.";

const isAuthorityLost = Schema.is(RemoteAuthorityLost);
const lostOf = (error: RemoteAuthorityLost) =>
  new GoalOwnerAuthorityLost({ message: error.message, goalChanged: false });
const keepLost = <A, E>(effect: Effect.Effect<A, E | RemoteAuthorityLost>) =>
  effect.pipe(Effect.mapError((error) => (isAuthorityLost(error) ? lostOf(error) : error)));

const notSendable = (message: string) =>
  new OrchestratorMcpFailure({ code: "thread_not_sendable", message });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hostThreads = yield* HostThreadsMcpService.HostThreadsMcpService;
  const launches = yield* ThreadLaunchMcpService.ThreadLaunchMcpService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const clients = yield* McpClientAuthority.McpClientAuthority;
  const permissions = yield* Profiles.PermissionProfiles;
  const remote = makeRemoteWorkers({
    dispatch: yield* SshRemoteDispatch.SshRemoteDispatch,
    permissions,
    fleet: yield* FleetSync.GoatclawFleetSync,
    projects: yield* ProjectStoreV2,
  });

  /**
   * An outside client's goal acts as that client: its session id is all that is stored, and its
   * live grant and current goatclaw profile are read again here every time.
   */
  const clientOwner = (goal: FleetGoal) =>
    Effect.gen(function* () {
      const mcpOwner = goal.owner.mcpOwner ?? "";
      const grant = yield* clients.load(
        mcpOwner.startsWith("client:") ? mcpOwner.slice("client:".length) : "",
      );
      if ("unavailable" in grant) return { unavailable: grant.unavailable };
      const descriptor = yield* environment.getDescriptor;
      const client = {
        sessionId: grant.sessionId,
        label: "Fleet goal " + goal.id,
        access: goal.owner.runtimeModeCeiling,
        approvals: false,
      };
      const unresolved: McpInvocationScope = {
        environmentId: descriptor.environmentId,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: yield* Clock.currentTimeMillis,
        requestNamespace: mcpOwner,
        grantedScopes: grant.grantedScopes,
        reauthorize: grant.reauthorize,
        thread: undefined,
        client,
      };
      // goatclaw can lower an outside client's mode after the goal was applied.
      const profiled = yield* permissions
        .resolve(unresolved, goal.owner.runtimeModeCeiling)
        .pipe(Effect.result);
      if (profiled._tag === "Failure") return { unavailable: profiled.failure.message };
      const runtimeMode = profiled.success.runtimeMode;
      return {
        scope: { ...unresolved, client: { ...client, access: runtimeMode } },
        runtimeMode,
        canReachHosts: runtimeMode === "full-access",
      } satisfies OwnerAccess;
    });

  const owner: GoalWorkerRuntime["Service"]["owner"] = (goal) =>
    Effect.gen(function* () {
      if (goal.owner.kind === "mcp_client") return yield* clientOwner(goal);
      if (goal.owner.threadId === null) return { unavailable: "The goal names no owner thread." };
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

  /** A thread owner sends as itself; an outside client has no thread to send as. */
  const senderOf = (access: OwnerAccess) =>
    access.scope.thread === undefined ? {} : { senderThreadId: access.scope.thread.threadId };

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
          ...senderOf(access),
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

  /** What a terminal run reported: whether it reported, and its pull request in this repo. */
  const resultOf = (
    goal: FleetGoal,
    reported: {
      readonly reportedAt: unknown;
      readonly pullRequests: ReadonlyArray<{
        readonly url: string;
        readonly number?: number | undefined;
      }>;
    },
  ) => {
    const numbers = reported.pullRequests.flatMap((pullRequest) => {
      const number = pullRequestNumber(pullRequest, goal.spec.repo);
      return number === null ? [] : [number];
    });
    return { reported: reported.reportedAt !== null, pullRequest: numbers[0] ?? null };
  };

  const observeRemote = (goal: FleetGoal, host: string, threadId: ThreadId) =>
    remote.observe(host, threadId).pipe(
      Effect.map((reading): WorkerReading => {
        if (reading.kind !== "seen") return reading;
        const { status } = reading;
        return {
          kind: "seen",
          terminal: status.terminal,
          runId: status.run?.runId ?? null,
          runStatus: status.run?.status ?? null,
          lastActivityAt: status.lastActivityAt,
          result:
            status.terminal && reading.result !== null ? resultOf(goal, reading.result) : null,
          // The host does not say when a usage limit resets; GOAT there resumes its own threads.
          usageLimitResetAt: null,
          modelSelection: reading.modelSelection,
        };
      }),
    );

  /** Admits a write on another host; a launch or move also needs an owner in full access now. */
  const admitRemote = (
    access: OwnerAccess,
    goal: FleetGoal,
    host: string | null,
    worktree: boolean,
    confirm: ActionConfirm,
  ) =>
    remote.admit({ owner: access, ownerNow: owner(goal), goal, host, worktree, confirm }).pipe(
      Effect.flatMap((authority) =>
        !worktree || authority.sessionMode === "full-access"
          ? Effect.succeed(authority)
          : Effect.fail(
              new OrchestratorMcpFailure({
                code: "capability_denied",
                message: REMOTE_WORKERS_NEED_FULL_ACCESS,
              }),
            ),
      ),
    );

  return GoalWorkerRuntime.of({
    owner,
    observeWorker: (access, goal, worker) =>
      Effect.gen(function* () {
        if (worker.threadId === null)
          return { kind: "unknown", message: "No thread yet." } as const;
        if (worker.host !== null) return yield* observeRemote(goal, worker.host, worker.threadId);
        const target = { threadId: worker.threadId };
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
          if (reported !== undefined && reported !== null) result = resultOf(goal, reported);
        }
        // A usage-limited local run says when its limit resets; the goal resumes it then.
        const usageLimitResetAt =
          seen.run?.status === "failed"
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
    findLaunched: (_access, goal, actionId, host) => {
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
      // The launch record named this host before anything was sent; only its marker finds it.
      return remote.find(host, remoteMarker(goal.id, actionId));
    },
    launch: (access, request, confirm) =>
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
          // ThreadLaunchService asks this right before it creates the thread and right before the
          // first message; a refusal there is remembered so it reads as lost authority here.
          const refused = yield* Ref.make<GoalOwnerAuthorityLost | undefined>(undefined);
          const stillAllowed = confirm.pipe(
            Effect.as(true),
            Effect.catch((lost) => Ref.set(refused, lost).pipe(Effect.as(false))),
          );
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
              { threadId: workerThreadId(request.actionId), confirm: stillAllowed },
            ),
          ).pipe(
            Effect.catch((failure) =>
              Effect.flatMap(Ref.get(refused), (lost) =>
                Effect.fail<OrchestratorMcpFailure | GoalOwnerAuthorityLost>(lost ?? failure),
              ),
            ),
          );
          return { host: null, threadId: launched.threadId, runId: launched.runId };
        }
        const host = request.host;
        const project = yield* remote.project(goal);
        if (project === null)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Set spec.project.cwd, or a projectId on " + host + ", to launch workers there.",
          });
        // Admitted before anything reaches the host; the authorize reruns before each remote write.
        const authority = yield* admitRemote(access, goal, host, true, confirm);
        return yield* keepLost(
          remote.launch(authority, {
            host,
            cwd: project.cwd,
            title: remoteTitle(request.title, remoteMarker(goal.id, request.actionId)),
            message: request.message,
            branch: request.branch,
            baseRef: workspace.baseRef,
            startFromOrigin: workspace.startFromOrigin,
            modelSelection: request.modelSelection,
          }),
        );
      }),
    followUp: (access, goal, worker, message, actionId, confirm, modelSelection) => {
      if (worker.threadId === null) return Effect.void;
      const runtimeMode = effectiveRuntimeMode(access, goal);
      if (worker.host !== null) {
        const { host, threadId } = { host: worker.host, threadId: worker.threadId };
        // goat_thread_send cannot change a remote thread's model; the controller relaunches instead.
        if (modelSelection !== undefined)
          return Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "A worker on another host cannot switch models in its thread.",
            }),
          );
        return admitRemote(access, goal, host, false, confirm).pipe(
          Effect.flatMap((authority) =>
            keepLost(remote.send(authority, host, { threadId, message, actionId })),
          ),
        );
      }
      // The goal acts after its owner's turn ends, when goat_thread_send would refuse an idle
      // caller. The action id is the command id, so a repeated pass delivers once.
      return localTarget(access, worker, runtimeMode).pipe(
        Effect.andThen(confirm),
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
              ...senderOf(access),
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
    interrupt: (access, worker, actionId, confirm) =>
      worker.threadId === null
        ? Effect.void
        : worker.host === null
          ? // Stopping work uses the owner's own authority, so a lowered worker mode cannot block it.
            localTarget(access, worker, access.runtimeMode).pipe(
              Effect.flatMap((shell) =>
                shell.activeRunId === null
                  ? Effect.void
                  : Effect.andThen(
                      confirm,
                      underLimit(
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
              ),
              Effect.asVoid,
            )
          : keepLost(
              remote.interrupt(
                remote.stopAuthorize({
                  scope: access.scope,
                  mode: access.runtimeMode,
                  host: worker.host,
                  confirm,
                }),
                worker.host,
                { threadId: worker.threadId, actionId },
              ),
            ),
    project: (goal) => remote.project(goal),
    moveAuthority: (access, goal, confirm, sourceHost) =>
      admitRemote(access, goal, null, true, confirm).pipe(
        Effect.map((authority): MoveAuthority => {
          const selected = goal.spec.workers.hostSelector;
          const named = selected.hosts?.flatMap((host) => (host === null ? [] : [host]));
          const profiled = authority.ceiling?.hosts;
          const allowed =
            named === undefined
              ? profiled
              : profiled === undefined
                ? named
                : named.filter((host) => profiled.includes(host));
          const excluded = selected.exclude?.flatMap((host) => (host === null ? [] : [host]));
          return {
            runtimeMode: authority.workerMode,
            callerRuntimeMode: authority.sessionMode,
            authorize: authority.authorize.pipe(
              Effect.mapError((error) => new RescheduleNotAllowed({ message: error.message })),
            ),
            // Interrupting the old attempt: under the session ceiling, if the profile still reaches it.
            authorizeSource: remote
              .stopAuthorize({
                scope: access.scope,
                mode: authority.sessionMode,
                host: sourceHost,
                confirm: authority.authorize,
              })
              .pipe(
                Effect.mapError((error) => new RescheduleNotAllowed({ message: error.message })),
              ),
            ...(allowed === undefined ? {} : { allowedHosts: allowed }),
            ...(excluded === undefined || excluded.length === 0 ? {} : { excludeHosts: excluded }),
            ...(authority.ceiling === undefined
              ? {}
              : {
                  permissionProfileCeiling: authority.ceiling,
                  prepareCeiling: (host: string) => remote.prepare(authority, host),
                }),
          };
        }),
      ),
  });
});

export const layer = Layer.effect(GoalWorkerRuntime, make);
