import { type AuthSessionId, type HubDeviceChildOptIn, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ChildBootstrap from "../opencodex/OpenCodexChildBootstrap.ts";
import * as OpenCodexManagedUpdate from "./OpenCodexManagedUpdate.ts";
import * as OpenCodexSync from "./OpenCodexSync.ts";

/**
 * OpenCodex update, sync and SSH Child setup for a person in a GOAT client, spread into the ws
 * handlers. Each method's scope is checked before it runs; a person reaches every Child.
 */
export const makeOpenCodexRpcHandlers = Effect.fn("OpenCodexRpc.makeHandlers")(function* (
  scope: Effect.Effect<McpInvocationScope>,
  sessionId: AuthSessionId,
) {
  const update = yield* Effect.serviceOption(OpenCodexManagedUpdate.OpenCodexManagedUpdate);
  const sync = yield* OpenCodexSync.OpenCodexSync;
  const childBootstrap = yield* ChildBootstrap.OpenCodexChildBootstrap;
  return {
    [WS_METHODS.serverCheckOpenCodexUpdate]: () =>
      Option.match(update, {
        onNone: () => Effect.succeed(null),
        onSome: (service) => service.checkNow.pipe(Effect.map((status) => status ?? null)),
      }),
    [WS_METHODS.serverPlanOpenCodexSync]: () => Effect.flatMap(scope, (read) => sync.plan(read)),
    [WS_METHODS.serverSyncOpenCodex]: () => Effect.flatMap(scope, (run) => sync.run(run)),
    [WS_METHODS.serverSubscribeOpenCodexSync]: () => sync.changes,
    // The service checks this session again: only a live one with settings:write gives consent.
    [WS_METHODS.hubDeviceChildOptIn]: (input: HubDeviceChildOptIn) =>
      childBootstrap
        .setSshOptIn(input.deviceAlias, input.enabled, { kind: "client", sessionId })
        .pipe(Effect.as(input)),
  } as const;
});
