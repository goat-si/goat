import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsRefreshStatusResult,
  VcsStatusStreamEvent,
  VcsStatusSubscriptionInput,
} from "@goat/contracts";

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly streamBranchStatus: (
      input: VcsStatusInput,
    ) => Stream.Stream<VcsBranchStatus, GitManagerServiceError>;
    readonly refreshBranchStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsBranchStatus, GitManagerServiceError>;
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    /**
     * For a checkout someone is waiting on. Returns once the new branch is published, so the
     * caller's reply does not outrun it, and finishes the slower remote read in the background.
     */
    readonly refreshAfterCheckout: (cwd: string) => Effect.Effect<void, GitManagerServiceError>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsRefreshStatusResult, GitManagerServiceError>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
  // @effect-diagnostics-next-line deterministicKeys:off -- Preserve the service key across the move.
>()("goat/vcs/VcsStatusBroadcaster") {}
