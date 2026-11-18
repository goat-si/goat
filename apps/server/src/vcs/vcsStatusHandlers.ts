import { WS_METHODS, type VcsStatusInput, type VcsStatusSubscriptionInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { VcsStatusBroadcaster } from "./VcsStatusBroadcaster.ts";

export function vcsStatusHandlers(vcsStatusBroadcaster: VcsStatusBroadcaster["Service"]) {
  return {
    [WS_METHODS.subscribeVcsBranch]: (input: VcsStatusInput) =>
      vcsStatusBroadcaster.streamBranchStatus(input),
    [WS_METHODS.vcsRefreshBranch]: (input: VcsStatusInput) =>
      vcsStatusBroadcaster.refreshBranchStatus(input).pipe(Effect.asVoid),
    [WS_METHODS.subscribeVcsStatus]: (input: VcsStatusSubscriptionInput) =>
      vcsStatusBroadcaster.streamStatus(input),
    [WS_METHODS.vcsRefreshStatus]: (
      input: VcsStatusInput & { readonly localOnly?: boolean | undefined },
    ) => vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
  };
}
