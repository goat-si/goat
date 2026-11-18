import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PEN_PROXY_SUBJECT } from "./sessionBinding.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerSessionStore = SessionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-revoke-others-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.merge(TestClock.layer()),
);

const penBinding = { meshId: "mesh-1", nodeId: "node-a", signPub: "sign", noisePub: "noise" };
const bearer = "bearer-access-token" as const;

const grantState = (
  store: SessionStore.SessionStore["Service"],
  sessionId: SessionStore.IssuedSession["sessionId"],
) =>
  store
    .readActiveScopes(sessionId)
    .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "live" as const }));

const issueKinds = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  return {
    desktop: yield* sessions.issue({ subject: "desktop-bootstrap", method: bearer }),
    pen: yield* sessions.issue({
      subject: PEN_PROXY_SUBJECT,
      method: bearer,
      scopes: ["orchestration:read"],
      principalKind: "proxied_person",
      penBinding,
    }),
    browser: yield* sessions.issue({ subject: "one-time-token" }),
  };
});

it.effect(
  "the desktop app pressing Revoke others keeps its own session and Pen sessions, ends the rest, and reports what it kept",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const { desktop, pen, browser } = yield* issueKinds;

      const result = yield* sessions.revokeAllExcept(desktop.sessionId);

      expect(result).toEqual({ revokedCount: 1, kept: { desktop: 0, pen: 1 } });
      expect(yield* grantState(sessions, desktop.sessionId)).toBe("live");
      expect(yield* grantState(sessions, pen.sessionId)).toBe("live");
      expect(yield* grantState(sessions, browser.sessionId)).toBe("UnknownSessionTokenError");
    }).pipe(Effect.provide(layerSessionStore)),
);

it.effect(
  "two kept sessions pressing Revoke others one after the other keep each other and report the other as kept",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const { desktop, pen } = yield* issueKinds;

      const byDesktop = yield* sessions.revokeAllExcept(desktop.sessionId);
      const phone = yield* sessions.issue({ subject: "one-time-token" });
      const byPen = yield* sessions.revokeAllExcept(pen.sessionId);

      expect(byDesktop).toEqual({ revokedCount: 1, kept: { desktop: 0, pen: 1 } });
      expect(byPen).toEqual({ revokedCount: 1, kept: { desktop: 1, pen: 0 } });
      expect(yield* grantState(sessions, desktop.sessionId)).toBe("live");
      expect(yield* grantState(sessions, pen.sessionId)).toBe("live");
      expect(yield* grantState(sessions, phone.sessionId)).toBe("UnknownSessionTokenError");
    }).pipe(Effect.provide(layerSessionStore)),
);

it.effect(
  "a row with only part of a Pen binding is revoked and unmarked, because the SQL and the list read one predicate",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const current = yield* sessions.issue({ subject: "settings-page" });
      const partial = yield* sessions.issue({ subject: "one-time-token" });
      // Nothing in GOAT writes a partial binding; a hand edit past the immutability trigger can.
      yield* sql`DROP TRIGGER auth_sessions_binding_immutable`;
      yield* sql`UPDATE auth_sessions SET pen_node_id = 'node-a' WHERE session_id = ${partial.sessionId}`;
      const listedBefore = yield* sessions.listActive();

      const result = yield* sessions.revokeAllExcept(current.sessionId);

      expect(listedBefore.find((row) => row.sessionId === partial.sessionId)).not.toHaveProperty(
        "keptByRevokeOthers",
      );
      expect(result).toEqual({ revokedCount: 1, kept: { desktop: 0, pen: 0 } });
      expect(yield* grantState(sessions, partial.sessionId)).toBe("UnknownSessionTokenError");
    }).pipe(Effect.provide(layerSessionStore)),
);

it.effect(
  "an expired desktop row the list does not show is not counted as kept, and counts again while it is connected",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const desktop = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: bearer,
        ttl: Duration.seconds(1),
      });
      yield* TestClock.adjust(Duration.seconds(2));
      const current = yield* sessions.issue({ subject: "settings-page" });

      const unseen = yield* sessions.revokeAllExcept(current.sessionId);
      yield* sessions.markConnected(desktop.sessionId);
      const connected = yield* sessions.revokeAllExcept(current.sessionId);

      expect(unseen).toEqual({ revokedCount: 0, kept: { desktop: 0, pen: 0 } });
      expect(connected).toEqual({ revokedCount: 0, kept: { desktop: 1, pen: 0 } });
      expect((yield* sessions.listActive()).map((row) => row.sessionId)).toContain(
        desktop.sessionId,
      );
    }).pipe(Effect.provide(layerSessionStore)),
);
