import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { ConnectionContext, PenPeer } from "./connectionContext.ts";
import { MAIN_LISTENER, penConnection } from "./connectionContext.testkit.ts";
import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";
import { PEN_PROXY_SUBJECT } from "./sessionBinding.ts";
import { resolveReusableDevAuth } from "./ReusableDevAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const peerA: PenPeer = {
  meshId: "mesh-1",
  nodeId: "node-a",
  signPub: "sign-a",
  noisePub: "noise-a",
  name: "a",
};
const bindingA = {
  meshId: peerA.meshId,
  nodeId: peerA.nodeId,
  signPub: peerA.signPub,
  noisePub: peerA.noisePub,
};
const devToken = "reusable-dev-auth-token-that-is-long-enough";

const layerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, ...overrides })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-binding-test-" })));

const layerStoreOnSql = SessionStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("binding-test")),
    }),
  ),
  Layer.provide(
    layerConfig({
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(devToken),
    }),
  ),
);
const layerStore = layerStoreOnSql.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

/** Every context the design's binding matrix names, built fresh for each run. */
const contexts = () => {
  const closed = penConnection(peerA, { connectionId: "closed" });
  closed.close();
  return {
    ownPen: penConnection(peerA).context,
    reconnect: penConnection(peerA, { connectionId: "pen-connection-2" }).context,
    otherMember: penConnection({ ...peerA, nodeId: "node-b", signPub: "sign-b" }).context,
    rotatedKey: penConnection({ ...peerA, noisePub: "noise-a2" }).context,
    otherMesh: penConnection({ ...peerA, meshId: "mesh-2" }).context,
    closed: closed.context,
    main: MAIN_LISTENER,
    none: undefined,
  } satisfies Record<string, ConnectionContext | undefined>;
};
type ContextName = keyof ReturnType<typeof contexts>;
const PEN_PASSES: ReadonlyArray<ContextName> = ["ownPen", "reconnect"];
const MAIN_PASSES: ReadonlyArray<ContextName> = ["main"];

const passes = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isSuccess(exit));

const outcomes = (check: (context: ConnectionContext | undefined) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const result: Partial<Record<ContextName, boolean>> = {};
    for (const [name, context] of Object.entries(contexts()))
      result[name as ContextName] = yield* check(context);
    return result;
  });
const expected = (passing: ReadonlyArray<ContextName>) =>
  Object.fromEntries(
    Object.keys(contexts()).map((name) => [name, passing.includes(name as ContextName)]),
  );

