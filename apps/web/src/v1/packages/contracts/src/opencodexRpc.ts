import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { OpenCodexSyncReport, OpenCodexUpdateStatus } from "./opencodex.ts";

export const OPENCODEX_WS_METHODS = {
  serverCheckOpenCodexUpdate: "server.checkOpenCodexUpdate",
  serverPlanOpenCodexSync: "server.planOpenCodexSync",
  serverSyncOpenCodex: "server.syncOpenCodex",
  serverSubscribeOpenCodexSync: "server.subscribeOpenCodexSync",
} as const;

/**
 * Runs the managed OpenCodex update check now, Home first and then each Child. Null when this
 * machine coordinates no managed update (hub or goatclaw off).
 */
export const WsServerCheckOpenCodexUpdateRpc = Rpc.make(
  OPENCODEX_WS_METHODS.serverCheckOpenCodexUpdate,
  {
    payload: Schema.Struct({}),
    success: Schema.NullOr(OpenCodexUpdateStatus),
    error: EnvironmentAuthorizationError,
  },
);

/** What `ocx sync` would do on this machine and, on a Home, each linked Child. Reads only. */
export const WsServerPlanOpenCodexSyncRpc = Rpc.make(OPENCODEX_WS_METHODS.serverPlanOpenCodexSync, {
  payload: Schema.Struct({}),
  success: OpenCodexSyncReport,
  error: EnvironmentAuthorizationError,
});

/** Runs `ocx sync` on this machine, then each Child; progress streams on the subscription. */
export const WsServerSyncOpenCodexRpc = Rpc.make(OPENCODEX_WS_METHODS.serverSyncOpenCodex, {
  payload: Schema.Struct({}),
  success: OpenCodexSyncReport,
  error: EnvironmentAuthorizationError,
});

/** The latest sync report, then every change while a sync runs. Null before the first one. */
export const WsServerSubscribeOpenCodexSyncRpc = Rpc.make(
  OPENCODEX_WS_METHODS.serverSubscribeOpenCodexSync,
  {
    payload: Schema.Struct({}),
    success: Schema.NullOr(OpenCodexSyncReport),
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);
