import {
  buildConnectClerkAuthorizeUrl,
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  type ConnectAuthorizeRequest,
} from "@goat/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@goat/shared/relayAuth";

import { isHostedStaticApp } from "../hostedPairing";
import { hasCloudPublicConfig, resolveCloudPublicConfig, trimNonEmpty } from "./publicConfig";

function resolveConnectCliOAuthClientId(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined);
}

function hasConnectCliAuthConfig(): boolean {
  return Boolean(
    resolveCloudPublicConfig().clerkPublishableKey && resolveConnectCliOAuthClientId(),
  );
}

export function connectCliAuthRoutesEnabled(): boolean {
  return isHostedStaticApp() && hasCloudPublicConfig() && hasConnectCliAuthConfig();
}

export function buildConnectCliClerkAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const { clerkPublishableKey } = resolveCloudPublicConfig();
  const clientId = resolveConnectCliOAuthClientId();
  if (!clerkPublishableKey || !clientId) {
    return null;
  }
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey)}/oauth/authorize`,
    clientId,
    redirectUri: connectLoopbackRedirectUri(request.loopbackPort),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

/** Force a new document: fragment revisits do not reload, and Clerk suppresses post-sign-in session updates. */
export function connectCliSignInRedirectUrl(
  _request: ConnectAuthorizeRequest,
  currentHref: string,
): string {
  const url = new URL(currentHref);
  url.searchParams.set(
    "connect-sign-in",
    url.searchParams.get("connect-sign-in") === "1" ? "2" : "1",
  );
  return url.toString();
}

export function navigateConnectCliToOAuth(request: ConnectAuthorizeRequest): void {
  const url = buildConnectCliClerkAuthorizeUrl(request);
  if (!url) throw new Error("CLI authorization is not configured.");
  window.location.assign(url);
}
