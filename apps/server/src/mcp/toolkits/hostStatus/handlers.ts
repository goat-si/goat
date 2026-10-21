import type { GoatHostStatusInput } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as HostHealthMonitor from "../../../fleet/health/HostHealthMonitor.ts";
import * as PressureNudger from "../../../fleet/pressure/PressureNudger.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { HostStatusToolkit } from "./tools.ts";
import * as HubParity from "../../../hub/HubParity.ts";

/** Fan-out and a named host use this machine's SSH keys. local:true does not. */
const reachesAnotherHost = (input: GoatHostStatusInput) => input.local !== true;

export const layer = McpToolAccess.toLayer(HostStatusToolkit, {
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
