import { OrchestratorMcpFailure, type DecisionListMcpInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { DecisionCaller } from "./DecisionInbox.ts";
import { scopeOf } from "./DecisionAuthority.ts";

type Controls = Pick<
  DecisionListMcpInput,
  | "host"
  | "hosts"
  | "launcherEnvironmentId"
  | "launcherThreadId"
  | "localOnly"
  | "transportEnvironmentId"
  | "permissionProfileCeiling"
>;

/** Transport controls select local data and narrow authority; they never initiate another hop. */
export const validateTransport = Effect.fn("DecisionInbox.validateTransport")(function* (
  caller: DecisionCaller,
  input: Controls,
) {
  const scope = scopeOf(caller);
  const foreign = input.launcherEnvironmentId ?? input.transportEnvironmentId;
  const controls =
    foreign !== undefined ||
    input.launcherThreadId !== undefined ||
    input.localOnly !== undefined ||
    input.permissionProfileCeiling !== undefined;
  if (
    input.host !== undefined ||
    input.hosts !== undefined ||
    (controls &&
      (caller.kind !== "agent" ||
        scope.thread !== undefined ||
        scope.client === undefined ||
        foreign === undefined ||
        foreign === scope.environmentId ||
        (input.launcherEnvironmentId !== undefined &&
          input.transportEnvironmentId !== undefined &&
          input.launcherEnvironmentId !== input.transportEnvironmentId)))
  )
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Destination controls require an authenticated outside caller, a foreign environment identity, and no routing arguments.",
    });
  return foreign;
});
