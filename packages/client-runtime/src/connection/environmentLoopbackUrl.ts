import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  normalizeHostname,
} from "@goat/shared/hostClassification";

import { isDesktopLocalConnectionTarget } from "./desktopLocal.ts";
import type { ConnectionTarget } from "./model.ts";

export type EnvironmentLoopbackUrl =
  | { readonly _tag: "Open"; readonly url: string }
  | { readonly _tag: "Unreachable"; readonly reason: string };

// URL parsing turns [::ffff:127.0.0.1] into [::ffff:7f00:1].
const IPV4_MAPPED_LOOPBACK = /^::ffff:7f[\da-f]{2}:[\da-f]{1,4}$/u;

const isLoopbackAddress = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  return (
    isLocalLoopbackHost(host) ||
    IPV4_MAPPED_LOOPBACK.test(host) ||
    host === "0.0.0.0" ||
    host === "::" ||
    host.endsWith(".localhost")
  );
};

/**
 * Where this device should open a URL that came from an environment (a server tab, terminal output,
 * a thread link). A loopback address means the environment's machine, so it is moved onto the
 * environment's direct LAN or tailnet host, or refused with a reason when no such route exists.
 */
export function resolveEnvironmentLoopbackUrl(input: {
  readonly url: string;
  readonly connection: { readonly target: ConnectionTarget; readonly httpBaseUrl: string } | null;
  readonly isDesktopRenderer: boolean;
}): EnvironmentLoopbackUrl {
  const open = { _tag: "Open", url: input.url } as const;
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return open;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackAddress(parsed.hostname)
  ) {
    return open;
  }
  const address = parsed.host;
  const { connection } = input;
  if (connection === null) {
    return {
      _tag: "Unreachable",
      reason: `The environment isn't connected, so ${address} can't be opened from this device.`,
    };
  }
  const { target } = connection;
  // Desktop renders primary and WSL pages itself; their loopback servers answer on this device's localhost.
  if (
    input.isDesktopRenderer &&
    (target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target))
  ) {
    return open;
  }
  const insteadHint = `Open it in ${target.label}'s browser instead.`;
  if (target._tag === "SshConnectionTarget") {
    return {
      _tag: "Unreachable",
      reason: `${address} is on ${target.label}, which this device reaches over SSH. ${insteadHint}`,
    };
  }
  if (target._tag === "HubProxyConnectionTarget" || target._tag === "RelayConnectionTarget") {
    return {
      _tag: "Unreachable",
      reason: `${address} is on ${target.label}, which this device reaches only through ${target._tag === "RelayConnectionTarget" ? "a relay" : "another GOAT server"}. ${insteadHint}`,
    };
  }
  let environmentUrl: URL;
  try {
    environmentUrl = new URL(connection.httpBaseUrl);
  } catch {
    return {
      _tag: "Unreachable",
      reason: `${address} is on ${target.label}, whose address can't be read. ${insteadHint}`,
    };
  }
  if (isLoopbackAddress(environmentUrl.hostname)) return open;
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    return {
      _tag: "Unreachable",
      reason: `${address} is on ${target.label}, which this device reaches at the public address ${environmentUrl.host}. ${insteadHint}`,
    };
  }
  parsed.hostname = environmentUrl.hostname;
  return { _tag: "Open", url: parsed.toString() };
}
