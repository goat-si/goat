import type { HubDeviceTransport } from "@goat/contracts";
import { WINDOWS_REMOTE_LINK_UNPINNED } from "@goat/shared/opencodexRelease";

import type { DevicePlatform } from "./HubOcx.ts";

const WINDOWS_REFUSAL = `${WINDOWS_REMOTE_LINK_UNPINNED} Join it as a Hub-mode client with transport hub-client.`;
const PLATFORM_LABEL = { windows: "Windows", posix: "POSIX", unknown: "Platform unknown" };

/**
 * Picks the join transport. Remote Link to Windows exists only in a release this GOAT pins; older
 * ones refuse it after issuing a key and starting a tunnel (OCX-9). No POSIX answer may mean
 * native Windows, which has no shell for a Hub client and needs that same pin.
 */
export const joinPreflight = (
  alias: string,
  platform: DevicePlatform | undefined,
  requested: HubDeviceTransport | undefined,
  windowsPinned: boolean,
): { readonly ok: boolean; readonly transport: HubDeviceTransport; readonly detail: string } => {
  if (platform === undefined && requested === "hub-client")
    return {
      ok: false,
      transport: requested,
      detail: `${alias} did not answer a POSIX shell, which a Hub client join needs. Join native Windows through Remote Link.`,
    };
  if (platform === undefined && !windowsPinned)
    return {
      ok: false,
      transport: requested ?? "remote-link",
      detail: `${alias} did not answer a POSIX shell, so it may be native Windows. ${WINDOWS_REMOTE_LINK_UNPINNED}`,
    };
  const refused = platform === "windows" && !windowsPinned;
  const transport = requested ?? (refused ? "hub-client" : "remote-link");
  if (transport === "remote-link" && refused)
    return { ok: false, transport, detail: WINDOWS_REFUSAL };
  return {
    ok: true,
    transport,
    detail: `${PLATFORM_LABEL[platform ?? "unknown"]}; joining as ${transport}.`,
  };
};
