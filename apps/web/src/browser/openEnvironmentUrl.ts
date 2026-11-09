import {
  type ConnectionTarget,
  type EnvironmentLoopbackUrl,
  resolveEnvironmentLoopbackUrl,
} from "@goat/client-runtime/connection";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveProtocolRelativeMediaUrl } from "~/components/media/mediaContent";
import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";

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

type PreparedConnection = { readonly target: ConnectionTarget; readonly httpBaseUrl: string };

/** How media from an environment reaches this device: its loopback servers live on that machine. */
export function environmentMediaConnection(connection: PreparedConnection | null) {
  return {
    connection:
      connection === null
        ? null
        : { target: connection.target, httpBaseUrl: connection.httpBaseUrl },
    isDesktopRenderer: isElectron,
    normalizeUri: resolveProtocolRelativeMediaUrl,
  };
}

export function readEnvironmentMediaConnection(environmentId: EnvironmentId) {
  return environmentMediaConnection(readPreparedConnection(environmentId));
}

export function routeEnvironmentMediaUrl(
  environment: ReturnType<typeof environmentMediaConnection>,
  url: string,
): EnvironmentLoopbackUrl {
  return resolveEnvironmentLoopbackUrl({
    connection: environment.connection,
    isDesktopRenderer: environment.isDesktopRenderer,
    url: environment.normalizeUri(url),
  });
}

/** Routes on demand, for clicks; rendering subscribes through useEnvironmentMediaRoute instead. */
export function readEnvironmentMediaRoute(
  environmentId: EnvironmentId | null,
  url: string,
): EnvironmentLoopbackUrl {
  return environmentId === null
    ? { _tag: "Open", url: resolveProtocolRelativeMediaUrl(url) }
    : routeEnvironmentMediaUrl(readEnvironmentMediaConnection(environmentId), url);
}

/** Routes media URLs as the connection changes; only media with a direct URL should subscribe. */
export function useEnvironmentMediaRoute(
  environmentId: EnvironmentId | null,
): (url: string) => EnvironmentLoopbackUrl {
  const connection = usePreparedConnection(environmentId);
  return (url) =>
    environmentId === null
      ? { _tag: "Open", url: resolveProtocolRelativeMediaUrl(url) }
      : routeEnvironmentMediaUrl(environmentMediaConnection(Option.getOrNull(connection)), url);
}
