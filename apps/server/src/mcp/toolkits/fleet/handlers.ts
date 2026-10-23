import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as FleetSync from "../../../goatclaw/FleetSync.ts";
import { readCaller } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@goat/contracts";

import * as GoalService from "../../../fleet/goals/GoalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FleetToolkit } from "./tools.ts";

const withGoals = <A, E>(
  use: (
    goals: GoalService.GoalService["Service"],
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const goals = yield* GoalService.GoalService;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    return yield* use(goals, scope);
  });

export const layer = McpToolAccess.toLayer(FleetToolkit, {
  goat_permission_profile_get: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { scope, limits } = yield* readCaller();
      const profiles = yield* Profiles.PermissionProfiles;
      return yield* profiles.resolve(scope, limits.runtimeMode);
    }),
  ),
  goat_goatclaw_sync: McpToolAccess.writesWithCapability(({ policy }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const deny = () =>
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Only a connected GOAT allowed to change this machine's settings syncs goatclaw policy.",
        });
      // Another machine's dispatch session, never an agent: it changes what every agent here may do.
      if (
        scope.thread !== undefined ||
        scope.client === undefined ||
        !scope.grantedScopes?.includes("settings:write") ||
        !scope.reauthorize
      )
        return yield* deny();
      yield* scope.reauthorize(["settings:write"]).pipe(Effect.mapError(deny));
      const sync = yield* Effect.serviceOption(FleetSync.GoatclawFleetSync);
      if (sync._tag === "None")
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "goatclaw fleet sync is unavailable on this machine.",
        });
      return { policy: yield* sync.value.receive(policy) };
    }),
  ),
  goat_goal_apply: McpToolAccess.writesAsCaller((input) =>
    withGoals((goals, scope) => goals.apply(scope, input)),
  ),
  goat_goal_get: McpToolAccess.readsAsCaller(({ id }) =>
    withGoals((goals, scope) => goals.get(scope, id)),
  ),
  goat_goal_list: McpToolAccess.readsAsCaller((input) =>
    withGoals((goals, scope) => goals.list(scope, input)),
  ),
  goat_goal_pause: McpToolAccess.writesAsCaller(({ id }) =>
    withGoals((goals, scope) => goals.setPaused(scope, id, true)).pipe(
      Effect.map((goal) => ({ goal })),
    ),
  ),
  goat_goal_resume: McpToolAccess.writesAsCaller(({ id }) =>
    withGoals((goals, scope) => goals.setPaused(scope, id, false)).pipe(
      Effect.map((goal) => ({ goal })),
    ),
  ),
  goat_goal_delete: McpToolAccess.destructive(
    McpToolAccess.writesAsCaller((input) =>
      withGoals((goals, scope) => goals.remove(scope, input)),
    ),
  ),
});
