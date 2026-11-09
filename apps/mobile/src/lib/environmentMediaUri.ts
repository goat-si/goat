import { resolveEnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import type { ResolveMediaSourceInput } from "@goat/client-runtime/media-source";
import type { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";

import { usePreparedConnection } from "../state/session";
import { normalizeNativeMarkdownUrl } from "./markdownLinks";

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
