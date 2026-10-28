import { makeManagedRelayTestClient } from "../relay/managedRelayTestClient.ts";
import { AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import { type RelayEnvironmentConnectResponse } from "@goat/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";
export const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
export const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
export const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux" as const,
    arch: "x64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
export const BOOTSTRAP: RelayEnvironmentConnectResponse = {
  environmentId: ENVIRONMENT_ID,
  endpoint: ENDPOINT,
  credential: "relay-bootstrap",
  expiresAt: "2026-06-06T01:00:00.000Z",
};

type RecordedResponse = Response | ((init: RequestInit) => Response);

function recordedFetch(responses: ReadonlyArray<RecordedResponse>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(typeof response === "function" ? response(init ?? {}) : response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

export const websocketTicket = (ticket: string) =>
  Response.json({
    ticket,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });

export const accessToken = (token: string, scope = AuthStandardClientScopes.join(" ")) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 3_600,
    scope,
  });

export const authInvalid = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-auth-invalid",
    },
    { status: 401 },
  );

export const persistedToken = (
  input: {
    readonly environmentId?: EnvironmentId;
    readonly accessToken?: string;
    readonly expiresAtEpochMs?: number;
    readonly dpopThumbprint?: string;
  } = {},
) =>
  new TokenStore.RemoteDpopAccessToken({
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    accountId: "account-1",
    label: DESCRIPTOR.label,
    endpoint: ENDPOINT,
    accessToken: input.accessToken ?? "cached-access-token",
    expiresAtEpochMs: input.expiresAtEpochMs ?? Number.MAX_SAFE_INTEGER,
    dpopThumbprint: input.dpopThumbprint ?? "thumbprint-1",
  });

export const makeHarness = Effect.fn("TestRemoteAuthorization.makeHarness")(function* (input: {
  readonly initialToken?: TokenStore.RemoteDpopAccessToken;
  readonly responses: ReadonlyArray<RecordedResponse>;
  readonly bootstrap?: RelayEnvironmentConnectResponse;
  readonly beforeBootstrap?: Effect.Effect<void, ManagedRelay.ManagedRelayClientError>;
  readonly beforePut?: Effect.Effect<void>;
  readonly clerkToken?: ClientCapabilities.CloudSession["Service"]["clerkToken"];
}) {
  const tokens = yield* Ref.make(
    new Map(
      input.initialToken === undefined
        ? []
        : [[input.initialToken.environmentId, input.initialToken]],
    ),
  );
  const bootstrapCalls = yield* Ref.make(0);
  const relayInputs = yield* Ref.make<
    ReadonlyArray<Parameters<ManagedRelay.ManagedRelayClient["Service"]["connectEnvironment"]>[0]>
  >([]);
  const session = yield* Ref.make<Option.Option<ClientCapabilities.CloudSessionIdentity>>(
    Option.some({ accountId: "account-1" }),
  );
  const thumbprint = yield* Ref.make("thumbprint-1");
  const tokenReads = yield* Queue.unbounded<EnvironmentId>();
  const proofInputs = yield* Ref.make<
    ReadonlyArray<{
      readonly method: string;
      readonly url: string;
      readonly accessToken?: string;
    }>
  >([]);
  const fetch = recordedFetch(input.responses);

  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) =>
      Ref.get(tokens).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(environmentId))),
        Effect.tap(() => Queue.offer(tokenReads, environmentId)),
      ),
    put: (token) =>
      (input.beforePut ?? Effect.void).pipe(
        Effect.andThen(
          Ref.update(tokens, (current) => {
            const next = new Map(current);
            next.set(token.environmentId, token);
            return next;
          }),
        ),
      ),
    remove: (environmentId) =>
      Ref.update(tokens, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Ref.get(thumbprint),
    createProof: (proofInput) =>
      Ref.update(proofInputs, (current) => [...current, proofInput]).pipe(
        Effect.as(`proof:${proofInput.url}`),
      ),
  });
  const unexpected = () => Effect.die("Unexpected relay request");
  const relay = makeManagedRelayTestClient({
    relayUrl: "https://relay.example.test",
    listEnvironments: unexpected,
    listDevices: unexpected,
    createEnvironmentLinkChallenge: unexpected,
    linkEnvironment: unexpected,
    unlinkEnvironment: unexpected,
    getEnvironmentStatus: unexpected,
    connectEnvironment: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(bootstrapCalls, (count) => count + 1);
        yield* Ref.update(relayInputs, (current) => [...current, request]);
        yield* input.beforeBootstrap ?? Effect.void;
        return input.bootstrap ?? BOOTSTRAP;
      }),
    registerDevice: unexpected,
    unregisterDevice: unexpected,
    registerLiveActivity: unexpected,
    getAgentActivitySnapshot: unexpected,
  });
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(fetch.fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Ref.get(session),
          clerkToken: input.clerkToken ?? Effect.succeed("clerk-session"),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeedSome("device-1"),
        }),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: {
              label: "GOAT Test",
              deviceType: "mobile",
              os: "test",
            },
          }),
        ),
      ),
    ),
  );
  return {
    layer,
    tokens,
    bootstrapCalls,
    proofInputs,
    fetch,
    relayInputs,
    session,
    thumbprint,
    tokenReads,
  };
});
