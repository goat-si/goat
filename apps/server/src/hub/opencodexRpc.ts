import { WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OpenCodexManagedUpdate from "./OpenCodexManagedUpdate.ts";
import * as OpenCodexSync from "./OpenCodexSync.ts";

/**
 * OpenCodex update and sync for a person in a GOAT client, spread into the ws handlers. The
 * session's environment:maintain scope is checked before these run; a person reaches every Child.
 */
export const makeOpenCodexRpcHandlers = Effect.fn("OpenCodexRpc.makeHandlers")(function* (
  scope: Effect.Effect<McpInvocationScope>,
) {
  const update = yield* Effect.serviceOption(OpenCodexManagedUpdate.OpenCodexManagedUpdate);
  const sync = yield* OpenCodexSync.OpenCodexSync;
  return {
    [WS_METHODS.serverCheckOpenCodexUpdate]: () =>
      Option.match(update, {
        onNone: () => Effect.succeed(null),
        onSome: (service) => service.checkNow.pipe(Effect.map((status) => status ?? null)),
      }),
    [WS_METHODS.serverPlanOpenCodexSync]: () => Effect.flatMap(scope, (read) => sync.plan(read)),
    [WS_METHODS.serverSyncOpenCodex]: () => Effect.flatMap(scope, (run) => sync.run(run)),
    [WS_METHODS.serverSubscribeOpenCodexSync]: () => sync.changes,
  } as const;
});
