import { EnvironmentId } from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as Authorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";
import * as Capabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

const environmentId = EnvironmentId.make("environment-1");
const endpoint = {
  httpBaseUrl: "https://desk.tail1234.ts.net/",
  wsBaseUrl: "wss://desk.tail1234.ts.net/",
  providerKind: "cloudflare_tunnel" as const,
};

describe("RemoteEnvironmentAuthorization with Connect disabled", () => {
  it.effect.each([false, true])(
    "blocks DPoP before descriptor, identity, signer or token reads (cached: %s)",
    (cached) =>
      Effect.gen(function* () {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const read = vi.fn();
        const unexpected = () =>
          Effect.sync(read).pipe(Effect.andThen(Effect.die("Unexpected authorization work")));
        const token = new TokenStore.RemoteDpopAccessToken({
          environmentId,
          accountId: "saved-account",
          label: "Desk",
          endpoint,
          accessToken: "saved-access-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          dpopThumbprint: "saved-thumbprint",
        });
        const remote = yield* Authorization.make.pipe(
          Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
            thumbprint: Effect.sync(read).pipe(Effect.as("saved-thumbprint")),
            createProof: unexpected,
          }),
          Effect.provideService(ManagedRelay.ManagedRelayClient, {
            relayUrl: "https://relay.example.test",
            listEnvironments: unexpected,
            listDevices: unexpected,
            createEnvironmentLinkChallenge: unexpected,
            linkEnvironment: unexpected,
            unlinkEnvironment: unexpected,
            getEnvironmentStatus: unexpected,
            connectEnvironment: unexpected,
            registerDevice: unexpected,
            unregisterDevice: unexpected,
            registerLiveActivity: unexpected,
            getAgentActivitySnapshot: unexpected,
            resetTokenCache: unexpected(),
          }),
          Effect.provideService(Capabilities.CloudSession, {
            identity: Effect.sync(read).pipe(
              Effect.as(Option.some({ accountId: "saved-account" })),
            ),
            clerkToken: Effect.sync(read).pipe(Effect.as("saved-clerk-token")),
          }),
          Effect.provideService(Capabilities.RelayDeviceIdentity, { deviceId: unexpected() }),
          Effect.provideService(Capabilities.ClientPresentation, {
            metadata: { label: "Test", deviceType: "mobile", os: "test" },
          }),
          Effect.provideService(TokenStore.RemoteDpopAccessTokenStore, {
            get: () =>
              Effect.sync(read).pipe(Effect.as(cached ? Option.some(token) : Option.none())),
            put: unexpected,
            remove: unexpected,
          }),
          Effect.provide(RpcHttp.layerRemoteHttpClient(fetch)),
        );
        const failures = yield* Effect.all([
          remote.authorizeDpop({ expectedEnvironmentId: environmentId }).pipe(Effect.flip),
          remote
            .authorizeDpop({ expectedEnvironmentId: environmentId, directEndpoint: endpoint })
            .pipe(Effect.flip),
          remote.authorizeDpopHttp({ expectedEnvironmentId: environmentId }).pipe(Effect.flip),
          remote
            .authorizeDpopHttp({
              expectedEnvironmentId: environmentId,
              rejectedAccessToken: token.accessToken,
            })
            .pipe(Effect.flip),
        ]);
        for (const failure of failures) {
          expect(failure).toMatchObject({
            _tag: "ConnectionBlockedError",
            reason: "configuration",
            detail: `${GOAT_CONNECT_COMING_SOON.title} is coming soon. ${GOAT_CONNECT_COMING_SOON.description}`,
          });
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      }).pipe(Effect.scoped),
  );

  it.effect("keeps paired Tailscale bearer authorization working", () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          Response.json({
            environmentId,
            label: "Desk",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ticket: "paired-ticket", expiresAt: "2026-10-19T01:00:00.000Z" }),
        );
      const unused = () => Effect.die("Unexpected Connect dependency");
      const remote = yield* Authorization.make.pipe(
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: unused(),
          createProof: unused,
        }),
        Effect.provideService(ManagedRelay.ManagedRelayClient, {
          relayUrl: "https://relay.example.test",
          listEnvironments: unused,
          listDevices: unused,
          createEnvironmentLinkChallenge: unused,
          linkEnvironment: unused,
          unlinkEnvironment: unused,
          getEnvironmentStatus: unused,
          connectEnvironment: unused,
          registerDevice: unused,
          unregisterDevice: unused,
          registerLiveActivity: unused,
          getAgentActivitySnapshot: unused,
          resetTokenCache: unused(),
        }),
        Effect.provideService(Capabilities.CloudSession, {
          identity: unused(),
          clerkToken: unused(),
        }),
        Effect.provideService(Capabilities.RelayDeviceIdentity, { deviceId: unused() }),
        Effect.provideService(Capabilities.ClientPresentation, {
          metadata: { label: "Test", deviceType: "mobile", os: "test" },
        }),
        Effect.provideService(TokenStore.RemoteDpopAccessTokenStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Effect.provide(RpcHttp.layerRemoteHttpClient(fetch)),
      );
      const result = yield* remote.authorizeBearer({
        expectedEnvironmentId: environmentId,
        ...endpoint,
        bearerToken: "paired-token",
        connectionMethod: "direct",
      });
      expect(result.httpAuthorization).toEqual({ _tag: "Bearer", token: "paired-token" });
      expect(result.socketUrl).toContain("wsTicket=paired-ticket");
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        `${endpoint.httpBaseUrl}.well-known/goat/environment`,
        `${endpoint.httpBaseUrl}api/auth/websocket-ticket/rpc`,
      ]);
    }).pipe(Effect.scoped),
  );
});
