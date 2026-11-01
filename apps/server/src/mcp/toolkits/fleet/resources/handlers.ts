import { OrchestratorMcpFailure, ServerSettingsError } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as Fallback from "../../../../fleet/resources/Fallback.ts";
import * as Placement from "../../../../fleet/resources/Placement.ts";
import * as HostStatusMcpService from "../../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import * as McpToolAccess from "../../../McpToolAccess.ts";
import { readCaller } from "../../../threadAccess.ts";
import { FleetResourcesToolkit } from "./tools.ts";

const invalid = (error: Fallback.FallbackChainsError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(FleetResourcesToolkit, {
  // Reading other machines uses this machine's SSH keys, as goat_host_status does.
  goat_scheduler_status: McpToolAccess.readsOrReachesHost(
    (input) => input.local !== true,
    (input) =>
      Effect.gen(function* () {
        yield* readCaller();
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const status = yield* HostStatusMcpService.HostStatusMcpService;
        const placement = yield* Placement.Placement;
        const hosts = yield* status.read(scope, input.local === true ? { local: true } : {});
        return yield* placement.statusOf(hosts.hosts);
      }),
  ),
  goat_fallback_chain_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const chains = yield* Fallback.FallbackChains;
      const result = yield* chains.get;
      if (input.id === undefined) return result;
      const chain = result.chains[input.id];
      if (chain === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "No fallback chain named " + input.id + " is configured.",
        });
      return {
        chains: { [input.id]: chain },
        defaultFallbackChain:
          result.defaultFallbackChain === input.id ? result.defaultFallbackChain : null,
      };
    }),
  ),
  goat_fallback_chain_set: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input, check) =>
      Effect.gen(function* () {
        const services = yield* Effect.context<Effect.Services<typeof check>>();
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const chains = yield* Fallback.FallbackChains;
        // Inside the settings lock: the caller must still have full access, and a credential
        // it holds must still be live.
        const stillAllowed = check.pipe(
          Effect.andThen(Effect.suspend(() => scope.reauthorize?.([]) ?? Effect.void)),
          Effect.provideContext(services),
          Effect.asVoid,
          Effect.mapError(
            () =>
              new ServerSettingsError({
                settingsPath: Fallback.CALLER_REVOKED,
                operation: "normalize",
              }),
          ),
        );
        return yield* chains.set(input, stillAllowed).pipe(Effect.mapError(invalid));
      }),
    ),
  ),
});
