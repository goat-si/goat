import type { HandoffError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Handoffs from "../handoffs/Handoffs.ts";
import type * as SshHostSetup from "./SshHostSetup.ts";
import type * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const RuntimeUpdate = Schema.Struct({
  step: Schema.Literal("runtime_update"),
  host: Schema.String,
  operationId: Schema.String,
  requestedVersion: Schema.String,
});
const decodeRuntimeUpdate = Schema.decodeUnknownOption(RuntimeUpdate);

/**
 * Ends "Update runtime on <host>?" approvals nobody needs any more: the host already runs the
 * version the approval would install, because it was updated another way. An open approval holds
 * its thread, so a stale one would otherwise block that thread until it expires.
 */
export const cancelStaleRuntimeUpdates = Effect.fn("SshHostSetup.cancelStaleRuntimeUpdates")(
  function* (
    handoffs: Handoffs.Handoffs["Service"],
    setup: Pick<SshHostSetup.SshHostSetup["Service"], "status">,
    dispatch: Option.Option<
      Pick<SshRemoteDispatch.SshRemoteDispatch["Service"], "publishSetupOutcome">
    >,
  ): Effect.fn.Return<void, HandoffError> {
    for (const { handoff, args } of yield* handoffs.pendingContinuations("ssh.runtime_update")) {
      const update = decodeRuntimeUpdate(args);
      if (Option.isNone(update) || update.value.requestedVersion === "") continue;
      const { host, operationId, requestedVersion } = update.value;
      const current = (yield* setup.status({ host })).status;
      if (current?.state !== "ready" || current.runtimeVersion !== requestedVersion) continue;
      const address = { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId };
      // Done is recorded first: until the card ends, each tick repeats this, so a stop between
      // the steps never leaves the update without its outcome.
      if (Option.isSome(dispatch) && current.setup?.operationId === operationId)
        yield* dispatch.value.publishSetupOutcome(host, current.setup, { kind: "complete" });
      const ended = yield* handoffs.cancelPending(
        address,
        `${host} already runs GOAT ${requestedVersion}, so it needs no update.`,
      );
      // A person may have answered since the read; their answer stands.
      if (ended.state !== "cancelled" || ended.actor.type !== "server") continue;
      yield* handoffs.finishSshContinuation(address);
    }
  },
);
