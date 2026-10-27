// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy owns the isolated local Worker lifecycle/error union.
import { verifyToken } from "@clerk/backend";
import { expect } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  RelayApi,
  RelayMobileClientId,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
  RelayAccessTokenType,
  type RelayEnvironmentLinkProofPayload,
  type RelayAgentActivityState,
} from "@goat/contracts/relay";
import { RelayRateLimitExceededError } from "@goat/contracts/relayErrors";
import * as RelayJwt from "@goat/shared/relayJwt";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import { resolveDev } from "alchemy/Test/Core";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";
import { DEFAULT_LIMITS, HOURLY_OPERATIONS } from "../accounts/AccountLimits.ts";
import { makeWorkerRateLimits } from "../accounts/RelayRateLimits.ts";
import * as Fixture from "../accounts/test/PolicyWorkerFixture.ts";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { RelayDb } from "../db.ts";
import { EndpointIdentity } from "../environments/EndpointIdentity.ts";
import { EnvironmentOwnership } from "../environments/EnvironmentOwnership.ts";
import { EnvironmentCredentials } from "../environments/EnvironmentCredentials.ts";
import { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { Devices } from "../agentActivity/Devices.ts";
import { AgentActivityRows } from "../agentActivity/AgentActivityRows.ts";
import * as Api from "./Api.ts";
import { dpopKey, httpServices, issuer, signingKey, signJwt } from "./RateLimitHttp.testkit.ts";

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn(), createClerkClient: vi.fn() }));

if (!resolveDev({ dev: true }))
  throw new Error("HTTP rate tests require local provider mode; cloud fallback is forbidden");
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: true,
  stage: "wp3-http-rate-fixture",
});

