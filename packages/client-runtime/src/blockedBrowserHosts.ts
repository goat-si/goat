import { ServerSettingsPatch } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

export const INVALID_BLOCKED_HOST =
  "Enter a host name such as example.com, without http:// or a path.";

export function addBlockedBrowserHost(hosts: readonly string[], input: string) {
  try {
    const patch = decodePatch({ blockedBrowserHosts: [input] });
    const host = patch.blockedBrowserHosts?.[0];
    if (host === undefined) return { ok: false as const, error: "Enter a host." };
    return { ok: true as const, hosts: hosts.includes(host) ? hosts : [...hosts, host] };
  } catch {
    return { ok: false as const, error: INVALID_BLOCKED_HOST };
  }
}

export const removeBlockedBrowserHost = (hosts: readonly string[], host: string) =>
  hosts.filter((entry) => entry !== host);
