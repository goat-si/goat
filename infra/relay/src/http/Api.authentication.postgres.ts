// @effect-diagnostics-next-line nodeBuiltinImport:off -- HTTP DPoP requests use a real P-256 client key.
import * as NodeCrypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { RelayApi } from "@goat/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as RelayDb from "../db.ts";
import * as Config from "../Config.ts";
import * as Api from "./Api.ts";
import * as ClientKeys from "../auth/ClientKeys.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Authentication from "../auth/ConnectAuthentication.ts";
import * as Exchange from "../auth/ConnectTokenExchange.ts";
import * as Approvals from "../auth/CliLinkApprovals.ts";
import { postgresFixture } from "../auth/connectPostgres.testkit.ts";
import * as Linker from "../environments/EnvironmentLinker.ts";
import * as Reservations from "../environments/ConnectLinkReservations.ts";
import * as Credentials from "../environments/EnvironmentCredentials.ts";
import * as Links from "../environments/EnvironmentLinks.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";
import * as Connector from "../environments/EnvironmentConnector.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as Publisher from "../agentActivity/AgentActivityPublisher.ts";
import * as Signatures from "../environments/EnvironmentPublishSignatures.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import {
  config,
  environmentKeyPair,
  makeRequest,
  signTestJwt,
} from "../environments/EnvironmentLinker.testkit.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));

