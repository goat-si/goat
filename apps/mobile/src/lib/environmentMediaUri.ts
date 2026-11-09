import { resolveEnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import type { ResolveMediaSourceInput } from "@goat/client-runtime/media-source";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession, usePreparedConnection } from "../state/session";
import { normalizeNativeMarkdownUrl } from "./markdownLinks";
import type { MediaActionsSource } from "./mediaActionsSource";

type PreparedConnection = ReturnType<typeof usePreparedConnection>;

/** Media from an environment: its loopback servers live on that machine, never on this phone. */
export function mobileMediaConnection(
  connection: PreparedConnection,
): NonNullable<ResolveMediaSourceInput["environmentConnection"]> {
  const prepared = Option.getOrNull(connection);
  return {
    connection:
      prepared === null ? null : { target: prepared.target, httpBaseUrl: prepared.httpBaseUrl },
    isDesktopRenderer: false,
    normalizeUri: normalizeNativeMarkdownUrl,
  };
}

/** Where this phone loads a media URL from the environment, following reconnects. */
export function useEnvironmentMediaUri(
  environmentId: EnvironmentId | null,
  uri: string,
): { readonly uri: string | null; readonly reason?: string } {
  const environment = mobileMediaConnection(usePreparedConnection(environmentId));
  const url = normalizeNativeMarkdownUrl(uri);
  if (environmentId === null) return { uri: url };
  const routed = resolveEnvironmentLoopbackUrl({ ...environment, url });
  return routed._tag === "Open" ? { uri: routed.url } : { uri: null, reason: routed.reason };
}
/** The connection at this moment, for taps; rendering subscribes through usePreparedConnection. */
export function readMobileMediaConnection(environmentId: EnvironmentId) {
  return mobileMediaConnection(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}
/** Share and save act on the routed address, and on nothing when this phone cannot reach it. */
export function routedActionsSource(
  source: MediaActionsSource | undefined,
  routedUri: string | null,
): MediaActionsSource | undefined {
  if (source === undefined || !("uri" in source)) return source;
  return routedUri === null ? undefined : { ...source, uri: routedUri };
}
/** Routes a tapped URL from the environment with the connection at this moment. */
export function routeMobileMediaUrl(environmentId: EnvironmentId, url: string) {
  const environment = readMobileMediaConnection(environmentId);
  return resolveEnvironmentLoopbackUrl({
    connection: environment.connection,
    isDesktopRenderer: false,
    url: environment.normalizeUri(url),
  });
}
/** Where a Markdown image source loads from with this connection; it changes only for loopback URLs. */
export function mediaRouteKey(
  environment: ReturnType<typeof mobileMediaConnection>,
  href: string,
): string {
  const routed = resolveEnvironmentLoopbackUrl({
    connection: environment.connection,
    isDesktopRenderer: false,
    url: environment.normalizeUri(href),
  });
  return routed._tag === "Open" ? routed.url : `unreachable:${href}`;
}
