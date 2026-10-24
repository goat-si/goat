import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
/**
 * The goal tools' service (docs/internals/agentic-k8s.md, "Agent and client surface" and
 * "Authority and safety"). A goal acts as its owner: the GOAT thread that declares it, or the
 * outside MCP client session that does. Applying is where authority is set: the ceiling is the
 * owner's runtime mode, an update can only lower it, and the worker mode must fit under it. Only
 * the owner, or a full-access/default GOAT thread, can change or read a goal; an outside client
 * reaches only its own, whatever its access.
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
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpClientAuthority from "../../auth/McpClientAuthority.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { resolveRuntimeMode } from "../../mcp/OrchestratorMcpService.ts";
import { assertFullAccess, type Caller, loadCaller } from "../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { initialStatus } from "./goalPlan.ts";
import { GoalRecovery } from "./GoalRecovery.ts";
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
    message: "No goal " + id + `. ${goatCallText("goal.list")} shows yours.`,
  });

const encodeSpec = Schema.encodeSync(FleetGoalSpec);
const sameSpec = (left: FleetGoal["spec"], right: FleetGoal["spec"]) =>
  JSON.stringify(encodeSpec(left)) === JSON.stringify(encodeSpec(right));

/** "thread:<id>" or "client:<auth session id>"; the store lists and dedupes by it. */
export const goalOwnerKey = (owner: Pick<FleetGoal["owner"], "kind" | "threadId" | "mcpOwner">) =>
  owner.kind === "thread" ? "thread:" + owner.threadId : (owner.mcpOwner ?? "");

type GoalIdentity =
  | { readonly kind: "thread"; readonly threadId: ThreadId; readonly mcpOwner: null }
  | {
      readonly kind: "mcp_client";
      readonly threadId: null;
      readonly mcpOwner: string;
      readonly sessionId: string;
    };

/** The owner a call from this caller would record, without its ceiling. */
const identityOf = (caller: Caller): Effect.Effect<GoalIdentity, OrchestratorMcpFailure> =>
  caller.caller !== undefined
    ? Effect.succeed({ kind: "thread" as const, threadId: caller.caller.id, mcpOwner: null })
    : caller.scope.client !== undefined
      ? Effect.succeed({
          kind: "mcp_client" as const,
          threadId: null,
          mcpOwner: "client:" + caller.scope.client.sessionId,
          sessionId: caller.scope.client.sessionId,
        })
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "thread_credential_required",
            message:
              "A goal acts as its owner, so it needs a GOAT thread or a signed-in outside MCP client.",
          }),
        );

type GoalCaller = Caller & { readonly identity: GoalIdentity };

const managesGoals =
  "Changing a goal someone else owns needs a live full-access/default calling GOAT thread.";
const isOwner = (caller: GoalCaller, goal: FleetGoal) =>
  goalOwnerKey(caller.identity) === goalOwnerKey(goal.owner);
/** Reaching other owners' goals is a GOAT thread's: an outside client sees only its own. */
const hasFullAccess = (caller: GoalCaller) =>
  caller.identity.kind === "thread" &&
  caller.limits.runtimeMode === "full-access" &&
  caller.limits.interactionMode === "default";
const assertMayManage = (caller: GoalCaller, goal: FleetGoal) =>
  isOwner(caller, goal)
    ? Effect.void
    : caller.identity.kind === "mcp_client"
      ? Effect.fail(notFound(goal.id))
      : assertFullAccess(caller, managesGoals);

const make = Effect.gen(function* () {
  const permissions = yield* Profiles.PermissionProfiles;
  const store = yield* GoalStore;
  const recovery = yield* GoalRecovery;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const clients = yield* McpClientAuthority.McpClientAuthority;
  /** The calling thread or outside client, read with the caller's own scope. */
  const callerOf = (scope: McpInvocationContext.McpInvocationScope) =>
    loadCaller().pipe(
      Effect.flatMap((caller) =>
        Effect.map(identityOf(caller), (identity): GoalCaller => ({ ...caller, identity })),
      ),
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
          const { identity } = caller;
          // A client's goal is rechecked later by its session id alone, so that id must name a
          // live session that controls threads now.
          if (identity.kind === "mcp_client") {
            const grant = yield* clients.load(identity.sessionId);
            if ("unavailable" in grant)
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "This MCP client cannot own a goal: " + grant.unavailable,
              });
          }
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
              kind: identity.kind,
              threadId: identity.threadId,
              mcpOwner: identity.mcpOwner,
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
            .create(goal, goalOwnerKey(goal.owner), input.clientRequestId ?? null)
            .pipe(Effect.mapError(storeFailure));
          return {
            goal: created.goal,
            created: created.created,
            changed: created.created,
            dryRun: false,
          };
        }
        const { goal: existing } = yield* load(input.id);
        // Another owner's goal reads as missing to an outside client, as get and list do.
        if (!isOwner(caller, existing) && caller.identity.kind === "mcp_client")
          return yield* notFound(existing.id);
        if (!isOwner(caller, existing))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the owner that declared goal " + existing.id + " can change its spec.",
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
        const ownerKey = goalOwnerKey(caller.identity);
        const offset = input.cursor ?? 0;
        const limit = input.limit ?? 20;
        const page = yield* store
          .listByOwner({
            ownerKey,
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
          yield* recovery.forget(goal.id);
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
