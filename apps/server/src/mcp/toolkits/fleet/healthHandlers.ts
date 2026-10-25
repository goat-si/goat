import { FleetOwnerKey, OrchestratorMcpFailure, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as FleetHostStates from "../../../fleet/health/FleetHostStates.ts";
import * as HostHealthMonitor from "../../../fleet/health/HostHealthMonitor.ts";
import * as Rescheduler from "../../../fleet/health/Rescheduler.ts";
import { attemptOfBranch, nextAttemptBranch } from "../../../fleet/health/reschedulePolicy.ts";
import * as FleetSync from "../../../goatclaw/FleetSync.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetHealthToolkit } from "./healthTools.ts";

const asHost = (host: string) => (host === FleetHostStates.LOCAL_HOST ? null : host);

/** Whether a host allowlist (undefined allows every host) is narrower now than when it was read. */
const hostsNarrowed = (
  initial: ReadonlyArray<string> | undefined,
  current: ReadonlyArray<string> | undefined,
) =>
  current !== undefined &&
  (initial === undefined || initial.some((host) => !current.includes(host)));

/** Cordons and moves change where everyone's work runs, so each needs a full-access caller. */
const hostResult = (host: string, message: string) =>
  Effect.gen(function* () {
    const monitor = yield* HostHealthMonitor.HostHealthMonitor;
    const conditions = (yield* monitor.conditions(asHost(host))).conditions;
    return {
      host,
      cordoned: conditions.some((condition) => condition.type === "Cordoned"),
      draining: conditions.some((condition) => condition.type === "Draining"),
      conditions: [...conditions],
      message,
    };
  });

export const layer = McpToolAccess.toLayer(FleetHealthToolkit, {
  goat_host_cordon: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      yield* (yield* FleetHostStates.FleetHostStates).cordon({
        host: input.host,
        draining: false,
        reason: input.reason ?? null,
        changedBy: caller.scope.thread?.threadId ?? caller.scope.requestNamespace,
      });
      return yield* hostResult(
        input.host,
        "No new goal work is placed on " + input.host + ". Running threads are untouched.",
      );
    }),
  ),
  goat_host_uncordon: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* (yield* FleetHostStates.FleetHostStates).uncordon(input.host);
      return yield* hostResult(input.host, input.host + " takes new placements again.");
    }),
  ),
  goat_host_drain: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      yield* (yield* FleetHostStates.FleetHostStates).cordon({
        host: input.host,
        draining: true,
        reason: input.reason ?? null,
        changedBy: caller.scope.thread?.threadId ?? caller.scope.requestNamespace,
      });
      return yield* hostResult(
        input.host,
        "No new goal work is placed on " +
          input.host +
          ". Its goal attempts move to another host between runs, one per goal at a time; a" +
          " running turn is never interrupted and threads no goal owns stay. An attempt that" +
          " cannot move stays and its goal says why. goat_host_uncordon stops further moves." +
          " goat_thread_reschedule moves another thread by hand; a goal keeps following the" +
          " original thread, not the moved one.",
      );
    }),
  ),
  goat_thread_reschedule: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      if (input.targetHost === FleetHostStates.LOCAL_HOST) {
        return {
          status: "refused" as const,
          reason: "no_capacity" as const,
          message: "This machine cannot be a move target: moved work is launched on SSH hosts.",
        };
      }
      const modelSelection = input.modelSelection ?? caller.caller?.modelSelection;
      if (modelSelection === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Pass modelSelection: a caller outside a GOAT thread has no model to resume with.",
        });
      }
      const rescheduler = yield* Rescheduler.Rescheduler;
      // An omitted targetHost lets placement choose, so the profile's allowlist must bound it.
      const permissions = yield* Profiles.PermissionProfiles;
      const effective = yield* permissions.resolve(caller.scope);
      const hostsOf = Effect.map(permissions.resolve(caller.scope), (effective) =>
        effective.enabled ? effective.profile.hosts : undefined,
      );
      const allowedHosts = effective.enabled ? effective.profile.hosts : undefined;
      // goatclaw applies fleet-wide: the moved thread keeps the caller's profile on the
      // destination, whose policy is synced first as for every other remote launch (#969).
      const fleet = effective.enabled
        ? yield* Effect.serviceOption(FleetSync.GoatclawFleetSync)
        : undefined;
      let ceilingAdvice: string | undefined;
      const ceiling = effective.enabled
        ? {
            permissionProfileCeiling: effective.profile,
            prepareCeiling: (host: string) =>
              fleet?._tag === "Some"
                ? FleetSync.syncBeforeForwarding(fleet.value, host).pipe(
                    Effect.map((advice) => {
                      ceilingAdvice = advice?.message;
                    }),
                  )
                : Effect.void,
          }
        : {};
      // The caller is checked again after the move waits for its lock and before each remote write,
      // so a caller that ended, lost its modes, or had its host allowlist narrowed changes nothing.
      const services = yield* Effect.context<Effect.Services<typeof check>>();
      const authorize = check.pipe(
        Effect.tap(() =>
          hostsOf.pipe(
            Effect.flatMap((current) =>
              hostsNarrowed(allowedHosts, current)
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "capability_denied",
                      message:
                        "The goatclaw host allowlist narrowed while this move was waiting; call again.",
                    }),
                  )
                : Effect.void,
            ),
          ),
        ),
        Effect.map((current) => current.limits.runtimeMode),
        Effect.mapError(
          (error) => new Rescheduler.RescheduleNotAllowed({ message: error.message }),
        ),
        Effect.provideContext(services),
      );
      const attempt = attemptOfBranch(input.branch);
      const branch = nextAttemptBranch(input.branch);
      const result = yield* rescheduler.reschedule({
        ref: { host: asHost(input.host), threadId: ThreadId.make(input.threadId), watchId: null },
        owner: FleetOwnerKey.make("thread:" + input.threadId),
        attempt,
        reason: "manual",
        modelSelection,
        workspace: { baseRef: input.branch, branch, startFromOrigin: true },
        previousBranch: input.branch,
        replica: null,
        prompt:
          input.prompt ??
          "Continue the task this branch was started for. Why it moved: " + input.reason,
        runtimeMode: caller.limits.runtimeMode,
        clientRequestId: "manual:" + input.host + ":" + input.threadId + ":a" + (attempt + 1),
        project: { cwd: input.cwd, canonicalKey: null },
        targetHost: input.targetHost === undefined ? null : asHost(input.targetHost),
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
        ...ceiling,
        force: input.force === true,
        authorize,
      });
      return result._tag === "Rescheduled"
        ? {
            status: "rescheduled" as const,
            host: result.host ?? FleetHostStates.LOCAL_HOST,
            threadId: result.threadId,
            branch: result.branch,
            resumedFrom: result.resumedFrom,
            message:
              "Resumed on " +
              (result.host ?? "this machine") +
              " as " +
              result.branch +
              ". The old thread stays on " +
              input.host +
              " on its own branch." +
              (ceilingAdvice === undefined ? "" : " " + ceilingAdvice),
          }
        : result._tag === "Unconfirmed"
          ? // A person's move retries on the same host, so the outcome is a refusal for now.
            { status: "refused" as const, reason: "no_capacity" as const, message: result.message }
          : { status: "refused" as const, reason: result.reason, message: result.message };
    }),
  ),
});
