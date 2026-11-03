import type { SshTunnelEntry } from "./tunnel.ts";

/**
 * How a status read publishes a live runtime. One this app does not own is served only with
 * verified binary signals, and a served one whose forward points elsewhere is stale.
 */
export function admitLive(
  entry: SshTunnelEntry | undefined,
  live: {
    readonly liveOwned?: boolean | undefined;
    readonly livePort?: number | undefined;
    readonly liveVersion?: string | undefined;
    readonly blocked: boolean;
    readonly compatible: boolean;
    readonly binaryVerified: boolean;
    readonly order: number | undefined;
  },
) {
  const unowned = live.liveOwned !== true;
  const restricted = !live.binaryVerified && (live.blocked || unowned);
  const newerBuild = live.order !== undefined && live.order > 0;
  const moved =
    entry !== undefined &&
    (entry.remotePort !== live.livePort || entry.selectedRuntime.version !== live.liveVersion);
  return {
    restricted,
    /** This app cannot move it, so no archive retry or acquisition failure applies. */
    unreplaceable: live.binaryVerified && (live.blocked || unowned || newerBuild),
    explainsUpdate: !restricted && live.blocked && (live.order === undefined || live.order < 0),
    newer: newerBuild && !live.compatible,
    staleEntry: !restricted && unowned && moved ? entry : undefined,
  };
}
