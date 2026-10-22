import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
/**
 * The goal tools' service (docs/internals/agentic-k8s.md, "Agent and client surface" and
 * "Authority and safety"). A goal acts as the thread that declares it, so applying is where
 * authority is set: the ceiling is that thread's runtime mode, an update can only lower it, the
 * worker mode must fit under it, and reaching another machine needs what goat_ssh_thread_launch
 * needs. Only the owner, or a full-access/default thread, can change a goal.
 */
import {
  type FleetGoal,
  FleetGoalId,
  FleetGoalSpec,
  type GoatGoalApplyInput,
  type GoatGoalApplyResult,
  type GoatGoalDeleteInput,
  type GoatGoalDeleteResult,
  type GoatGoalGetResult,
  type GoatGoalListInput,
  type GoatGoalListResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { assertFullAccess, type Caller, loadCaller } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { initialStatus } from "./goalPlan.ts";
import { GoalStore, type GoalStoreError } from "./GoalStore.ts";
import { REMOTE_WORKERS_DISABLED } from "./GoalWorkerRuntime.ts";

export class GoalService extends Context.Service<
  GoalService,
  {
    readonly apply: (
      scope: McpInvocationContext.McpInvocationScope,
      input: GoatGoalApplyInput,
    ) => Effect.Effect<GoatGoalApplyResult, OrchestratorMcpFailure>;
    readonly get: (
      scope: McpInvocationContext.McpInvocationScope,
      id: FleetGoalId,
    ) => Effect.Effect<GoatGoalGetResult, OrchestratorMcpFailure>;
    readonly list: (
      scope: McpInvocationContext.McpInvocationScope,
      input: GoatGoalListInput,
    ) => Effect.Effect<GoatGoalListResult, OrchestratorMcpFailure>;
    readonly setPaused: (
      scope: McpInvocationContext.McpInvocationScope,
      id: FleetGoalId,
      paused: boolean,
    ) => Effect.Effect<FleetGoal, OrchestratorMcpFailure>;
    readonly remove: (
      scope: McpInvocationContext.McpInvocationScope,
      input: GoatGoalDeleteInput,
    ) => Effect.Effect<GoatGoalDeleteResult, OrchestratorMcpFailure>;
  }
>()("goat/fleet/goals/GoalService") {}

const storeFailure = (error: GoalStoreError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Goal storage failed: " + error.message,
  });

const notFound = (id: string) =>
  new OrchestratorMcpFailure({
    code: "not_found",
    message: "No goal " + id + ". goat_goal_list shows yours.",
  });

const encodeSpec = Schema.encodeSync(FleetGoalSpec);
const sameSpec = (left: FleetGoal["spec"], right: FleetGoal["spec"]) =>
  JSON.stringify(encodeSpec(left)) === JSON.stringify(encodeSpec(right));

const ownerKeyOf = (threadId: string) => "thread:" + threadId;

const threadCallerIn = Effect.gen(function* () {
  const caller = yield* loadCaller();
  if (caller.caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message:
        "A goal acts as the GOAT thread that declares it, so it needs an agent running inside GOAT. Goals owned by outside MCP clients are tracked in #493.",
    });
  return { ...caller, caller: caller.caller };
});

const managesGoals =
  "Changing a goal another thread owns needs a live full-access/default calling thread.";
const isOwner = (caller: Caller, goal: FleetGoal) =>
  goal.owner.kind === "thread" && caller.caller?.id === goal.owner.threadId;
const hasFullAccess = (caller: Caller) =>
  caller.limits.runtimeMode === "full-access" && caller.limits.interactionMode === "default";
const assertMayManage = (caller: Caller, goal: FleetGoal) =>
  isOwner(caller, goal) ? Effect.void : assertFullAccess(caller, managesGoals);

