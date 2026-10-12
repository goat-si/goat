import type { GoatHostStatusInput } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { HostStatusToolkit } from "./tools.ts";

/** Fan-out and a named host use this machine's SSH keys. local:true does not. */
const reachesAnotherHost = (input: GoatHostStatusInput) => input.local !== true;

export const layer = McpToolAccess.toLayer(HostStatusToolkit, {
  goat_host_status: McpToolAccess.readsOrReachesHost(reachesAnotherHost, (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const status = yield* HostStatusMcpService.HostStatusMcpService;
      return yield* status.read(scope, input);
    }),
  ),
});
