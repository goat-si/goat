import { HUB_PROXY_ROUTE_PREFIX } from "@goat/contracts";

export * from "@goat/shared/advertisedEndpoint";

const HUB_NODE_ROUTE = new RegExp(`^${HUB_PROXY_ROUTE_PREFIX}/[^/]+`);

/**
 * Only a hub-proxy node is addressed below its server's origin. Any other path on a saved base URL
 * is pairing residue the server never answers under, so requests keep going to the origin root.
 */
export const environmentRoutePrefix = (url: URL): string =>
  url.pathname.match(HUB_NODE_ROUTE)?.[0] ?? "";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${environmentRoutePrefix(url)}/${pathname.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
