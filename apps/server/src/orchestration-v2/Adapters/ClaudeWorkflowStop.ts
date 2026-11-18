import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
  ProviderDriverKind,
} from "@goat/contracts";
import { ProviderAdapterProtocolError } from "@goat/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import type { WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";
import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

import type { ClaudeAgentSdkQuerySession } from "./ClaudeAgentSdkQueryRunner.ts";

const MAX_HELD_DENIALS = 64;
const MAX_OUTSTANDING_WORKFLOW_STOPS = 8;
const STOP_REPLY_GRACE_MS = 30_000;
type SettleDenial = (stopped: boolean) => Effect.Effect<void>;

export interface ClaudeWorkflowStop {
  readonly requestedAt: number;
  readonly owner: ClaudeAgentSdkQuerySession;
  acknowledged: boolean;
  retryAt: number | undefined;
  readonly tools: Map<string, SettleDenial>;
  outcome: "pending" | "accepted" | "rejected";
  readonly members: Map<number, OrchestrationV2WorkflowAgent>;
}

interface StopCoordinator {
  task: OrchestrationV2Subagent;
  workflowStop?: ClaudeWorkflowStop;
  confirmedOutcome: { readonly status: OrchestrationV2Subagent["status"] } | undefined;
}

interface StopQuery<C> {
  readonly query: ClaudeAgentSdkQuerySession;
  readonly closed: Deferred.Deferred<void>;
  readonly nativeThreadId: string;
  readonly stopping: boolean;
  readonly subagentsFromEarlierProcesses: ReadonlySet<C>;
}

type ProjectWorkflow<C> = (input: {
  coordinator: C;
  workflow: OrchestrationV2SubagentWorkflow;
}) => Effect.Effect<void>;

export function makeClaudeWorkflowStopCommand<
  C extends StopCoordinator,
  Q extends StopQuery<C>,
>(input: {
  readonly driver: ProviderDriverKind;
  readonly getQuery: Effect.Effect<Q | null>;
  readonly getCoordinator: (taskId: string) => Effect.Effect<C | undefined>;
  readonly lock: Semaphore.Semaphore;
  readonly scope: Scope.Scope;
  readonly project: ProjectWorkflow<C>;
}) {
  const outstanding = new WeakMap<ClaudeAgentSdkQuerySession, number>();
  const missing = () =>
    new ProviderAdapterProtocolError({
      driver: input.driver,
      detail: "No running workflow task belongs to this provider thread",
    });
  return Effect.fn("ClaudeAdapterV2.stopTask")(function* ({
    providerThread,
    taskId,
  }: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly taskId: string;
  }) {
    let endWait = Effect.void;
    const startRequest = Effect.gen(function* () {
      const live = yield* input.getQuery;
      const coordinator = yield* input.getCoordinator(taskId);
      if (
        live === null ||
        live.stopping ||
        live.nativeThreadId !== providerThread.nativeThreadRef?.nativeId ||
        coordinator === undefined ||
        coordinator.task.threadId !== providerThread.appThreadId ||
        coordinator.task.workflow === undefined ||
        coordinator.task.status !== "running" ||
        live.subagentsFromEarlierProcesses.has(coordinator)
      )
        return yield* missing();

      const previous = coordinator.workflowStop;
      const now = yield* Clock.currentTimeMillis;
      if (
        previous?.outcome === "pending" &&
        (previous.retryAt === undefined || now < previous.retryAt)
      )
        return yield* new ProviderAdapterProtocolError({
          driver: input.driver,
          detail:
            "The previous workflow Stop is still awaiting a reply. Retry after its 30-second grace period",
        });

      if ((outstanding.get(live.query) ?? 0) >= MAX_OUTSTANDING_WORKFLOW_STOPS)
        return yield* new ProviderAdapterProtocolError({
          driver: input.driver,
          detail: "There are too many unanswered workflow Stop requests on this Claude session",
        });

      if (previous?.outcome === "pending") {
        yield* reconcileClaudeWorkflowStop(coordinator, previous, input.project);
        if (
          (yield* input.getCoordinator(taskId)) !== coordinator ||
          (yield* input.getQuery) !== live ||
          live.stopping
        )
          return yield* missing();
      }

      const stop: ClaudeWorkflowStop = {
        owner: live.query,
        requestedAt: DateTime.toEpochMillis(yield* DateTime.now),
        acknowledged: false,
        retryAt: undefined,
        tools: new Map(),
        outcome: "pending",
        members: new Map(),
      };
      const noWaiter = yield* Deferred.make<void>();
      const retireRequest = Deferred.await(noWaiter).pipe(
        Effect.andThen(Deferred.await(live.closed)),
        Effect.andThen(Effect.interrupt),
      );
      const reconcile = (confirmedOnly: boolean) =>
        input.lock
          .withPermits(1)(
            Effect.gen(function* () {
              const current = yield* input.getCoordinator(taskId);
              if (
                current?.workflowStop !== stop ||
                (yield* input.getQuery) !== live ||
                (confirmedOnly && current.confirmedOutcome === undefined)
              )
                return;
              yield* reconcileClaudeWorkflowStop(current, stop, input.project);
              if (stop.outcome === "rejected") {
                if (previous?.outcome !== "accepted") delete current.workflowStop;
                else current.workflowStop = previous;
              }
            }),
          )
          .pipe(Effect.forkIn(input.scope, { uninterruptible: false }), Effect.asVoid);

      // A caller timeout releases its wait, while the SDK still owns the unanswered request.
      return yield* Effect.gen(function* () {
        coordinator.workflowStop = stop;
        outstanding.set(live.query, (outstanding.get(live.query) ?? 0) + 1);
        endWait = Effect.gen(function* () {
          stop.retryAt = (yield* Clock.currentTimeMillis) + STOP_REPLY_GRACE_MS;
          yield* Deferred.succeed(noWaiter, undefined);
          yield* reconcile(true);
        });
        return yield* stop.owner.stopTask(taskId).pipe(
          Effect.raceFirst(retireRequest),
          Effect.onExit((exit) => {
            if (Exit.hasInterrupts(exit)) return Effect.void;
            stop.acknowledged = Exit.isSuccess(exit);
            return reconcile(false);
          }),
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (outstanding.get(live.query) ?? 1) - 1;
              if (remaining === 0) outstanding.delete(live.query);
              else outstanding.set(live.query, remaining);
            }),
          ),
          Effect.forkIn(input.scope, { uninterruptible: false }),
        );
      }).pipe(Effect.uninterruptible);
    });

    yield* input.lock
      .withPermits(1)(startRequest)
      .pipe(
        Effect.flatMap(Fiber.join),
        Effect.onInterrupt(() => endWait),
        Effect.catchTags({
          ClaudeAgentSdkQueryRunnerError: (cause) =>
            new ProviderAdapterProtocolError({
              driver: input.driver,
              detail: "Workflow stop request failed",
              cause,
            }),
        }),
      );
  });
}

