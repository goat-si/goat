import { isLocalLoopbackHost, normalizeHostname } from "@goat/shared/hostClassification";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const TailscaleServeConfigJson = Schema.Struct({
  TCP: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ TCPForward: Schema.optional(Schema.String) })),
  ),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ Proxy: Schema.optional(Schema.String) })),
        ),
      }),
    ),
  ),
});
// A node without any Serve configuration prints `null`.
const decodeTailscaleServeStatusJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(TailscaleServeConfigJson)),
);

/**
 * Whether a proxy to `hostname` dials `bindHost`. `0.0.0.0` reaches 127.0.0.1. `[::]` may reach
 * either loopback, since Go dials `::` and then 0.0.0.0 (golang/go#18806), and a name such as
 * `localhost` may resolve to whatever the server binds.
 */
const reaches = (hostname: string, bindHost: string): boolean => {
  let address = normalizeHostname(hostname);
  // Compare IPv6 by value: 0:0:0:0:0:ffff:7f00:1 is ::ffff:7f00:1.
  if (address.includes(":") && URL.canParse(`http://[${address}]`)) {
    address = normalizeHostname(new URL(`http://[${address}]`).hostname);
  }
  // An IPv4-mapped address can be written as hex, such as ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(address);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    address = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  } else if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  // Strict, as Go's ParseIP is; anything else, such as `127.1` or `box.1`, goes to the resolver.
  const literal =
    address.includes(":") ||
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?!$)|$)){4}$/u.test(address);
  if (!literal) return true;
  if (address === "::") return bindHost === "127.0.0.1" || bindHost === "::1";
  return (address === "0.0.0.0" ? "127.0.0.1" : address) === bindHost;
};

/** The URL Tailscale's proxy dials for a handler's `Proxy`, expanded as its `expandProxyArg` does. */
const expandProxy = (proxy: string) =>
  /^\d+$/u.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : proxy.startsWith("https+insecure://")
      ? `https://${proxy.slice("https+insecure://".length)}`
      : /^(?:https?:\/\/|unix:)/u.test(proxy)
        ? proxy
        : `http://${proxy}`;

/**
 * The host and port a proxy target dials, read as Go's url.Parse reads it rather than as a WHATWG
 * URL, which rejects `box.1` and rewrites `127.1`; none for a Unix socket.
 */
const dialedHostPort = (url: string) => {
  const match = /^(https?|tcp):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?/iu.exec(url);
  if (match === null) return undefined;
  const [, scheme = "", host = "", port] = match;
  return { host, port: port || (scheme.toLowerCase() === "https" ? "443" : "80") };
};

/** A handler at the root of a Serve port: this server's, or another with the loopback port it dials. */
export type TailscaleServeRootHolder =
  | { readonly ours: true }
  | { readonly ours: false; readonly loopback?: { readonly host: string; readonly port: number } };

/**
 * What answers at the root of `servePort` outside any Tailscale Service, where
 * `ensureTailscaleServe` publishes, or undefined when the status cannot be read.
 */
export const parseTailscaleServeRootHolders = (
  rawServeStatusJson: string,
  servePort: number,
  target: { readonly host: string; readonly port: number },
): ReadonlyArray<TailscaleServeRootHolder> | undefined => {
  const status = decodeTailscaleServeStatusJson(rawServeStatusJson);
  if (Option.isNone(status)) return undefined;
  const config = status.value ?? undefined;
  const tcp: ReadonlyArray<TailscaleServeRootHolder> =
    config?.TCP?.[String(servePort)]?.TCPForward === undefined ? [] : [{ ours: false }];
  const web = Object.entries(config?.Web ?? {}).flatMap(
    ([hostPort, site]): ReadonlyArray<TailscaleServeRootHolder> => {
      const root = site.Handlers?.["/"];
      if (Number(hostPort.slice(hostPort.lastIndexOf(":") + 1)) !== servePort || root === undefined)
        return [];
      if (root.Proxy === undefined) return [{ ours: false }];
      const dialed = dialedHostPort(expandProxy(root.Proxy));
      // Go reads the port as a decimal number, so 03773 is 3773.
      if (dialed === undefined) return [{ ours: false }];
      if (Number(dialed.port) === target.port && reaches(dialed.host, target.host))
        return [{ ours: true }];
      return [
        isLocalLoopbackHost(dialed.host)
          ? {
              ours: false,
              loopback: { host: normalizeHostname(dialed.host), port: Number(dialed.port) },
            }
          : { ours: false },
      ];
    },
  );
  return [...tcp, ...web];
};
