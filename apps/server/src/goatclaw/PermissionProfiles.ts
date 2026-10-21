import {
  OrchestratorMcpFailure,
  PermissionProfile,
  type PermissionCapability,
  type PermissionProfileView,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { clientRuntimeModeCeiling, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const modes: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const narrowMode = (left: RuntimeMode, right: RuntimeMode) =>
  modes[Math.min(modes.indexOf(left), modes.indexOf(right))]!;
const minOptional = (left: number | undefined, right: number | undefined) =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right);

/** The launch snapshot prevents later edits of a named profile from granting its children more. */
export function intersectProfiles(
  profile: PermissionProfile,
  ceiling: PermissionProfile,
): PermissionProfile {
  const maxTurns = minOptional(profile.maxTurns, ceiling.maxTurns);
  const maxWallClockMs = minOptional(profile.maxWallClockMs, ceiling.maxWallClockMs);
  const hosts =
    profile.hosts === undefined
      ? ceiling.hosts
      : ceiling.hosts === undefined
        ? profile.hosts
        : profile.hosts.filter((host) => ceiling.hosts!.includes(host));
  return {
    id: profile.id,
    runtimeModeCeiling: narrowMode(profile.runtimeModeCeiling, ceiling.runtimeModeCeiling),
    capabilities: profile.capabilities.filter((capability) =>
      ceiling.capabilities.includes(capability),
    ),
    maxLanes: Math.min(profile.maxLanes, ceiling.maxLanes),
    ...(hosts === undefined ? {} : { hosts }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  };
}

interface CheckContext {
  readonly forwarded?: PermissionProfile | undefined;
  readonly host?: string | undefined;
  readonly lanesRunning?: number | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}
interface ClaimInput {
  readonly id: string;
  readonly runtimeMode: RuntimeMode;
  readonly childThreadId?: ThreadId | undefined;
  readonly host?: string | undefined;
  readonly worktree?: boolean | undefined;
  readonly forwarded?: PermissionProfile | undefined;
}
type CheckResult =
  | { readonly ok: true; readonly effective: PermissionProfileView }
  | { readonly ok: false; readonly reason: string };

export class PermissionProfiles extends Context.Service<
  PermissionProfiles,
  {
    readonly resolve: (
      scope: McpInvocationScope,
      runtimeMode?: RuntimeMode,
      forwarded?: PermissionProfile,
    ) => Effect.Effect<PermissionProfileView, OrchestratorMcpFailure>;
    readonly check: (
      scope: McpInvocationScope,
      capability: PermissionCapability,
      context?: CheckContext,
    ) => Effect.Effect<CheckResult, OrchestratorMcpFailure>;
    readonly require: (
      scope: McpInvocationScope,
      capability: PermissionCapability,
      context?: CheckContext,
    ) => Effect.Effect<PermissionProfileView, OrchestratorMcpFailure>;
    readonly assertTarget: (
      scope: McpInvocationScope,
      threadId: ThreadId,
      callerMode: RuntimeMode,
      targetMode: RuntimeMode,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly recheck: (
      scope: McpInvocationScope,
      initial: PermissionProfileView,
      context?: CheckContext,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly claim: (
      scope: McpInvocationScope,
      input: ClaimInput,
    ) => Effect.Effect<PermissionProfileView, OrchestratorMcpFailure>;
    readonly complete: (
      id: string,
      childThreadId?: string,
      correlationId?: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly release: (
      id: string,
      onlyIfNoLocalThread?: boolean,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/goatclaw/PermissionProfiles") {}

const refusal = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Permission profile storage is unavailable.",
  });
const ownerOf = (scope: McpInvocationScope) =>
  scope.thread === undefined
    ? `client:${scope.client?.sessionId ?? scope.requestNamespace}`
    : `thread:${scope.thread.threadId}`;
const encodeProfile = Schema.encodeSync(Schema.fromJsonString(PermissionProfile));
const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(PermissionProfile));

const checkProfile = (
  effective: PermissionProfileView,
  capability: PermissionCapability,
  context: CheckContext,
): CheckResult => {
  if (!effective.enabled) return { ok: true, effective };
  const { profile } = effective;
  if (!profile.capabilities.includes(capability))
    return { ok: false, reason: `Profile ${profile.id} does not allow ${capability}.` };
  if (
    context.host !== undefined &&
    profile.hosts !== undefined &&
    !profile.hosts.includes(context.host)
  )
    return { ok: false, reason: `Profile ${profile.id} does not allow host ${context.host}.` };
  if (context.lanesRunning !== undefined && context.lanesRunning >= profile.maxLanes)
    return {
      ok: false,
      reason: `Profile ${profile.id} permits at most ${profile.maxLanes} running lanes.`,
    };
  return { ok: true, effective };
};
const admit = (result: CheckResult) =>
  result.ok ? Effect.succeed(result.effective) : Effect.fail(refusal(result.reason));

export const layer = Layer.effect(
  PermissionProfiles,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    // Disabled installations never need profile storage. An enabled policy fails closed without it.
    const database = yield* Effect.serviceOption(SqlClient.SqlClient);
    const sqlEffect = Option.isSome(database)
      ? Effect.succeed(database.value)
      : Effect.fail(storageFailure());
    const resolve = Effect.fn("PermissionProfiles.resolve")(function* (
      scope: McpInvocationScope,
      runtimeMode?: RuntimeMode,
      forwarded?: PermissionProfile,
      targetThreadId?: ThreadId,
    ) {
      const threadId = targetThreadId ?? scope.thread?.threadId;
      const policy = (yield* settings.getSettings.pipe(Effect.mapError(storageFailure))).goatclaw;
      if (forwarded !== undefined && (scope.thread !== undefined || scope.client === undefined))
        return yield* refusal(
          "Only an authenticated outside dispatch may forward a permission ceiling.",
        );
      if (!policy.enabled) {
        if (forwarded !== undefined)
          return yield* refusal(
            "This destination has goatclaw disabled and cannot enforce the forwarded permission ceiling.",
          );
        return {
          enabled: false,
          profile: policy.profiles[policy.defaultProfile]!,
          runtimeMode: runtimeMode ?? clientRuntimeModeCeiling(scope.client),
        };
      }
      const sql = yield* sqlEffect;
      const binding =
        threadId === undefined
          ? undefined
          : (yield* sql<{ profile_id: string; ceiling_json: string }>`
      SELECT profile_id, ceiling_json FROM goatclaw_thread_profiles WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(storageFailure)))[0];
      const profileId = binding?.profile_id ?? policy.defaultProfile;
      const named = policy.profiles[profileId];
      if (named === undefined)
        return yield* refusal(`Permission profile ${profileId} no longer exists.`);
      let profile =
        binding === undefined
          ? named
          : intersectProfiles(
              named,
              yield* decodeProfile(binding.ceiling_json).pipe(Effect.mapError(storageFailure)),
            );
      if (forwarded !== undefined) profile = intersectProfiles(profile, forwarded);
      let callerMode =
        runtimeMode === undefined
          ? clientRuntimeModeCeiling(scope.client)
          : narrowMode(runtimeMode, clientRuntimeModeCeiling(scope.client));
      if (threadId !== undefined) {
        const row = (yield* sql<{
          runtime_mode: RuntimeMode;
        }>`SELECT runtime_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`.pipe(
          Effect.mapError(storageFailure),
        ))[0];
        if (row === undefined) return yield* refusal("The calling thread is unavailable.");
        callerMode =
          runtimeMode === undefined ? row.runtime_mode : narrowMode(runtimeMode, row.runtime_mode);
      }
      const narrowed = narrowMode(callerMode, profile.runtimeModeCeiling);
      return {
        enabled: true,
        profile: { ...profile, runtimeModeCeiling: narrowed },
        runtimeMode: narrowed,
      };
    });
    const check = Effect.fn("PermissionProfiles.check")(function* (
      scope: McpInvocationScope,
      capability: PermissionCapability,
      context: CheckContext = {},
    ) {
      return checkProfile(
        yield* resolve(scope, context.runtimeMode, context.forwarded),
        capability,
        context,
      );
    });
    const require = Effect.fn("PermissionProfiles.require")(function* (
      scope: McpInvocationScope,
      capability: PermissionCapability,
      context: CheckContext = {},
    ) {
      return yield* admit(yield* check(scope, capability, context));
    });
    const assertTarget = Effect.fn("PermissionProfiles.assertTarget")(function* (
      scope: McpInvocationScope,
      threadId: ThreadId,
      callerMode: RuntimeMode,
      targetMode: RuntimeMode,
    ) {
      const caller = yield* resolve(scope, callerMode);
      if (!caller.enabled) return;
      const target = yield* resolve(scope, targetMode, undefined, threadId);
      if (
        encodeProfile(intersectProfiles(target.profile, caller.profile)) !==
        encodeProfile(target.profile)
      )
        return yield* refusal(
          "The target thread's permission profile exceeds the caller's ceiling.",
        );
    });
    const recheck = Effect.fn("PermissionProfiles.recheck")(function* (
      scope: McpInvocationScope,
      initial: PermissionProfileView,
      context: CheckContext = {},
    ) {
      if (!initial.enabled) return;
      const current = yield* require(scope, "threads.launch", {
        ...context,
        runtimeMode: initial.runtimeMode,
      });
      if (!current.enabled) return;
      if (context.host !== undefined) yield* require(scope, "threads.remote", context);
      if (
        encodeProfile(intersectProfiles(initial.profile, current.profile)) !==
        encodeProfile(initial.profile)
      )
        return yield* refusal(
          "The permission profile narrowed while this launch was preparing; retry with its current ceiling.",
        );
    });
    const claim = Effect.fn("PermissionProfiles.claim")(function* (
      scope: McpInvocationScope,
      input: ClaimInput,
    ) {
      const effective = yield* resolve(scope, input.runtimeMode, input.forwarded);
      if (!effective.enabled) return effective;
      const sql = yield* sqlEffect;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const owner = ownerOf(scope);
            const existing = (yield* sql<{
              owner_key: string;
            }>`SELECT owner_key FROM goatclaw_lane_reservations WHERE id = ${input.id}`)[0];
            if (existing !== undefined && existing.owner_key !== owner)
              return yield* refusal("This lane reservation belongs to another caller.");
            yield* admit(checkProfile(effective, "threads.launch", input));
            if (input.host !== undefined)
              yield* admit(checkProfile(effective, "threads.remote", input));
            if (input.worktree) yield* admit(checkProfile(effective, "worktree.create", input));
            if (existing === undefined) {
              // Pending/unknown launches consume a slot across restarts. Watches and cancellation requests are not terminal evidence.
              const counts = yield* sql<{
                count: number;
              }>`SELECT COUNT(DISTINCT COALESCE(l.host, 'local') || ':' || COALESCE(l.child_thread_id, l.id)) AS count FROM goatclaw_lane_reservations l
          WHERE l.owner_key = ${owner} AND (
            (l.host IS NULL AND (EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = l.child_thread_id AND r.status IN ('preparing','queued','starting','running','waiting'))
              OR l.pending = 1))
            OR (l.host IS NOT NULL AND (l.pending = 1 OR EXISTS (SELECT 1 FROM remote_dispatches d
              WHERE (d.correlation_id = l.correlation_id OR d.task_id = l.id)
              AND d.state IN ('launching','running','lost')))))`;
              yield* admit(
                checkProfile(effective, "threads.launch", { lanesRunning: counts[0]?.count ?? 0 }),
              );
              yield* sql`INSERT INTO goatclaw_lane_reservations (id, owner_key, child_thread_id, host) VALUES (${input.id}, ${owner}, ${input.childThreadId ?? null}, ${input.host ?? null})`;
            }
            if (input.childThreadId !== undefined) {
              // Binding precedes the command commit, which can immediately start a provider turn.
              const previous = (yield* sql<{
                profile_id: string;
                ceiling_json: string;
              }>`SELECT profile_id, ceiling_json FROM goatclaw_thread_profiles WHERE thread_id = ${input.childThreadId}`)[0];
              const inherited =
                previous === undefined
                  ? effective.profile
                  : intersectProfiles(
                      yield* decodeProfile(previous.ceiling_json).pipe(
                        Effect.mapError(storageFailure),
                      ),
                      effective.profile,
                    );
              yield* sql`INSERT INTO goatclaw_thread_profiles (thread_id, profile_id, ceiling_json, owner_key)
          VALUES (${input.childThreadId}, ${previous?.profile_id ?? effective.profile.id}, ${encodeProfile(inherited)}, ${owner})
          ON CONFLICT(thread_id) DO UPDATE SET ceiling_json = excluded.ceiling_json`;
            }
            return effective;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure" ? error : storageFailure(),
          ),
        );
    });
    const complete = Effect.fn("PermissionProfiles.complete")(function* (
      id: string,
      childThreadId?: string,
      correlationId?: string,
    ) {
      if (Option.isNone(database)) return;
      yield* database.value`UPDATE goatclaw_lane_reservations SET pending = CASE WHEN host IS NOT NULL AND ${correlationId ?? null} IS NULL THEN 1 ELSE 0 END,
      child_thread_id = COALESCE(${childThreadId ?? null}, child_thread_id), correlation_id = COALESCE(${correlationId ?? null}, correlation_id) WHERE id = ${id}`.pipe(
        Effect.mapError(storageFailure),
      );
    });
    const release = Effect.fn("PermissionProfiles.release")(function* (
      id: string,
      onlyIfNoLocalThread = false,
    ) {
      if (Option.isNone(database)) return;
      yield* database.value`DELETE FROM goatclaw_lane_reservations WHERE id = ${id}
      AND (${onlyIfNoLocalThread ? 1 : 0} = 0 OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id = child_thread_id))`.pipe(
        Effect.mapError(storageFailure),
      );
    });
    return PermissionProfiles.of({
      resolve,
      check,
      require,
      assertTarget,
      recheck,
      claim,
      complete,
      release,
    });
  }),
);
