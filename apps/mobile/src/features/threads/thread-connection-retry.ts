import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";

export function connectionRetryLabel(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
}): string | null {
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting")
    return null;
  return input.connectionError === null ? "Reconnecting…" : "Retrying connection…";
}
