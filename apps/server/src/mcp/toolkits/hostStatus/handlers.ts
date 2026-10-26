import type {
  GoatHostStatusInput,
  GoatHubOpenCodexSyncInput,
  HubDeviceOperationInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as HostHealthMonitor from "../../../fleet/health/HostHealthMonitor.ts";
import * as PressureNudger from "../../../fleet/pressure/PressureNudger.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { HostStatusToolkit } from "./tools.ts";
import * as HubParity from "../../../hub/HubParity.ts";
import * as HubMembership from "../../../hub/HubMembership.ts";
import * as OpenCodexSync from "../../../hub/OpenCodexSync.ts";

/** Fan-out and a named host use this machine's SSH keys. local:true does not. */
const reachesAnotherHost = (input: GoatHostStatusInput) => input.local !== true;
const membership = (operation: "join" | "leave" | "repair") =>
  McpToolAccess.writes((input: HubDeviceOperationInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* HubMembership.HubMembership)[operation](scope, input);
    }),
  );

/**
 * The fan-out names no host, so the registry's gate checks none. Each Child needs what a named
 * host would: hub.manage and threads.remote for it, resolved again right before it runs.
 */
const openCodexSync = McpToolAccess.writes((input: GoatHubOpenCodexSyncInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const sync = yield* OpenCodexSync.OpenCodexSync;
    const profiles = yield* Profiles.PermissionProfiles;
    const permits = (host: string) =>
      scope.thread === undefined
        ? Effect.succeed(true)
        : profiles.resolve(scope).pipe(
            Effect.map(
              (effective) =>
                Profiles.checkProfile(effective, "hub.manage", { host }).ok &&
                Profiles.checkProfile(effective, "threads.remote", { host }).ok,
            ),
            Effect.orElseSucceed(() => false),
          );
    return yield* input.dryRun === true ? sync.plan(scope, permits) : sync.run(scope, permits);
  }),
);

export const layer = McpToolAccess.toLayer(HostStatusToolkit, {
  goat_hub_device_join: membership("join"),
  goat_hub_device_leave: McpToolAccess.destructive(membership("leave")),
  goat_hub_device_repair: membership("repair"),
  goat_hub_opencodex_sync: openCodexSync,
  goat_hub_device_verify: McpToolAccess.readsOrReachesHost(
    () => true,
    (input) =>
      Effect.gen(function* () {
        yield* readCaller();
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const parity = yield* HubParity.HubParity;
        return {
          deviceAlias: input.deviceAlias,
          parity: yield* parity.verify(input.deviceAlias, scope),
        };
      }),
  ),
  goat_host_status: McpToolAccess.readsOrReachesHost(reachesAnotherHost, (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const status = yield* HostStatusMcpService.HostStatusMcpService;
      const result = yield* status.read(scope, input);
      // Every read is also a health sample; conditions are additive for older clients.
      const health = yield* Effect.serviceOption(HostHealthMonitor.HostHealthMonitor);
      const annotated = health._tag === "Some" ? yield* health.value.annotate(result) : result;
      // And a pressure reading, which later launch advice and notices use.
      const pressure = yield* Effect.serviceOption(PressureNudger.PressureNudger);
      if (pressure._tag === "None") return annotated;
      yield* pressure.value.observe(annotated);
      if (input.placement === undefined) return annotated;
      return {
        ...annotated,
        placement: yield* pressure.value.rank(annotated.hosts, input.placement),
      };
    }),
  ),
});
