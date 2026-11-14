import * as ScopedReadMcp from "../../ScopedReadMcp.ts";
import type {
  GoatHostStatusInput,
  GoatHubOpenCodexSyncInput,
  HubDeviceMoveInput,
  HubDeviceOperationInput,
  HubDeviceRoutesInput,
  HubDeviceRoutesUpdateInput,
  HubMachineAttachInput,
  HubMachineListInput,
  HubMachineReissueInput,
  HubMachineDetachInput,
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
import * as ChildReady from "../../../opencodex/OpenCodexChildReady.ts";
import * as ChildBootstrap from "../../../opencodex/OpenCodexChildBootstrap.ts";
import * as DisposableAttach from "../../../hub/disposable/DisposableAttach.ts";
import { penNodeId } from "../../../hub/disposable/attachModel.ts";
import { machineFailure, threadOf } from "./machineFailure.ts";

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
  goat_host_process_history: McpToolAccess.reads((input) =>
    Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
      ScopedReadMcp.processHistory(scope, input),
    ),
  ),
  goat_host_resource_history: McpToolAccess.reads((input) =>
    Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
      ScopedReadMcp.resourceHistory(scope, input),
    ),
  ),
  // Only a Home-issued Child setup purpose passes childSetupWrite; ordinary sessions never do.
  goat_hub_child_prepare: McpToolAccess.childSetupWrite((input) =>
    Effect.gen(function* () {
      const service = yield* ChildReady.OpenCodexChildReady;
      return yield* service.prepare(input, yield* McpInvocationContext.McpInvocationContext);
    }),
  ),
  goat_hub_child_connection: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const service = yield* ChildReady.OpenCodexChildReady;
      return yield* service.connection(input, yield* McpInvocationContext.McpInvocationContext);
    }),
  ),
  goat_hub_child_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* ChildReady.OpenCodexChildReady;
      return yield* service.status(input, yield* McpInvocationContext.McpInvocationContext);
    }),
  ),
  goat_hub_device_join: membership("join"),
  // Standing Child consent is checked by the service; this tool never gives consent.
  goat_hub_device_setup: McpToolAccess.writes((input) =>
    Effect.flatMap(ChildBootstrap.OpenCodexChildBootstrap, (bootstrap) =>
      bootstrap.setupDevice(input),
    ),
  ),
  goat_hub_device_leave: McpToolAccess.destructive(membership("leave")),
  goat_hub_device_repair: membership("repair"),
  goat_hub_device_move: McpToolAccess.destructive(
    McpToolAccess.writes((input: HubDeviceMoveInput) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return yield* (yield* HubMembership.HubMembership).move(scope, input);
      }),
    ),
  ),
  goat_hub_opencodex_sync: openCodexSync,
  goat_hub_device_routes: McpToolAccess.reads((input: HubDeviceRoutesInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* HubMembership.HubMembership).routes(scope, input);
    }),
  ),
  goat_hub_device_routes_update: McpToolAccess.writes((input: HubDeviceRoutesUpdateInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* (yield* HubMembership.HubMembership).updateRoutes(scope, input);
    }),
  ),
  // The switch, the named thread and the grant are the service's checks; goatclaw narrows agents.
  goat_hub_machine_attach: McpToolAccess.writesAsCaller((input: HubMachineAttachInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = yield* threadOf(scope);
      const nodeId = penNodeId(input.signPub) ?? "invalid";
      yield* (yield* Profiles.PermissionProfiles).require(scope, "hub.manage", {
        host: "pen-" + nodeId,
      });
      const caller = {
        provisioner: {
          kind: "thread" as const,
          threadId: threadId,
          ...(input.cloudRunId === undefined ? {} : { cloudRunId: input.cloudRunId }),
        },
      };
      return yield* (yield* DisposableAttach.DisposableAttach)
        .attach(caller, "thread:" + threadId, input)
        .pipe(Effect.mapError(machineFailure));
    }),
  ),
  goat_hub_machine_reissue: McpToolAccess.writesAsCaller((input: HubMachineReissueInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = yield* threadOf(scope);
      const machines = yield* DisposableAttach.DisposableAttach;
      const nodeId = yield* machines.nodeOf(input.attachId).pipe(Effect.mapError(machineFailure));
      if (nodeId !== undefined)
        yield* (yield* Profiles.PermissionProfiles).require(scope, "hub.manage", {
          host: "pen-" + nodeId,
        });
      const caller = { provisioner: { kind: "thread" as const, threadId: threadId } };
      return yield* machines
        .reissue(caller, "thread:" + threadId, input)
        .pipe(Effect.mapError(machineFailure));
    }),
  ),
  goat_hub_machine_list: McpToolAccess.reads((input: HubMachineListInput) =>
    Effect.flatMap(DisposableAttach.DisposableAttach, (machines) =>
      machines.list(input).pipe(Effect.mapError(machineFailure)),
    ),
  ),
  // Force is a person's step; the service refuses it for a thread.
  goat_hub_machine_detach: McpToolAccess.writesAsCaller((input: HubMachineDetachInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadId = yield* threadOf(scope);
      const machines = yield* DisposableAttach.DisposableAttach;
      const nodeId = yield* machines.nodeOf(input.attachId).pipe(Effect.mapError(machineFailure));
      if (nodeId !== undefined)
        yield* (yield* Profiles.PermissionProfiles).require(scope, "hub.manage", {
          host: "pen-" + nodeId,
        });
      const caller = { provisioner: { kind: "thread" as const, threadId: threadId } };
      return yield* machines
        .detach(caller, "thread:" + threadId, input)
        .pipe(Effect.mapError(machineFailure));
    }),
  ),
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
