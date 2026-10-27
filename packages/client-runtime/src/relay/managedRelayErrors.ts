import * as Schema from "effect/Schema";
import { RelayProtectedError } from "@goat/contracts/relay";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";

export const ManagedRelayRequestAction = Schema.Literals([
  "exchange relay DPoP access token",
  "list relay-managed environments",
  "list relay client devices",
  "create relay environment link challenge",
  "link relay environment",
  "unlink relay environment",
  "get relay environment status",
  "connect relay environment",
  "register relay mobile device",
  "unregister relay mobile device",
  "register relay live activity",
  "read relay agent activity snapshot",
]);
export type ManagedRelayRequestAction = typeof ManagedRelayRequestAction.Type;

export class ManagedRelayRequestFailedError extends Schema.TaggedError<ManagedRelayRequestFailedError>()(
  "ManagedRelayRequestFailedError",
  {
    action: ManagedRelayRequestAction,
    retryAfterMillis: Schema.optionalKey(Schema.Number),
    retryAfter: Schema.optionalKey(Schema.String),
    transportFailed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
    relayError: Schema.optional(RelayProtectedError),
    status: Schema.optional(Schema.Number),
    traceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const message = `Could not ${this.action}.`;
    return this.transportFailed ? `${message} ${NETWORK_BLOCKING_HINT}` : message;
  }
}

export function parseRelayRetryAfter(
  value: string | undefined,
  nowMillis: number,
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^[+-]?\d/.test(trimmed) && !/^\d+$/.test(trimmed)) return undefined;
  const millis = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMillis;
  return Number.isFinite(millis) && millis >= 0 ? millis : undefined;
}