const make = Effect.gen(function* () {
  const permissions = yield* Profiles.PermissionProfiles;
  const store = yield* GoalStore;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  /** The calling thread, read with the caller's own scope. */
  const callerOf = (scope: McpInvocationContext.McpInvocationScope) =>
    threadCallerIn.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );

  const load = (id: FleetGoalId) =>
    store.get(id).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((record) =>
        record === null ? Effect.fail(notFound(id)) : Effect.succeed(record),
      ),
    );

  /** Refuses a spec the caller could not carry out by hand. */
  const admit = (
    caller: Caller,
    spec: FleetGoal["spec"],
    ceiling: FleetGoal["owner"]["runtimeModeCeiling"],
  ) =>
    Effect.gen(function* () {
      if (caller.limits.interactionMode !== "default")
        return yield* new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: "A plan-mode thread cannot declare a goal: its workers would act beyond it.",
        });
      yield* resolveRuntimeMode(ceiling, spec.workers.runtimeMode);
      const kinds = new Set(spec.doneWhen.map((entry) => entry.type));
      if (
        (kinds.has("pull_requests_merged") ||
          kinds.has("checks_green") ||
          kinds.has("issues_closed")) &&
        spec.repo === null
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "doneWhen on pull requests, checks or issues needs spec.repo (owner/name).",
        });
      if (spec.project.host === null && spec.project.projectId === null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Set spec.project.projectId for workers on this machine.",
        });
      if (spec.limits.maxTokens !== null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "limits.maxTokens is not enforced yet; leave it null.",
        });
      if (spec.workers.perTarget && spec.targets.length === 0)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "workers.perTarget needs at least one target.",
        });
      const remote =
        spec.project.host !== null ||
        (spec.workers.hostSelector.hosts ?? []).some((host) => host !== null);
      if (remote)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            REMOTE_WORKERS_DISABLED +
            " Leave spec.project.host null and name only this machine (null) in workers.hostSelector.hosts.",
        });
    });

  return GoalService.of({
    apply: (scope, input) =>
      Effect.gen(function* () {
        const original = yield* callerOf(scope);
        const effective = yield* permissions.require(scope, "goals.apply", {
          runtimeMode: original.limits.runtimeMode,
        });
        const caller = {
          ...original,
          limits: { ...original.limits, runtimeMode: effective.runtimeMode },
        };
        const now = DateTime.formatIso(yield* DateTime.now);
        if (input.id === undefined) {
          const ceiling = caller.limits.runtimeMode;
          yield* admit(caller, input.spec, ceiling);
          const ulid = yield* crypto.randomULID.pipe(
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Could not make a goal id.",
                }),
            ),
          );
          const goal: FleetGoal = {
            id: FleetGoalId.make("goal_" + ulid.toLowerCase()),
            title: input.title,
            generation: 1,
            owner: {
              kind: "thread",
              threadId: caller.caller.id,
              mcpOwner: null,
              runtimeModeCeiling: ceiling,
            },
            spec: input.spec,
            status: initialStatus(),
            deletionRequestedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          if (input.dryRun === true) return { goal, created: false, changed: true, dryRun: true };
          const created = yield* store
            .create(goal, ownerKeyOf(caller.caller.id), input.clientRequestId ?? null)
            .pipe(Effect.mapError(storeFailure));
          return {
            goal: created.goal,
            created: created.created,
            changed: created.created,
            dryRun: false,
          };
        }
        const { goal: existing } = yield* load(input.id);
        if (!isOwner(caller, existing))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the thread that declared goal " + existing.id + " can change its spec.",
          });
        if (existing.deletionRequestedAt !== null)
          return yield* new OrchestratorMcpFailure({
            code: "conflict",
            message: "Goal " + existing.id + " is being deleted.",
          });
        if (
          input.expectedGeneration !== undefined &&
          input.expectedGeneration !== existing.generation
        )
          return yield* new OrchestratorMcpFailure({
            code: "conflict",
            message:
              "Goal " +
              existing.id +
              " is at generation " +
              existing.generation +
              ", not " +
              input.expectedGeneration +
              ". Read it again and reapply.",
          });
        // An update can lower the ceiling to the caller's current mode, never raise it.
        const ceiling = yield* resolveRuntimeMode(
          existing.owner.runtimeModeCeiling,
          caller.limits.runtimeMode,
        ).pipe(Effect.orElseSucceed(() => existing.owner.runtimeModeCeiling));
        yield* admit(caller, input.spec, ceiling);
        const owner = { ...existing.owner, runtimeModeCeiling: ceiling };
        if (
          sameSpec(existing.spec, input.spec) &&
          existing.title === input.title &&
          owner.runtimeModeCeiling === existing.owner.runtimeModeCeiling
        )
          return { goal: existing, created: false, changed: false, dryRun: input.dryRun === true };
        const next: FleetGoal = {
          ...existing,
          title: input.title,
          spec: input.spec,
          owner,
          generation: existing.generation + 1,
          updatedAt: now,
        };
        if (input.dryRun === true)
          return { goal: next, created: false, changed: true, dryRun: true };
        const written = yield* store
          .updateSpec(next, existing.generation)
          .pipe(Effect.mapError(storeFailure));
        if (written === null)
          return yield* new OrchestratorMcpFailure({
            code: "conflict",
            message:
              "Goal " + existing.id + " changed while this apply ran. Read it again and reapply.",
          });
        return { goal: written, created: false, changed: true, dryRun: false };
      }),
    get: (scope, id) =>
      Effect.gen(function* () {
        const caller = yield* callerOf(scope);
        const { goal } = yield* load(id);
        // Another thread's goal reads as missing unless the caller could manage it.
        if (!isOwner(caller, goal) && !hasFullAccess(caller)) return yield* notFound(id);
        const events = yield* store.events(id, 20).pipe(Effect.mapError(storeFailure));
        return { goal, events };
      }),
    list: (scope, input) =>
      Effect.gen(function* () {
        const caller = yield* callerOf(scope);
        const offset = input.cursor ?? 0;
        const limit = input.limit ?? 20;
        const page = yield* store
          .listByOwner({
            ownerKey: ownerKeyOf(caller.caller.id),
            phase: input.phase,
            offset,
            limit,
          })
          .pipe(Effect.mapError(storeFailure));
        return { goals: [...page.goals], nextCursor: page.more ? offset + limit : null };
      }),
    setPaused: (scope, id, paused) =>
      Effect.gen(function* () {
        const caller = yield* callerOf(scope);
        for (let attempt = 0; attempt < 5; attempt++) {
          const { goal } = yield* load(id);
          yield* assertMayManage(caller, goal);
          if (goal.spec.paused === paused) return goal;
          const written = yield* store
            .updateSpec(
              {
                ...goal,
                spec: { ...goal.spec, paused },
                generation: goal.generation + 1,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
              goal.generation,
            )
            .pipe(Effect.mapError(storeFailure));
          if (written !== null) return written;
        }
        return yield* new OrchestratorMcpFailure({
          code: "conflict",
          message: "Goal " + id + " kept changing; try again.",
        });
      }),
    remove: (scope, input) =>
      Effect.gen(function* () {
        const caller = yield* callerOf(scope);
        const { goal } = yield* load(input.id);
        yield* assertMayManage(caller, goal);
        if (input.force === true) {
          const deleted = yield* store.remove(goal.id).pipe(Effect.mapError(storeFailure));
          return {
            id: goal.id,
            deleted,
            goal: null,
            message:
              "Removed. Threads, worktrees and branches stay; workers that were running may still be.",
          };
        }
        yield* store
          .requestDeletion(goal.id, DateTime.formatIso(yield* DateTime.now))
          .pipe(Effect.mapError(storeFailure));
        const { goal: marked } = yield* load(goal.id);
        return {
          id: goal.id,
          deleted: false,
          goal: marked,
          message:
            "Deletion requested. The controller interrupts live workers, then removes the goal. Threads, worktrees and branches stay.",
        };
      }),
  });
});

export const layer = Layer.effect(GoalService, make).pipe(Layer.provide(Profiles.layer));
