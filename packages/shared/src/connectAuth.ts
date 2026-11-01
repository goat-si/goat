import { RelayEnvironmentLinkProofPayload } from "@goat/contracts/relay";
import { decodeRelayJwt } from "./relayJwt.ts";
import { CliLinkApprovalRequest } from "@goat/contracts/connectAssurance";
import * as Schema from "effect/Schema";
import { readHashParams } from "./remote.ts";

const CONNECT_AUTH_STATE_PARAM = "state";
const CONNECT_AUTH_CHALLENGE_PARAM = "challenge";
const CONNECT_AUTH_PORT_PARAM = "port";
const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";

const CONNECT_AUTHORIZE_PATH = "/connect";

const decodeApprovalRequest = Schema.decodeUnknownSync(CliLinkApprovalRequest);

const decodeLinkProof = Schema.decodeUnknownSync(RelayEnvironmentLinkProofPayload);

export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
  readonly approval?: CliLinkApprovalRequest;
}

/** Route through /connect because Clerk's signed-out redirect can lose OAuth query parameters. */
export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
  readonly approval?: CliLinkApprovalRequest;
}): string {
  const url = new URL(CONNECT_AUTHORIZE_PATH, input.hostedAppUrl);
  const params = new URLSearchParams({
    state: input.state,
    challenge: input.challenge,
    port: String(input.loopbackPort),
  });
  if (input.approval) params.set("approval", JSON.stringify(input.approval));
  url.hash = params.toString();
  return url.toString();
}

export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequest | null {
  const params = readHashParams(url);
  const state = params.get(CONNECT_AUTH_STATE_PARAM)?.trim() ?? "";
  const challenge = params.get(CONNECT_AUTH_CHALLENGE_PARAM)?.trim() ?? "";
  const loopbackPort = parseLoopbackPort(params.get(CONNECT_AUTH_PORT_PARAM)?.trim() ?? "");
  if (!state || !challenge || loopbackPort === null) {
    return null;
  }
  const rawApproval = params.get("approval");
  if (!rawApproval) return { state, challenge, loopbackPort };
  if (rawApproval.length > 8192) return null;
  try {
    const approval = decodeApprovalRequest(JSON.parse(rawApproval));
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
      !/^[A-Za-z0-9_-]{22,128}$/.test(state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(approval.approvalChallenge) ||
      approval.state !== state
    )
      return null;
    return { state, challenge, loopbackPort, approval };
  } catch {
    return null;
  }
}

function parseLoopbackPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Must match the loopback redirect URI registered on the Clerk CLI OAuth app. */
export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
}

export function buildConnectClerkAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function connectLinkIntentFromProof(proof: string, managedTunnelsEnabled: boolean) {
  const payload = decodeLinkProof(decodeRelayJwt(proof));
  if (payload.descriptor.connectAuthPolicyVersion !== 1)
    throw new Error("Update this GOAT host before linking Connect.");
  return {
    connectAuthPolicyVersion: 1 as const,
    environmentId: payload.environmentId,
    environmentPublicKey: payload.environmentPublicKey,
    origin: payload.origin,
    notificationsEnabled: false as const,
    liveActivitiesEnabled: false as const,
    managedTunnelsEnabled,
  };
}

export function normalizeConnectHostedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      (!loopback && url.port)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