it.layer(NodeServices.layer)("session binding (mesh link design §6)", (it) => {
  it.effect(
    "a Pen-bound member agent or proxy session passes only on a live connection from its own member",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const agent = yield* sessions.issue({
          subject: MCP_CLIENT_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "outside_client",
          penBinding: bindingA,
        });
        const proxy = yield* sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "proxied_person",
          penBinding: bindingA,
        });
        for (const issued of [agent, proxy])
          expect(
            yield* outcomes((context) => passes(sessions.verify(issued.token, context))),
          ).toEqual(expected(PEN_PASSES));
      }).pipe(Effect.provide(layerStore)),
  );

  it.effect(
    "an unbound session and the reusable dev credential pass only on the main listener",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const person = yield* sessions.issue({ subject: "browser" });
        expect(
          yield* outcomes((context) => passes(sessions.verify(person.token, context))),
        ).toEqual(expected(MAIN_PASSES));
        expect(yield* outcomes((context) => passes(sessions.verify(devToken, context)))).toEqual(
          expected(MAIN_PASSES),
        );
      }).pipe(Effect.provide(layerStore)),
  );

  it.effect(
    "a WebSocket ticket passes only where its session would, and only with its own principal",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const person = yield* sessions.issue({ subject: "browser" });
        const proxy = yield* sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "proxied_person",
          penBinding: bindingA,
        });
        const personTicket = yield* sessions.issueWebSocketToken(person.sessionId, {
          principalKind: "person",
        });
        const legacyTicket = yield* sessions.issueWebSocketToken(person.sessionId);
        const proxyTicket = yield* sessions.issueWebSocketToken(proxy.sessionId, {
          principalKind: "proxied_person",
          penNodeId: peerA.nodeId,
        });
        for (const ticket of [personTicket, legacyTicket])
          expect(
            yield* outcomes((context) =>
              passes(sessions.verifyWebSocketToken(ticket.token, context)),
            ),
          ).toEqual(expected(MAIN_PASSES));
        expect(
          yield* outcomes((context) =>
            passes(sessions.verifyWebSocketToken(proxyTicket.token, context)),
          ),
        ).toEqual(expected(PEN_PASSES));
        const own = contexts().ownPen;
        // pk or pn that differ from the row, or a pk-less ticket for a bound row, fail everywhere.
        const wrongKind = yield* sessions.issueWebSocketToken(proxy.sessionId, {
          principalKind: "person",
          penNodeId: peerA.nodeId,
        });
        const wrongNode = yield* sessions.issueWebSocketToken(proxy.sessionId, {
          principalKind: "proxied_person",
          penNodeId: "node-b",
        });
        const bare = yield* sessions.issueWebSocketToken(proxy.sessionId);
        for (const ticket of [wrongKind, wrongNode, bare])
          expect(yield* passes(sessions.verifyWebSocketToken(ticket.token, own))).toBe(false);
        // A ticket outlives nothing: once its session is revoked it fails on its own connection.
        yield* sessions.revoke(proxy.sessionId);
        expect(yield* passes(sessions.verifyWebSocketToken(proxyTicket.token, own))).toBe(false);
      }).pipe(Effect.provide(layerStore)),
  );

  it.effect("the binding survives a restart: a reopened store still checks it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-binding-restart-" });
      const devUrl = new URL("http://127.0.0.1:5173");
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
        baseDirIsExplicit: true,
      });
      yield* ServerConfig.ensureServerDirectories(paths);
      const reopen = () =>
        SessionStore.layer.pipe(
          Layer.provide(SqlitePersistence.layerFromPath(paths.dbPath)),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("binding-test")),
            }),
          ),
          Layer.provide(layerConfig({ ...paths, baseDir, mode: "web", devUrl })),
        );
      const issued = yield* Effect.flatMap(SessionStore.SessionStore, (sessions) =>
        sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "proxied_person",
          penBinding: bindingA,
        }),
      ).pipe(Effect.provide(reopen()));
      const reopened = yield* Effect.flatMap(SessionStore.SessionStore, (sessions) =>
        outcomes((context) => passes(sessions.verify(issued.token, context))),
      ).pipe(Effect.provide(reopen()));
      expect(reopened).toEqual(expected(PEN_PASSES));
    }),
  );

  it.effect(
    "issuance refuses shapes that would misclassify a principal and caps Pen sessions at 12 hours",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const refused = [
          { subject: PEN_PROXY_SUBJECT, penBinding: bindingA },
          { subject: PEN_PROXY_SUBJECT, principalKind: "proxied_person" as const },
          { subject: "browser", principalKind: "proxied_person" as const, penBinding: bindingA },
          { subject: "browser", penBinding: bindingA },
          { subject: "browser", principalKind: "outside_client" as const, penBinding: bindingA },
        ];
        for (const input of refused)
          expect(yield* passes(sessions.issue({ ...input, method: "bearer-access-token" }))).toBe(
            false,
          );
        const capped = yield* sessions.issue({
          subject: MCP_CLIENT_SUBJECT,
          method: "bearer-access-token",
          principalKind: "outside_client",
          penBinding: bindingA,
          ttl: Duration.days(30),
        });
        const now = yield* Clock.currentTimeMillis;
        expect(capped.expiresAt.epochMilliseconds).toBe(
          now + Duration.toMillis(Duration.hours(12)),
        );
      }).pipe(Effect.provide(layerStore)),
  );

  it.effect(
    "server startup's dev credential check takes no token and refuses a Pen-bound row",
    () =>
      Effect.gen(function* () {
        const devSessionId = resolveReusableDevAuth({
          mode: "web",
          devUrl: new URL("http://127.0.0.1:5173"),
          devAuthToken: Redacted.make(devToken),
        })?.sessionId;
        expect(devSessionId).toBeDefined();
        const sql = yield* SqlClient.SqlClient;
        // A row bound to a member under the dev session id, written before the store starts.
        yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, method, scopes, client_device_type, issued_at, expires_at,
          principal_kind, pen_mesh_id, pen_node_id, pen_sign_pub, pen_noise_pub
        ) VALUES (
          ${devSessionId ?? ""}, 'reusable-dev-token', 'browser-session-cookie',
          '["orchestration:read"]', 'unknown', '2026-01-01T00:00:00.000Z',
          '9999-12-31T23:59:59.999Z', 'outside_client', 'mesh-1', 'node-a', 'sign-a', 'noise-a'
        )
      `;
        const bound = yield* Effect.flatMap(SessionStore.SessionStore, (sessions) =>
          passes(sessions.verifyStartupDevCredential()),
        ).pipe(Effect.provide(layerStoreOnSql));
        expect(bound).toBe(false);
        // The binding columns are immutable once written.
        const rewrite = yield* Effect.exit(
          sql`UPDATE auth_sessions SET pen_node_id = NULL WHERE session_id = ${devSessionId ?? ""}`,
        );
        expect(Exit.isFailure(rewrite)).toBe(true);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
