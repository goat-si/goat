import type { ScheduledTaskWebhookEndpoint } from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON, isGoatConnectEnabled } from "@goat/shared/goatConnect";
import { isLocalLoopbackHost } from "@goat/shared/hostClassification";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  const publicUrlHint = isGoatConnectEnabled()
    ? "Link GOAT Connect for a public URL."
    : `Public URLs arrive with ${GOAT_CONNECT_COMING_SOON.title} (${GOAT_CONNECT_COMING_SOON.status.toLowerCase()}).`;
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: isGoatConnectEnabled()
        ? "Link this environment to GOAT Connect for a public URL."
        : publicUrlHint,
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? `Only this computer can call this address. ${publicUrlHint}`
      : `Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. ${publicUrlHint}`,
  };
}
