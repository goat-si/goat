import { hubProxyNodePath, HUB_PROXY_ROUTE_PREFIX } from "@goat/contracts";
import { PEN_ROUTE_PATH } from "@goat/shared/penRouteUrl";

export * from "@goat/shared/advertisedEndpoint";

const HUB_NODE_ROUTE = new RegExp(`^.*?${HUB_PROXY_ROUTE_PREFIX}/[^/]+`);

/**
 * Hub node routes retain their deployment prefix; other saved paths are pairing residue and
 * keep using the origin root.
 */
export const environmentRoutePrefix = (url: URL): string =>
  url.pathname.match(PEN_ROUTE_PATH)?.[0] ?? url.pathname.match(HUB_NODE_ROUTE)?.[0] ?? "";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${environmentRoutePrefix(url)}/${pathname.replace(/^\/+/, "")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const hubProxyEndpointUrl = (httpBaseUrl: string, nodeId: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${hubProxyNodePath(nodeId)}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
};
