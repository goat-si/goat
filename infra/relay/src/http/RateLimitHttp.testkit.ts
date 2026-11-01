// @effect-diagnostics nodeBuiltinImport:off -- HTTP fixtures generate and sign synthetic client/host keys.
import * as NodeCrypto from "node:crypto";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@goat/shared/dpop";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { RelayRateLimits } from "../accounts/RelayRateLimits.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as RelayDb from "../db.ts";
import { postgresPolicyLayer, testConfig } from "../accounts/test/PolicyPostgresLayers.ts";
import type { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as ClientKeys from "../auth/ClientKeys.ts";
import * as CliLinkApprovals from "../auth/CliLinkApprovals.ts";
import * as ConnectAccounts from "../auth/ConnectAccounts.ts";
import * as ConnectAuthentication from "../auth/ConnectAuthentication.ts";
import * as ConnectTokenExchange from "../auth/ConnectTokenExchange.ts";
import * as ConnectLinkReservations from "../environments/ConnectLinkReservations.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedProvisioningIntents from "../environments/ManagedProvisioningIntents.ts";
import {
  makeTunnelClient,
  makeDnsClient,
  type TunnelCall,
} from "../environments/ManagedEndpointProvider.testkit.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as FcmDeliveries from "../agentActivity/FcmDeliveries.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";

export const issuer = "https://relay.example.test";

export function signingKey() {
  return NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
}

export function signJwt(payload: object, typ: string, privateKey: string) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${header}.${encoded}`;
  return `${input}.${NodeCrypto.sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

export function dpopKey() {
  const key = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = key.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  return {
    thumbprint: computeDpopJwkThumbprint(jwk),
    proof: (path: string, issuedAt: number, accessToken?: string) => {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          htm: "POST",
          htu: new URL(path, issuer).href,
          jti: NodeCrypto.randomUUID(),
          iat: issuedAt,
          ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
        }),
      ).toString("base64url");
      const input = `${header}.${payload}`;
      const signature = NodeCrypto.sign("sha256", Buffer.from(input), {
        key: key.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${input}.${signature}`;
    },
  };
}

export function httpServices(
  pg: ReturnType<typeof createPostgresFixture>,
  rates: RelayRateLimits["Service"],
  relayKey: ReturnType<typeof signingKey>,
) {
  const tunnelCalls: TunnelCall[] = [];
  const mintRequests: string[] = [];
  const deliveries: string[] = [];
  const recordDelivery = (kind: string) =>
    Effect.sync(() => {
      deliveries.push(kind);
      return null;
    });
  const policy = postgresPolicyLayer(pg, {
    limits: { tunnels: 2 },
    config: {
      ...testConfig,
      clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
      clerkJwtAudience: issuer,
      clerkAuthorizedParties: ["https://app.example.test"],
      cloudMintPrivateKey: Redacted.make(relayKey.privateKey),
      cloudMintPublicKey: relayKey.publicKey,
    },
  });
  const boundaries = Layer.mergeAll(
    Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
    Layer.succeed(RelayRateLimits, rates),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          mintRequests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
        }),
      ),
    ),
    Layer.mock(ApnsDeliveries.ApnsDeliveries, {
      sendForTarget: () => recordDelivery("apns-activity"),
      sendPushNotificationForTarget: () => recordDelivery("apns-notification"),
    }),
    Layer.mock(FcmDeliveries.FcmDeliveries, { enqueue: () => recordDelivery("fcm") }),
    Layer.mock(HeldHooks.HeldHooks, {}),
    ManagedEndpointProvider.layerTunnelClient(makeTunnelClient(tunnelCalls)),
    ManagedEndpointProvider.layerDnsClient(makeDnsClient()),
    NodeServices.layer,
  );
  const services = Layer.empty.pipe(
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(ConnectTokenExchange.layer.pipe(Layer.provide(ConnectAuthentication.layer))),
    Layer.provideMerge(
      Layer.mergeAll(ClientKeys.layer, CliLinkApprovals.layer, ConnectLinkReservations.layer),
    ),
    Layer.provideMerge(ConnectAccounts.layer),
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentPublishSignatures.layer),
    Layer.provideMerge(RelayTokens.layer),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(AgentActivityRows.layer),
    Layer.provideMerge(ManagedEndpointProvider.layer),
    Layer.provideMerge(ManagedProvisioningIntents.layer),
    Layer.provideMerge(RelayDb.RelayTransactions.layer),
    Layer.provideMerge(boundaries),
    Layer.provideMerge(policy),
  );
  return { services, tunnelCalls, mintRequests, deliveries };
}
