import { ServerSettingsPatch } from "@goat/contracts";
import * as Schema from "effect/Schema";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

export function addBlockedBrowserHost(hosts: readonly string[], input: string) {
  try {
    const patch = decodePatch({ blockedBrowserHosts: [input] });
    const host = patch.blockedBrowserHosts?.[0];
    if (host === undefined) return { ok: false as const, error: "Enter a host." };
    return { ok: true as const, hosts: hosts.includes(host) ? hosts : [...hosts, host] };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export const removeBlockedBrowserHost = (hosts: readonly string[], host: string) =>
  hosts.filter((entry) => entry !== host);