test.provider("real HTTP budgets deny every protected path before its side effects", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "relay-http-rates-" });
    const context = { dotAlchemy: root, dev: true, adopt: false };
    yield* Effect.gen(function* () {
      const url = yield* stack.deploy(
        Effect.map(Fixture.PolicyWorker, (worker) => worker.url).pipe(
          Effect.provide(Fixture.layer),
        ),
      );
      if (url === undefined) throw new Error("Local Worker fixture did not return a URL");
      const hostname = new URL(url).hostname;
      expect(
        hostname === "127.0.0.1" ||
          hostname === "localhost" ||
          hostname.endsWith(".localhost") ||
          hostname === "[::1]",
      ).toBe(true);
      const http = yield* HttpClient.HttpClient;
      const read = (path: string, key: string, operation?: string) => {
        const request = new URL(path, url);
        request.searchParams.set("account", key);
        if (operation) request.searchParams.set("operation", operation);
        return http.get(request.href).pipe(Effect.flatMap((response) => response.json));
      };
      const rates = yield* makeWorkerRateLimits({
        stage: "http-fixture",
        hourly: (key, operation) =>
          read("/rate", key, operation).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  allowed: Schema.Boolean,
                  retryAfterSeconds: Schema.Number,
                }),
              ),
            ),
          ),
        mobile: (key) =>
          read("/mobile-rate", key).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ success: Schema.Boolean }))),
          ),
        publish: (key) =>
          read("/publish-rate", key).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ success: Schema.Boolean }))),
          ),
      }).pipe(Effect.provide(NodeCrypto.layer));
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1)",
      );
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "owner",
        aud: "fixture-relay",
        __raw: "fixture-session-token",
        iss: "https://clerk.example.test",
        sid: "fixture-session",
        iat: 0,
        nbf: 0,
        exp: 4_000_000_000,
      });
      const relayKey = signingKey();
      const hostKey = signingKey();
      const linkKey = signingKey();
      const clientKey = dpopKey();
      const fixture = httpServices(pg, rates, relayKey);
      const now = yield* DateTime.now;
      const issuedAt = Math.floor(now.epochMilliseconds / 1000);
      const activity: RelayAgentActivityState = {
        environmentId: "env" as RelayAgentActivityState["environmentId"],
        threadId: "existing-thread" as RelayAgentActivityState["threadId"],
        projectTitle: "Fixture",
        threadTitle: "Existing thread",
        phase: "running",
        headline: "Working",
        modelTitle: "Fixture model",
        updatedAt: DateTime.formatIso(now),
        deepLink: "goat://thread/existing-thread",
      };
      const preferences = {
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      };
      const credential = yield* Effect.gen(function* () {
        const identity = yield* (yield* EndpointIdentity).resolve({
          userId: "owner",
          environmentId: "env",
        });
        yield* (yield* EnvironmentOwnership).claim({
          userId: "owner",
          accountEpoch: 1,
          environmentId: "env",
          environmentPublicKey: hostKey.publicKey.trim(),
        });
        yield* (yield* ManagedEndpointAllocations).reserve({
          userId: "owner",
          environmentId: "env",
          hostname: identity.hostname,
          tunnelName: identity.tunnelName,
        });
        const sql = (yield* RelayDb).$client;
        yield* sql`UPDATE relay_managed_endpoint_allocations SET tunnel_id='seed-tunnel',dns_record_id='seed-dns',ready_at='ready' WHERE user_id='owner'`;
        yield* sql`INSERT INTO relay_environment_links(user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,managed_tunnels_enabled,account_epoch,created_at,updated_at) VALUES ('owner','env',${hostKey.publicKey.trim()},${`https://${identity.hostname}/`},${`wss://${identity.hostname}/ws`},'cloudflare_tunnel',true,1,'now','now')`;
        yield* sql`UPDATE relay_environment_owners SET state='active' WHERE user_id='owner'`;
        const devices = yield* Devices;
        yield* devices.register({
          userId: "owner",
          registration: {
            deviceId: "existing-phone",
            label: "Android",
            platform: "android",
            androidApiLevel: 35,
            pushToken: "existing-fcm-token",
            preferences,
          },
        });
        yield* devices.register({
          userId: "owner",
          registration: {
            deviceId: "existing-iphone",
            label: "iPhone",
            platform: "ios",
            iosMajorVersion: 18,
            pushToStartToken: "existing-apns-token",
            preferences,
          },
        });
        yield* (yield* AgentActivityRows).upsert({
          userId: "owner",
          accountEpoch: 1,
          environmentPublicKey: hostKey.publicKey.trim(),
          state: activity,
        });
        return yield* (yield* EnvironmentCredentials).create({
          userId: "owner",
          accountEpoch: 1,
          environmentId: "env",
          environmentPublicKey: hostKey.publicKey.trim(),
        });
      }).pipe(Effect.provide(fixture.services));
      const routes = Layer.mergeAll(
        Api.layerClientApi,
        Api.layerTokenApi,
        Api.layerDpopClientApi,
        Api.layerMobileApi,
        Api.layerServerApi,
      ).pipe(HttpRouter.provideRequest(fixture.services), Layer.provide(fixture.services));
      const auth = Layer.mergeAll(
        Api.layerClientAuth,
        Api.layerDpopClientAuth,
        Api.layerEnvironmentAuth,
      ).pipe(Layer.provide(fixture.services));
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(
              HttpApi.make("RelayApi").add(
                RelayApi.groups.client,
                RelayApi.groups.token,
                RelayApi.groups.dpopClient,
                RelayApi.groups.mobile,
                RelayApi.groups.server,
              ),
            ).pipe(
              Layer.provide(routes),
              Layer.provide(auth),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const accessToken = signJwt(
        {
          iss: issuer,
          aud: issuer,
          sub: "owner",
          account_epoch: 1,
          jti: "fixture-access",
          iat: issuedAt,
          exp: issuedAt + 1800,
          client_id: RelayMobileClientId,
          scope: "environment:connect mobile:registration",
          cnf: { jkt: clientKey.thumbprint },
        },
        "goat-relay-dpop-access+jwt",
        relayKey.privateKey,
      );
      const post = (path: string, body: unknown, token = "Bearer fixture-clerk") =>
        Effect.promise(() =>
          app.handler(
            new Request(new URL(path, issuer), {
              method: "POST",
              headers: {
                authorization: token,
                "content-type":
                  body instanceof URLSearchParams
                    ? "application/x-www-form-urlencoded"
                    : "application/json",
                dpop: clientKey.proof(
                  path,
                  issuedAt,
                  token.startsWith("DPoP ") ? accessToken : undefined,
                ),
              },
              body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
            }),
          ),
        );
      const assertLimited = Effect.fn("fixture.assertHttpLimited")(function* (
        response: Response,
        operation: RelayRateLimitExceededError["operation"],
      ) {
        expect(response.status, operation).toBe(429);
        expect(response.headers.get("cache-control"), operation).toBe("no-store");
        const body = yield* Effect.promise(() => response.json());
        const error = yield* Schema.decodeUnknownEffect(RelayRateLimitExceededError)(body);
        expect(error.operation).toBe(operation);
        expect(error.code).toBe("rate_limit_exceeded");
        expect(error.retryAfterSeconds).toBeGreaterThan(0);
        expect(error.retryAfterSeconds).toBe(
          operation === "mobile_registration" || operation === "activity_publish" ? 60 : 3600,
        );
        expect(response.headers.get("retry-after")).toBe(String(error.retryAfterSeconds));
        expect(body).not.toHaveProperty("access_token");
        expect(body).not.toHaveProperty("challenge");
        expect(body).not.toHaveProperty("environmentCredential");
      });
      for (const operation of HOURLY_OPERATIONS) {
        yield* Effect.all(
          Array.from({ length: DEFAULT_LIMITS[operation] }, () =>
            rates.charge({ userId: "owner", operation }),
          ),
          { concurrency: "unbounded" },
        );
      }
      using signing = vi.spyOn(RelayJwt, "signRelayJwt");
      yield* assertLimited(
        yield* post("/v1/client/environment-link-challenges", {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        }),
        "link_challenge",
      );
      yield* assertLimited(
        yield* post(
          "/v1/client/dpop-token",
          new URLSearchParams({
            grant_type: RelayDpopTokenExchangeGrantType,
            subject_token: "fixture-clerk",
            subject_token_type: RelayJwtSubjectTokenType,
            requested_token_type: RelayAccessTokenType,
            resource: issuer,
            scope: "environment:connect",
            client_id: RelayMobileClientId,
          }),
        ),
        "dpop_token",
      );
      expect(signing).not.toHaveBeenCalled();
      for (const managedTunnelsEnabled of [false, true]) {
        const challenge = signJwt(
          {
            kind: "environment_link_challenge",
            iss: issuer,
            aud: issuer,
            sub: "owner",
            account_epoch: 1,
            jti: `challenge-${managedTunnelsEnabled}`,
            iat: issuedAt,
            exp: issuedAt + 300,
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled,
          },
          "goat-link-challenge+jwt",
          relayKey.privateKey,
        );
        const payload: RelayEnvironmentLinkProofPayload = {
          iss: "goat-env:new-env",
          aud: issuer,
          sub: "new-env",
          jti: `link-${managedTunnelsEnabled}`,
          iat: issuedAt,
          exp: issuedAt + 300,
          challenge,
          environmentId: "new-env" as RelayEnvironmentLinkProofPayload["environmentId"],
          descriptor: {
            environmentId: "new-env" as RelayEnvironmentLinkProofPayload["environmentId"],
            label: "Rate fixture",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
          environmentPublicKey: linkKey.publicKey.trim(),
          endpoint: {
            httpBaseUrl: "https://new-env.example.test/",
            wsBaseUrl: "wss://new-env.example.test/ws",
            providerKind: "manual",
          },
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          scopes: ["agent_activity_notifications", "managed_tunnels"],
        };
        yield* assertLimited(
          yield* post("/v1/client/environment-links", {
            proof: signJwt(payload, RelayJwt.RELAY_LINK_PROOF_TYP, linkKey.privateKey),
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled,
          }),
          "link",
        );
        expect(
          pg
            .query("SELECT count(*) FROM relay_environment_links WHERE environment_id='new-env'")
            .trim(),
        ).toBe("0");
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_environment_credentials WHERE environment_id='new-env'",
            )
            .trim(),
        ).toBe("0");
        expect(fixture.tunnelCalls).toEqual([]);
        expect(
          pg
            .query(
              "SELECT count(*) FROM relay_managed_endpoint_allocations WHERE environment_id='new-env'",
            )
            .trim(),
        ).toBe("0");
      }
      yield* assertLimited(
        yield* post(
          "/v1/environments/env/connect",
          {
            clientProofKeyThumbprint: clientKey.thumbprint,
          },
          `DPoP ${accessToken}`,
        ),
        "connect",
      );
      expect(fixture.mintRequests).toEqual([]);
      expect(signing).not.toHaveBeenCalled();
      yield* rates.charge({ userId: "owner", operation: "mobile_registration" });
      const beforeDevices = pg.query(
        "SELECT row_to_json(d) FROM relay_mobile_devices d ORDER BY device_id",
      );
      for (const deviceId of ["blocked-phone", "existing-phone"]) {
        yield* assertLimited(
          yield* post(
            "/v1/mobile/devices",
            {
              deviceId,
              label: "Changed",
              platform: "android",
              androidApiLevel: 35,
              pushToken: "blocked-token",
              preferences,
            },
            `DPoP ${accessToken}`,
          ),
          "mobile_registration",
        );
        expect(
          pg.query("SELECT row_to_json(d) FROM relay_mobile_devices d ORDER BY device_id"),
        ).toBe(beforeDevices);
        expect(fixture.deliveries).toEqual([]);
      }
      yield* rates.charge({
        userId: "owner",
        operation: "activity_publish",
        environmentId: "env",
        environmentPublicKey: hostKey.publicKey.trim(),
      });
      const beforeRows = pg.query(
        "SELECT row_to_json(r) FROM relay_agent_activity_rows r ORDER BY thread_id",
      );
      for (const state of [
        { ...activity, headline: "Rejected update" },
        { ...activity, threadId: "new-thread" as RelayAgentActivityState["threadId"] },
        null,
      ]) {
        const threadId = state?.threadId ?? activity.threadId;
        const proof = signJwt(
          {
            iss: "goat-env:env",
            aud: issuer,
            sub: "env",
            jti: state === null ? "publish-delete" : `publish-${threadId}`,
            iat: issuedAt,
            exp: issuedAt + 300,
            environmentId: "env",
            threadId,
            state,
          },
          RelayJwt.RELAY_ACTIVITY_PUBLISH_TYP,
          hostKey.privateKey,
        );
        yield* assertLimited(
          yield* post(
            `/v1/environments/env/threads/${threadId}/agent-activity`,
            {
              proof,
              state,
            },
            `Bearer ${credential}`,
          ),
          "activity_publish",
        );
        expect(
          pg.query("SELECT row_to_json(r) FROM relay_agent_activity_rows r ORDER BY thread_id"),
        ).toBe(beforeRows);
        expect(fixture.deliveries).toEqual([]);
      }
    }).pipe(
      Effect.provideService(AlchemyContext, context),
      Effect.ensuring(
        stack.destroy().pipe(Effect.provideService(AlchemyContext, context), Effect.orDie),
      ),
    );
  }),
);
