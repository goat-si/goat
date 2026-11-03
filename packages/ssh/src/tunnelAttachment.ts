import type { SshTunnelEntry } from "./tunnel.ts";

export function staleUnmanagedAttachment(
  entry: SshTunnelEntry | undefined,
  servesUnmanaged: boolean,
  probe: { readonly livePort?: number | undefined; readonly liveVersion?: string | undefined },
) {
  return servesUnmanaged &&
    entry !== undefined &&
    (entry.remotePort !== probe.livePort || entry.selectedRuntime.version !== probe.liveVersion)
    ? entry
    : undefined;
}
