import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PlacementArgument } from "../fleet/admission/PlacementKey.ts";
import { PLACEMENT_UNSUPPORTED, SshRemoteDispatchError } from "./dispatchFailure.ts";

export type { PlacementArgument };

/**
 * A placed launch over SSH dispatch: the remote admits it itself, and every retry of the key is
 * one launch. It is sent only when the launching session's own fresh listing declares placement.
 */
const decodeRemoteThread = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: ThreadId, runId: Schema.optional(Schema.NullOr(Schema.String)) }),
);

/** Never the cached declarations: they prove nothing about the session this launch uses. */
export const refuseUndeclared = (
  placement: PlacementArgument | undefined,
  fresh: { readonly declared: ReadonlySet<string> } | null | undefined,
  alias: string,
) =>
  placement === undefined || fresh?.declared.has("placement") === true
    ? Effect.void
    : Effect.fail(
        new SshRemoteDispatchError({
          reason: "remote_refused",
          remoteClassification: PLACEMENT_UNSUPPORTED,
          launchMayHaveStarted: false,
          message: `GOAT on ${alias} does not admit placed launches, so this work is not placed there.`,
        }),
      );

export const launchArguments = (placement: PlacementArgument | undefined) =>
  placement === undefined ? {} : { placement };

/** The launch acknowledgement; a placed launch must also say the remote admitted it. */
export const decodeLaunched = (
  raw: unknown,
  placement: PlacementArgument | undefined,
  alias: string,
) =>
  decodeRemoteThread(raw).pipe(
    Effect.mapError(
      () =>
        new SshRemoteDispatchError({
          reason: "remote_refused",
          launchMayHaveStarted: true,
          message:
            "The remote launch returned no thread acknowledgement; inspect its threads before retrying.",
        }),
    ),
    Effect.filterOrFail(
      () =>
        placement === undefined ||
        (raw as { readonly placement?: { readonly outcome?: unknown } } | null)?.placement
          ?.outcome === "started",
      () =>
        new SshRemoteDispatchError({
          reason: "remote_refused",
          launchMayHaveStarted: true,
          message: `GOAT on ${alias} answered a placed launch without admitting it; its outcome is unknown.`,
        }),
    ),
  );
