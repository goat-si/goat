import { ServerSettingsError } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isServerSettingsError = Schema.is(ServerSettingsError);

export function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
export function credentialDestinationDetail(cause: unknown): string | undefined {
  return isServerSettingsError(cause) &&
    cause.operation === "normalize" &&
    cause.reason?.startsWith(
      "Could not resolve source control credential: saved bitbucket credentials are only used for ",
    )
    ? cause.reason
    : undefined;
}
