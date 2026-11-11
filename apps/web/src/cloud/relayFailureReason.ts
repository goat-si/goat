import { ManagedRelay, relayRequestFailureDetail } from "@goat/client-runtime/relay";
import * as Schema from "effect/Schema";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a GOAT Connect request failed. */
export function relayFailureReason(cause: unknown): string | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current)) return "GOAT Connect timed out. Try again.";
    if (isRequestFailed(current)) {
      if (current.transportFailed) return "Could not reach GOAT Connect. Check your network.";
      if (current.relayError) {
        return current.relayError._tag === "RelayInternalError"
          ? "GOAT Connect is unavailable. Try again."
          : relayRequestFailureDetail(current);
      }
      if (current.status === 504) return "GOAT Connect timed out. Try again.";
      if ((current.status ?? 0) >= 500) return "GOAT Connect is unavailable. Try again.";
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}