it.effect(
  "real HTTP middleware restricts stale CLI OAuth to owned withdrawal and denies link/admission/recovery",
  () =>
    Effect.gen(function* () {
      let userId = "user_123";
      let clientId = "cli-client";
      let provisioned = 0;
      let scopes = ["openid", "profile", "email", "offline_access"];
      vi.mocked(verifyToken).mockReset();
      vi.mocked(createClerkClient).mockReset();
      vi.mocked(verifyToken).mockRejectedValue(new Error("OAuth identity has no session factors"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: async () => ({
          isAuthenticated: true,
          toAuth: () => ({
            tokenType: "oauth_token",
            userId,
            clientId,
            scopes,
          }),
        }),
      } as never);
      const provider = Layer.mock(Provider.ManagedEndpointProvider, {
        prepareDeprovision: () => Effect.succeed(null),
        deprovision: () => Effect.succeed(true),
        provision: () =>
          Effect.sync(() => {
            provisioned++;
            throw new Error("Denied request reached provisioning");
          }),
      });
      const clock = yield* Clock.Clock;
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const services = Layer.mergeAll(Linker.layer, Exchange.layer).pipe(
        Layer.provideMerge(Authentication.layer),
        Layer.provideMerge(Reservations.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Links.layer,
            Credentials.layer,
            RelayTokens.layer,
            ClientKeys.layer,
            Approvals.layer,
            Devices.layer,
          ),
        ),
        Layer.provideMerge(DpopProofs.layer),
        Layer.provideMerge(postgresFixture),
        Layer.provideMerge(
          Config.layer({
            ...config,
            clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
            clerkJwtAudience: config.relayIssuer,
            clerkAuthorizedParties: ["https://app.example.test"],
            clerkCliOAuthClientId: "cli-client",
          }),
        ),
        Layer.provideMerge(provider),
        Layer.provideMerge(NodeCryptoLayer.layer),
        Layer.provideMerge(Layer.succeed(Clock.Clock, clock)),
        Layer.provideMerge(Layer.mock(Publisher.AgentActivityPublisher, {})),
        Layer.provideMerge(Layer.mock(Connector.EnvironmentConnector, {})),
        Layer.provideMerge(Layer.mock(MobileRegistrations.MobileRegistrations, {})),
        Layer.provideMerge(Layer.mock(Signatures.EnvironmentPublishSignatures, {})),
        Layer.provideMerge(Layer.mock(HeldHooks.HeldHooks, {})),
      );
      const context = yield* Layer.build(services);
      const dependencies = Layer.succeedContext(context);
      const handlers = Layer.mergeAll(
        Api.layerClientApi,
        Api.layerServerApi,
        Api.layerTokenApi,
        Api.layerDpopClientApi,
        Api.layerMobileApi,
      ).pipe(
        HttpRouter.provideRequest(dependencies),
        Layer.provideMerge(dependencies),
        Layer.provideMerge(
          Layer.mergeAll(
            Api.layerClientAuth,
            Api.layerEnvironmentAuth,
            Api.layerDpopClientAuth,
          ).pipe(Layer.provide(dependencies)),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(
              HttpApi.make("ConnectAuthBoundary")
                .add(RelayApi.groups.client)
                .add(RelayApi.groups.server)
                .add(RelayApi.groups.token)
                .add(RelayApi.groups.dpopClient)
                .add(RelayApi.groups.mobile),
            ).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const db = Context.get(context, RelayDb.RelayDb);
      const { payload } = yield* makeRequest.pipe(Effect.provide(context));
      const proof = { ...payload, environmentId: payload.environmentId };
      yield* Context.get(context, Links.EnvironmentLinks).upsert({
        userId,
        request: {
          proof: signTestJwt(proof, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: false,
        },
        proof,
        endpoint: proof.endpoint,
      });
      const credential = yield* Context.get(context, Credentials.EnvironmentCredentials).create({
        environmentId: proof.environmentId,
        environmentPublicKey: proof.environmentPublicKey,
      });
      const clientKey = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = clientKey.publicKey.export({ format: "jwk" });
      let nonce = 0;
      const request = (path: string, body?: unknown, token = "oauth", method = "POST") => {
        const url = `${config.relayIssuer}${path}`;
        const origin = new URL(url);
        const header = Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk })).toString(
          "base64url",
        );
        const claims = Buffer.from(
          JSON.stringify({ htm: method, htu: url, iat: now, jti: `proof-${++nonce}` }),
        ).toString("base64url");
        const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
          key: clientKey.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return Effect.promise(() =>
          app.handler(
            new Request(url, {
              method,
              headers: {
                // Effect reconstructs the public URL from these proxy headers.
                host: origin.host,
                "x-forwarded-proto": origin.protocol.slice(0, -1),
                authorization: `Bearer ${token}`,
                dpop: `${header}.${claims}.${signature}`,
                "content-type":
                  body instanceof URLSearchParams
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
              },
              ...(body === undefined
                ? {}
                : {
                    body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
                  }),
            }),
          ),
        );
      };
      clientId = "wrong-client";
      expect(
        (yield* request(
          `/v1/client/environment-links/${proof.environmentId}`,
          undefined,
          "oauth",
          "DELETE",
        )).status,
      ).toBe(401);
      clientId = "cli-client";
      scopes = ["openid"];
      expect(
        (yield* request(
          `/v1/client/environment-links/${proof.environmentId}`,
          undefined,
          "oauth",
          "DELETE",
        )).status,
      ).toBe(401);
      scopes = ["openid", "profile", "email", "offline_access"];
      userId = "other-account";
      expect(
        (yield* request(
          `/v1/client/environment-links/${proof.environmentId}`,
          undefined,
          "oauth",
          "DELETE",
        )).status,
      ).toBe(200);
      expect(
        (yield* db.$client`SELECT * FROM relay_environment_links WHERE revoked_at IS NULL`).length,
      ).toBe(1);
      userId = "user_123";
      expect(
        (yield* request("/v1/client/environment-link-challenges", {
          connectAuthPolicyVersion: 1,
          environmentId: proof.environmentId,
          environmentPublicKey: proof.environmentPublicKey,
          origin: proof.origin,
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: true,
        })).status,
      ).toBe(403);
      expect(
        (yield* request(
          "/v1/client/dpop-token",
          new URLSearchParams({
            connectAuthPolicyVersion: "1",
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: "oauth",
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            resource: config.relayIssuer,
            scope: "environment:connect",
            client_id: "goat-web",
          }),
        )).status,
      ).toBe(401);
      for (const path of ["/tunnel", "/tunnel/recovery"]) {
        expect(
          (yield* request(
            `/v1/environments/${proof.environmentId}${path}`,
            {
              cloudUserId: userId,
              tunnelId: "retained-tunnel",
              origin: proof.origin,
              proof: "retained-recovery-proof",
            },
            credential,
          )).status,
        ).toBe(403);
      }
      expect(
        (yield* request("/v1/client/environment-links", {
          proof: signTestJwt(proof, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
          notificationsEnabled: false,
          liveActivitiesEnabled: false,
          managedTunnelsEnabled: false,
        })).status,
      ).toBe(403);
      expect(
        (yield* request(`/v1/environments/${proof.environmentId}/connect`, {
          clientProofKeyThumbprint: "key",
        })).status,
      ).toBe(401);
      expect(provisioned).toBe(0);
      expect((yield* db.$client`SELECT * FROM relay_client_keys`).length).toBe(0);
      expect(
        (yield* request(
          `/v1/client/environment-links/${proof.environmentId}`,
          undefined,
          "oauth",
          "DELETE",
        )).status,
      ).toBe(200);
      expect(
        (yield* db.$client`SELECT * FROM relay_environment_links WHERE revoked_at IS NULL`).length,
      ).toBe(0);
    }).pipe(Effect.scoped),
);
