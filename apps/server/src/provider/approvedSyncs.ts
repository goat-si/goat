import { ProviderHostSyncError, TurnItemId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Handoffs from "../handoffs/Handoffs.ts";
import type { SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";

const fail = (code: ProviderHostSyncError["code"], detail: string) =>
  new ProviderHostSyncError({ code, detail });

/**
 * What each approved provider sync became: the sync it started, or why it never started, so
 * status can say so instead of "not started yet".
 */
export const makeApprovedSyncs = (handoffs: Handoffs.Handoffs["Service"]) => {
  const started = new Map<string, string>();
  const failedStarts = new Map<string, string>();

  /** Why a handoff has no sync: read from the persisted handoff in the asking thread. */
  const explain = Effect.fn("ProviderHostSync.explainUnstarted")(function* (
    handoffId: string,
    caller: SshHostCaller,
  ) {
    const failure = failedStarts.get(handoffId);
    if (failure !== undefined)
      return yield* fail(
        "start_failed",
        `The person approved this sync, but it did not start: ${failure}`,
      );
    const thread = caller.kind === "mcp" ? caller.scope.thread : undefined;
    const handoff =
      thread === undefined
        ? undefined
        : yield* handoffs
            .read({ threadId: thread.threadId, handoffId: TurnItemId.make(handoffId) })
            .pipe(
              Effect.catchTags({
                HandoffError: (error) =>
                  error.reason === "not_found"
                    ? Effect.succeed(undefined)
                    : Effect.fail(fail("unavailable", "Could not read the approval. Try again.")),
              }),
            );
    switch (handoff?.state) {
      case "declined":
        return yield* fail("declined", "The person declined this sync, so it will not run.");
      case "expired":
        return yield* fail(
          "expired",
          "This approval expired before anyone answered it. Call goat_provider_sync to ask again.",
        );
      case "cancelled":
        return yield* fail("cancelled", "This approval was cancelled, so the sync will not run.");
      case "failed":
        return yield* fail("start_failed", "This approval failed, so the sync did not start.");
      case "completed":
        return yield* fail(
          "not_found",
          "This approval's sync is no longer tracked: it finished more than two hours ago or this server restarted. Call goat_provider_host_matrix to see each host.",
        );
      default:
        return yield* fail(
          "not_found",
          "That approval has not started a sync yet. Ask the person to approve it.",
        );
    }
  });

  return {
    syncId: (handoffId: string) => started.get(handoffId),
    started: (handoffId: string, syncId: string) =>
      Effect.sync(() => void started.set(handoffId, syncId)),
    failed: <E extends { readonly message: string }>(handoffId: string, cause: Cause.Cause<E>) =>
      Effect.sync(() => {
        // Typed failures carry text safe to show; anything else stays generic.
        const error = Cause.findErrorOption(cause);
        failedStarts.set(
          handoffId,
          Option.isSome(error) ? error.value.message : "an unexpected error stopped it.",
        );
      }).pipe(Effect.andThen(Effect.logWarning("Approved provider sync did not start."))),
    explain,
  };
};
