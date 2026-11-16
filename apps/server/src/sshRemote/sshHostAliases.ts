import { discoverSshHosts } from "@goat/ssh/config";
import * as Effect from "effect/Effect";

// Agents reach a host by alias, so known_hosts entries on several ports are one host here.
export const discoverSshHostAliases = () =>
  discoverSshHosts({}).pipe(
    Effect.map((hosts) => {
      const seen = new Set<string>();
      return hosts.filter((host) => !seen.has(host.alias) && Boolean(seen.add(host.alias)));
    }),
  );
