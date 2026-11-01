import * as Redacted from "effect/Redacted";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- real DPoP proofs for live socket admission.
import * as NodeCrypto from "node:crypto";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ServerSettings } from "@goat/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@goat/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Access from "../auth/HubConnectAccess.ts";
import * as HubRpcSocket from "../auth/HubRpcSocket.ts";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import { authLayer, phoneScopes, serve, startHub } from "./testFixtures.ts";

const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(ServerSettings));

const socket = Effect.fn("test.connectHubSocket")(function* (url: string) {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const frames = yield* Queue.unbounded<string>();
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const client = new NodeWS.WebSocket(url);
      client.on("open", () => opened.resolve());
      client.on("close", () => closed.resolve());
      client.on("error", () => {});
      client.on("message", (frame) => Queue.offerUnsafe(frames, frame.toString()));
      return client;
    }),
    (client) => Effect.sync(() => client.terminate()),
  );
  yield* Effect.promise(() => opened.promise);
  return { client, frames, closed: Effect.promise(() => closed.promise) };
});

it.effect.each([
  ["event before subscription", false, false],
  ["event before subscription", true, false],
  ["subscription before event", false, false],
  ["subscription before event", true, false],
  ["event before subscription", false, true],
  ["event before subscription", true, true],
  ["subscription before event", false, true],
  ["subscription before event", true, true],
] as const)(
  "settings withdrawal closes hub and proxy sockets: %s, data %s, both writes fail %s",
  ([ordering, sendData, doubleFailure]) =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      const settings = yield* Settings.ServerSettingsService;
      const access = yield* Access.HubConnectAccess;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      yield* settings.start;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const proofKeyThumbprint = computeDpopJwkThumbprint(jwk);
      let sequence = 0;
      const proof = Effect.fn("test.connectProof")(function* (
        method: string,
        url: string,
        token: string,
      ) {
        const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const data = `${encode({ alg: "ES256", typ: "dpop+jwt", jwk })}.${encode({ htm: method, htu: url, ath: computeDpopAccessTokenHash(token), iat, jti: `race-${++sequence}` })}`;
        return `${data}.${NodeCrypto.sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
      });
      const mint = Effect.gen(function* () {
        const grant = yield* hub.auth.createCloudConnectPairingLink({ proofKeyThumbprint });
        const token = yield* hub.auth.exchangeBootstrapCredentialForAccessToken(
          grant.credential,
          undefined,
          { deviceType: "mobile" },
          { proofKeyThumbprint },
        );
        return yield* hub.sessionStore
          .verify(token.access_token)
          .pipe(Effect.map((session) => ({ ...session, token: token.access_token })));
      });
      const proxySession = yield* mint;
      const hubSession = yield* mint;
      const paired = yield* hub.auth.issueSession({ scopes: phoneScopes });
      const entering = yield* Queue.unbounded<string>();
      const subscribed = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const awaitDenial = access.awaitDenial;
      using _denial = vi.spyOn(access, "awaitDenial").mockImplementation((credential) =>
        Effect.gen(function* () {
          if (!Access.isPrivilegedConnect(credential)) return yield* awaitDenial(credential);
          yield* Queue.offer(entering, credential.subject);
          if (ordering === "event before subscription") yield* Deferred.await(release);
          const tracer = Tracer.make({
            span: (options) => {
              if (options.name === "HubConnectAccess.watchCredential")
                Queue.offerUnsafe(subscribed, credential.subject);
              return new Tracer.NativeSpan(options);
            },
          });
          return yield* awaitDenial(credential).pipe(Effect.withTracer(tracer));
        }),
      );
      const rpcOrigin = yield* serve(
        HubRpcSocket.layer(() =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const stream = yield* request.upgrade;
            const reader = yield* stream.reader;
            if (sendData) yield* (yield* stream.writer).write("hub-to-client");
            yield* Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain);
            return HttpServerResponse.empty();
          }),
        ),
      );
      const open = Effect.fn("test.openKeyBoundSocket")(function* (
        base: string,
        path: string,
        session: typeof proxySession,
      ) {
        const ticket = yield* hub.auth.issueWebSocketTicket(session, { use: "rpc" });
        const url = `${base}${path}`;
        return yield* socket(
          `${url.replace(/^http/u, "ws")}?orchestrationProtocol=1001&wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}&dpop=${encodeURIComponent(yield* proof("GET", url, Redacted.value(ticket.ticket)))}`,
        );
      });
      const proxy = yield* open(hub.baseUrl, "hub/nodes/node-1/ws", proxySession);
      const rpc = yield* open(rpcOrigin, "ws", hubSession);
      const pairedTicket = yield* hub.auth.issueWebSocketTicket(paired);
      const pairedSocket = yield* socket(
        `${hub.baseUrl.replace(/^http/u, "ws")}hub/nodes/node-1/ws?orchestrationProtocol=1001&wsTicket=${encodeURIComponent(Redacted.value(pairedTicket.ticket))}`,
      );
      yield* Queue.take(entering);
      yield* Queue.take(entering);
      if (ordering === "subscription before event") {
        yield* Queue.take(subscribed);
        yield* Queue.take(subscribed);
      }
      if (sendData) {
        proxy.client.send(
          JSON.stringify({
            _tag: "Request",
            id: "data",
            tag: "orchestration.subscribeThread",
            payload: null,
            headers: [],
          }),
        );
        expect(yield* Queue.take(proxy.frames)).toContain("node-stream-value");
        expect(yield* Queue.take(rpc.frames)).toBe("hub-to-client");
      }
      expect(yield* Queue.size(hub.node.socketEnded)).toBe(0);
      yield* sql`CREATE TRIGGER fail_connect_cleanup BEFORE UPDATE ON auth_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected hygiene failure'); END`;
      yield* sql`CREATE TRIGGER fail_connect_grant_cleanup BEFORE UPDATE ON auth_pairing_links WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected hygiene failure'); END`;
      let markerFails = doubleFailure;
      const write = fs.writeFileString;
      using _marker = vi.spyOn(fs, "writeFileString").mockImplementation((file, ...args) =>
        markerFails && file.endsWith("connect-hub-access.fence.tmp")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
                pathOrDescriptor: file,
              }),
            )
          : write(file, ...args),
      );
      if (doubleFailure)
        yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected generation failure'); END`;
      const result = yield* settings
        .updateSettings({ hub: { connectDevicesHubProxy: false } })
        .pipe(Effect.result);
      expect(result._tag).toBe(doubleFailure ? "Failure" : "Success");
      expect((yield* access.current).allowed).toBe(false);
      const persisted = yield* decodeSettings(
        yield* fs.readFileString((yield* Config.ServerConfig).settingsPath),
      );
      expect(persisted.hub.connectDevicesHubProxy).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* proxy.closed;
      yield* rpc.closed;
      yield* Queue.take(hub.node.socketEnded);
      if (sendData) yield* Queue.take(hub.node.streamEnded);
      const fetchStatus = Effect.fn("test.protectedNode")(function* (session: typeof proxySession) {
        const url = `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`;
        const http = yield* HttpClient.HttpClient;
        return (yield* http.get(url, {
          headers: {
            authorization: `DPoP ${session.token}`,
            dpop: yield* proof("GET", url, session.token),
          },
        })).status;
      });
      expect(yield* fetchStatus(proxySession).pipe(Effect.provide(FetchHttpClient.layer))).toBe(
        401,
      );
      if (doubleFailure) {
        markerFails = false;
        yield* sql`DROP TRIGGER fail_connect_bump`;
        yield* TestClock.adjust("1 second");
        yield* access.awaitRecovery;
      }
      const standard = yield* mint;
      expect(standard.scopes).not.toContain("hub:proxy");
      expect((yield* access.current).allowed).toBe(false);
      expect(yield* fetchStatus(standard).pipe(Effect.provide(FetchHttpClient.layer))).toBe(403);
      const pairedHttp = yield* Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        return (yield* http.get(`${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`, {
          headers: { authorization: `Bearer ${paired.token}` },
        })).status;
      }).pipe(Effect.provide(FetchHttpClient.layer));
      expect(pairedHttp).toBe(200);
      pairedSocket.client.send(
        JSON.stringify({
          _tag: "Request",
          id: "paired",
          tag: "orchestration.subscribeThread",
          payload: null,
          headers: [],
        }),
      );
      expect(yield* Queue.take(pairedSocket.frames)).toContain("node-stream-value");
      yield* settings.updateSettings({ hub: { connectDevicesHubProxy: true } });
      expect(yield* fetchStatus(proxySession).pipe(Effect.provide(FetchHttpClient.layer))).toBe(
        401,
      );
      expect(yield* fetchStatus(yield* mint).pipe(Effect.provide(FetchHttpClient.layer))).toBe(200);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);