export function holdClaudeStopDenial(
  stop: ClaudeWorkflowStop,
  key: string,
  settle: SettleDenial,
): boolean {
  if (stop.outcome !== "pending" || stop.tools.size >= MAX_HELD_DENIALS) return false;
  stop.tools.set(key, settle);
  return true;
}

const settleClaudeStopDenials = Effect.fn("ClaudeWorkflowStop.settleDenials")(function* (
  stop: ClaudeWorkflowStop,
  accepted: boolean,
) {
  stop.outcome = accepted ? "accepted" : "rejected";
  for (const settle of stop.tools.values()) yield* settle(accepted);
  stop.tools.clear();
});

export function holdClaudeWorkflowMember(
  stop: ClaudeWorkflowStop,
  member: OrchestrationV2WorkflowAgent,
  previousStatus: OrchestrationV2Subagent["status"],
): OrchestrationV2WorkflowAgent {
  stop.members.set(member.index, member);
  const { result: _result, completedAt: _completedAt, ...active } = member;
  return { ...active, state: previousStatus === "pending" ? "queued" : "running" };
}

function workflowWithResolvedClaudeStop(
  workflow: OrchestrationV2SubagentWorkflow,
  stop: ClaudeWorkflowStop,
): OrchestrationV2SubagentWorkflow {
  const agents = workflow.agents.map((member) => {
    const held = stop.members.get(member.index);
    return held?.agentId === member.agentId &&
      held !== undefined &&
      (held.attempt ?? 1) === (member.attempt ?? 1)
      ? held
      : member;
  });
  stop.members.clear();
  return { ...workflow, agents };
}

export const reconcileClaudeWorkflowStop = Effect.fn("ClaudeWorkflowStop.reconcile")(function* <
  C extends StopCoordinator,
>(coordinator: C, stop: ClaudeWorkflowStop, project: ProjectWorkflow<C>) {
  if (coordinator.workflowStop !== stop || stop.outcome !== "pending") return;
  yield* settleClaudeStopDenials(
    stop,
    stop.acknowledged || coordinator.confirmedOutcome?.status === "cancelled",
  );
  if (stop.members.size > 0 && coordinator.task.workflow !== undefined) {
    yield* project({
      coordinator,
      workflow: workflowWithResolvedClaudeStop(coordinator.task.workflow, stop),
    });
  }
});

export function beforeClaudeStopProjection(
  task: OrchestrationV2Subagent,
  stop: ClaudeWorkflowStop | undefined,
  previous: OrchestrationV2SubagentWorkflow | undefined,
): OrchestrationV2Subagent {
  return stop === undefined || previous === undefined ? task : { ...task, workflow: previous };
}

export interface ClaudeWorkflowMemberState<ToolCall> {
  readonly status: OrchestrationV2Subagent["status"];
  readonly attempt: number;
  readonly transcriptReadAttempts: number;
  readonly agentId: string | undefined;
  readonly transcriptCursor: WorkflowAgentTranscriptCursor;
  readonly transcriptMetadata: WorkflowAgentMetadata | undefined;
  readonly observedWorkflowStop: ClaudeWorkflowStop | undefined;
  readonly nextItemOrdinal: number;
  readonly toolCalls: Map<string, ToolCall>;
  readonly textShown: boolean;
  readonly turnEnded: boolean;
  readonly resultShown: boolean;
  readonly result: string | undefined;
  readonly label: string;
  readonly prompt: string;
  readonly model: string;
  readonly createdAt: DateTime.Utc;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}
