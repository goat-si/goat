import { RelayRateLimitExceededError } from "@goat/contracts/relayErrors";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real HTTP recovery fixture signs its own synthetic host key.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as RelayHttpApi from "./Api.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import { RELAY_MANAGED_TUNNEL_RECOVERY_TYP, signRelayJwt } from "@goat/shared/relayJwt";
import {
  layerPostgresProvider,
  makeTunnelClient,
  makeDnsClient,
  type TunnelCall,
} from "../environments/ManagedEndpointProvider.testkit.ts";
import { EndpointIdentity } from "../environments/EndpointIdentity.ts";
import { EnvironmentOwnership } from "../environments/EnvironmentOwnership.ts";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import {
  RelayApi,
  RelayUnregisterDeviceEndpoint,
  RelayAgentActivitySnapshotEndpoint,
  RelayDpopClientAuth,
  RelayMobileClientId,
  RelayProtectedError,
} from "@goat/contracts/relay";
import { ACCOUNT_ENDPOINT_POLICY } from "./AccountPolicy.ts";
import { layerDpopClientAuth } from "./Api.ts";
import { RelayTokens } from "../auth/RelayTokens.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";

it("classifies every authenticated endpoint by its typed endpoint name", () => {
  for (const group of [
    RelayApi.groups.client,
    RelayApi.groups.dpopClient,
    RelayApi.groups.mobile,
    RelayApi.groups.server,
    RelayApi.groups.token,
  ])
    for (const endpoint of Object.values(group.endpoints))
      expect(Object.hasOwn(ACCOUNT_ENDPOINT_POLICY, endpoint.identifier), endpoint.identifier).toBe(
        true,
      );
});
it.effect(
  "encodes policy errors through real DPoP middleware with matching Retry-After and no-store",
  () =>
    Effect.gen(function* () {
      const api = HttpApi.make("PolicyFixture").add(
        HttpApiGroup.make("policy")
          .add(RelayAgentActivitySnapshotEndpoint)
          .middleware(RelayDpopClientAuth),
      );
      const handlers = HttpApiBuilder.group(api, "policy", (h) =>
        h.handle("getAgentActivitySnapshot", () =>
          Effect.fail(
            new RelayRateLimitExceededError({
              code: "rate_limit_exceeded",
              operation: "connect",
              retryAfterSeconds: 42,
              traceId: "fixture",
            }),
          ),
        ),
      );
      const auth = layerDpopClientAuth.pipe(
        Layer.provide(policyUnitLayer),
        Layer.provide(
          Layer.mock(RelayTokens, {
            resolveDpopAccessTokenScopes: () => null,
            verifyDpopAccessToken: () =>
              Effect.succeed({
                iss: "https://relay.example.test",
                aud: "https://relay.example.test",
                sub: "fixture",
                account_epoch: 1,
                jti: "fixture-token",
                iat: 0,
                exp: 100,
                client_id: RelayMobileClientId,
                scope: [],
                cnf: { jkt: "fixture-key" },
              }),
          }),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(handlers),
              Layer.provide(auth),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/mobile/agent-activity", {
            headers: { authorization: "DPoP fixture-token" },
          }),
        ),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("42");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = yield* Effect.promise(() => response.json());
      expect((yield* Schema.decodeUnknownEffect(RelayProtectedError)(body))._tag).toBe(
        "RelayRateLimitExceededError",
      );
    }),
);

it.live(
  "real account policy denies suspension and stale DPoP, permits owner cleanup, and encodes storage failure as 503",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('fixture','allowed',1)",
      );
      const api = HttpApi.make("PolicyFixture").add(
        HttpApiGroup.make("policy")
          .add(RelayAgentActivitySnapshotEndpoint, RelayUnregisterDeviceEndpoint)
          .middleware(RelayDpopClientAuth),
      );
      let reads = 0;
      let cleanups = 0;
      const handlers = HttpApiBuilder.group(api, "policy", (h) =>
        h
          .handle("getAgentActivitySnapshot", () =>
            Effect.sync(() => {
              reads++;
              return { aggregate: null };
            }),
          )
          .handle("unregisterDevice", () =>
            Effect.sync(() => {
              cleanups++;
              return { ok: true as const };
            }),
          ),
      );
      const auth = layerDpopClientAuth.pipe(
        Layer.provide(postgresPolicyLayer(pg)),
        Layer.provide(
          Layer.mock(RelayTokens, {
            resolveDpopAccessTokenScopes: () => null,
            verifyDpopAccessToken: () =>
              Effect.succeed({
                iss: "https://relay.example.test",
                aud: "https://relay.example.test",
                sub: "fixture",
                account_epoch: 1,
                jti: "fixture-token",
                iat: 0,
                exp: 100,
                client_id: RelayMobileClientId,
                scope: [],
                cnf: { jkt: "fixture-key" },
              }),
          }),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(handlers),
              Layer.provide(auth),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const request = (cleanup = false) =>
        Effect.promise(() =>
          app.handler(
            new Request(
              `https://relay.example.test/v1/mobile/${cleanup ? "devices/phone" : "agent-activity"}`,
              {
                method: cleanup ? "DELETE" : "GET",
                headers: { authorization: "DPoP fixture-token" },
              },
            ),
          ),
        );
      expect((yield* request()).status).toBe(200);
      pg.query("UPDATE relay_account_access SET status='suspended',account_epoch=2");
      const denied = yield* request();
      expect(denied.status).toBe(403);
      expect(yield* Effect.promise(() => denied.json())).toMatchObject({
        code: "account_access_denied",
        reason: "suspended",
      });
      expect((yield* request(true)).status).toBe(200);
      pg.query("UPDATE relay_account_access SET status='allowed',account_epoch=3");
      const stale = yield* request();
      expect(stale.status).toBe(401);
      expect(yield* Effect.promise(() => stale.json())).toMatchObject({
        code: "account_epoch_stale",
        action: "refresh_token",
      });
      pg.query("ALTER TABLE relay_account_access RENAME TO fixture_unavailable_access");
      const outage = yield* request();
      expect(outage.status).toBe(503);
      expect(outage.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => outage.json())).toMatchObject({
        code: "authorization_unavailable",
      });
      expect(reads).toBe(1);
      expect(cleanups).toBe(1);
    }),
);

