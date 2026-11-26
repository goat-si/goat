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
  messages?: {
    readonly connect: string;
    readonly linkEnvironment: string;
    readonly comingSoon: (name: string) => string;
    readonly local: (hint: string) => string;
    readonly reachable: (hint: string) => string;
  },
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  const publicUrlHint = isGoatConnectEnabled()
    ? (messages?.connect ?? "Link GOAT Connect for a public URL.")
    : (messages?.comingSoon(GOAT_CONNECT_COMING_SOON.title) ??
      `Public URLs arrive with ${GOAT_CONNECT_COMING_SOON.title} (${GOAT_CONNECT_COMING_SOON.status.toLowerCase()}).`);
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: isGoatConnectEnabled()
        ? (messages?.linkEnvironment ?? "Link this environment to GOAT Connect for a public URL.")
        : publicUrlHint,
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? (messages?.local(publicUrlHint) ??
        `Only this computer can call this address. ${publicUrlHint}`)
      : (messages?.reachable(publicUrlHint) ??
        `Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. ${publicUrlHint}`),
  };
}
