import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  GitManagerServiceError,
  VcsBranchStatus,
  VcsStatusInput,
  VcsStatusSubscriptionInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";

export const VCS_STATUS_WS_METHODS = {
  vcsRefreshStatus: "vcs.refreshStatus",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeVcsBranch: "subscribeVcsBranch",
  vcsRefreshBranch: "vcs.refreshBranch",
} as const;

const WsSubscribeVcsBranchRpc = Rpc.make(VCS_STATUS_WS_METHODS.subscribeVcsBranch, {
  payload: VcsStatusInput,
  success: VcsBranchStatus,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsRefreshBranchRpc = Rpc.make(VCS_STATUS_WS_METHODS.vcsRefreshBranch, {
  payload: VcsStatusInput,
  success: Schema.Void,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(VCS_STATUS_WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusSubscriptionInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsRefreshStatusRpc = Rpc.make(VCS_STATUS_WS_METHODS.vcsRefreshStatus, {
  payload: Schema.Struct({
    ...VcsStatusInput.fields,
    localOnly: Schema.optional(Schema.Boolean),
  }),
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const VcsStatusRpcs = [
  WsSubscribeVcsBranchRpc,
  WsVcsRefreshBranchRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsRefreshStatusRpc,
] as const;
