import { resolveEnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";
import { readPreparedConnection } from "~/state/session";

export class EnvironmentUrlUnreachableError extends Schema.TaggedError<EnvironmentUrlUnreachableError>()(
  "EnvironmentUrlUnreachableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const isEnvironmentUrlUnreachableError = Schema.is(EnvironmentUrlUnreachableError);

/** The system-browser address for a URL that came from this environment, or the reason there is none. */
function resolveEnvironmentExternalUrl(environmentId: EnvironmentId, url: string) {
  const connection = readPreparedConnection(environmentId);
  return resolveEnvironmentLoopbackUrl({
    url,
    connection:
      connection === null
        ? null
        : { target: connection.target, httpBaseUrl: connection.httpBaseUrl },
    isDesktopRenderer: isElectron,
  });
}

/** Rejects with EnvironmentUrlUnreachableError, before opening anything, when this device can't reach the address. */
export async function openEnvironmentUrlExternally(
  environmentId: EnvironmentId,
  url: string,
): Promise<void> {
  const resolved = resolveEnvironmentExternalUrl(environmentId, url);
  if (resolved._tag === "Unreachable")
    throw new EnvironmentUrlUnreachableError({ reason: resolved.reason });
  const api = readLocalApi();
  if (!api) throw new Error("Link opening is unavailable.");
  await api.shell.openExternal(resolved.url);
}

/** True when the browser's own navigation to url would land on the wrong machine. */
export function urlNeedsEnvironmentRoute(
  environmentId: EnvironmentId | null,
  url: string,
): boolean {
  if (environmentId === null) return false;
  const resolved = resolveEnvironmentExternalUrl(environmentId, url);
  return resolved._tag === "Unreachable" || resolved.url !== url;
}