it.live(
  "HTTP recovery at held capacity returns the actionable tunnel quota 403 with real credentials and reservation",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      const key = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      const tunnelCalls: TunnelCall[] = [];
      let throttled = false;
      const services = layerPostgresProvider(pg, makeTunnelClient(tunnelCalls), makeDnsClient(), {
        charge: (input) =>
          throttled
            ? Effect.fail(
                new RelayRateLimitExceededError({
                  code: "rate_limit_exceeded",
                  operation: input.operation,
                  retryAfterSeconds: 60,
                  traceId: "fixture",
                }),
              )
            : Effect.void,
      });
      const credential = yield* Effect.gen(function* () {
        const owners = yield* EnvironmentOwnership;
        const identities = yield* EndpointIdentity;
        const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
        const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
        const db = yield* RelayDb.RelayDb;
        const sql = db.$client;
        const identity = yield* identities.resolve({ userId: "owner", environmentId: "env" });
        yield* owners.claim({
          userId: "owner",
          accountEpoch: 1,
          environmentId: "env",
          environmentPublicKey: key.publicKey.trim(),
        });
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,managed_tunnels_enabled,account_epoch,created_at,updated_at) VALUES ('owner','env',${key.publicKey.trim()},${`https://${identity.hostname}/`},${`wss://${identity.hostname}/ws`},'cloudflare_tunnel',true,1,'now','now')`;
        yield* sql`UPDATE relay_environment_owners SET state='active' WHERE user_id='owner'`;
        yield* allocations.reserve({
          userId: "owner",
          environmentId: "other",
          hostname: "ignored",
          tunnelName: "ignored",
        });
        return yield* credentials.create({
          userId: "owner",
          accountEpoch: 1,
          environmentId: "env",
          environmentPublicKey: key.publicKey.trim(),
        });
      }).pipe(Effect.provide(services));
      const routes = RelayHttpApi.layerServerApi.pipe(
        HttpRouter.provideRequest(services),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {}),
            Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
            Layer.mock(HeldHooks.HeldHooks, {}),
          ),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.server)).pipe(
              Layer.provide(routes),
              Layer.provide(RelayHttpApi.layerEnvironmentAuth.pipe(Layer.provide(services))),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const issuedAt = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };
      const proof = yield* signRelayJwt({
        privateKey: key.privateKey,
        typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
        payload: {
          iss: "goat-env:env",
          aud: "https://relay.example.test",
          sub: "env",
          jti: "recovery-at-cap",
          iat: issuedAt,
          exp: issuedAt + 60,
          action: "recover",
          environmentId: "env",
          cloudUserId: "owner",
          origin,
        },
      });
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/environments/env/tunnel", {
            method: "POST",
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
            body: JSON.stringify({ cloudUserId: "owner", origin, proof }),
          }),
        ),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "environment_link_limit_exceeded",
        maxTunnels: 1,
      });
      expect(tunnelCalls).toEqual([]);
      const request = (path: string, body: unknown) =>
        Effect.promise(() =>
          app.handler(
            new Request(`https://relay.example.test/v1/environments/env/${path}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }),
          ),
        );
      const recovery = { cloudUserId: "owner", origin, proof };
      const mismatch = yield* request("tunnel", { ...recovery, cloudUserId: "other" });
      expect(mismatch.status).toBe(403);
      expect(yield* Effect.promise(() => mismatch.json())).toMatchObject({
        code: "environment_owner_mismatch",
      });
      throttled = true;
      const limited = yield* request("tunnel", recovery);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      throttled = false;
      pg.query("UPDATE relay_account_access SET status='suspended',account_epoch=2");
      for (const [path, body] of [
        ["tunnel", recovery],
        ["tunnel/recovery", { ...recovery, tunnelId: "old-tunnel" }],
        ["link-preferences", { holdWebhooksWhileOffline: true }],
        ["hooks/wake", {}],
      ] as const) {
        expect((yield* request(path, body)).status).toBe(403);
      }
      pg.query("UPDATE relay_account_access SET status='allowed',account_epoch=3");
      const stale = yield* request("tunnel", recovery);
      expect(stale.status).toBe(401);
      expect(yield* Effect.promise(() => stale.json())).toMatchObject({
        code: "account_epoch_stale",
        action: "relink",
      });
      pg.query("UPDATE relay_environment_credentials SET user_id=NULL,account_epoch=NULL");
      const legacy = yield* request("tunnel", recovery);
      expect(legacy.status).toBe(401);
      expect(yield* Effect.promise(() => legacy.json())).toMatchObject({
        code: "environment_relink_required",
      });
      pg.query(
        "UPDATE relay_environment_credentials SET user_id='owner',account_epoch=1; ALTER TABLE relay_account_access RENAME TO fixture_unavailable_access",
      );
      const outage = yield* request("tunnel", recovery);
      expect(outage.status).toBe(503);
      expect(yield* Effect.promise(() => outage.json())).toMatchObject({
        code: "authorization_unavailable",
      });
      expect(tunnelCalls).toEqual([]);
    }),
);
