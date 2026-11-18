import type { ServerAuthPolicy, ServerDirectEndpoint } from "@goat/contracts";

/** A loopback server advertises a direct endpoint only once its Tailscale Serve URL answers. */
export function isServerNetworkAccessible(
  authPolicy: ServerAuthPolicy | null,
  config:
    | { readonly directEndpoints?: ReadonlyArray<ServerDirectEndpoint> | undefined }
    | null
    | undefined,
): boolean {
  if (authPolicy === "remote-reachable") return true;
  return authPolicy === "loopback-browser" && (config?.directEndpoints?.length ?? 0) > 0;
}
