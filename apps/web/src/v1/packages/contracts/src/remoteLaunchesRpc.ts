import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  RemoteLaunchesError,
  RemoteLaunchesListInput,
  RemoteLaunchesListResult,
} from "./remoteReports.ts";

export const REMOTE_LAUNCHES_WS_METHODS = {
  list: "remoteLaunches.list",
  dismiss: "remoteLaunches.dismiss",
} as const;

/** One remote thread, by the SSH alias this environment launched it through. */
export const RemoteLaunchDismissInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type RemoteLaunchDismissInput = typeof RemoteLaunchDismissInput.Type;
/** How many dispatch records and launch watches stopped following it; zero once it answers again. */
export const RemoteLaunchDismissResult = Schema.Struct({
  dispatches: NonNegativeInt,
  watches: NonNegativeInt,
});
export type RemoteLaunchDismissResult = typeof RemoteLaunchDismissResult.Type;

/** rpc.ts adds scope authorization, which lives there, when it publishes WsRemoteLaunchesRpcGroup. */
export const RemoteLaunchesRpcs = RpcGroup.make(
  Rpc.make(REMOTE_LAUNCHES_WS_METHODS.list, {
    payload: RemoteLaunchesListInput,
    success: RemoteLaunchesListResult,
    error: Schema.Union([RemoteLaunchesError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(REMOTE_LAUNCHES_WS_METHODS.dismiss, {
    payload: RemoteLaunchDismissInput,
    success: RemoteLaunchDismissResult,
    error: Schema.Union([RemoteLaunchesError, EnvironmentAuthorizationError]),
  }),
);
