import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const unused = () => Effect.die("not used at start");

it.effect(
  "a member session past the limit at start has no live scopes, even while Pen is closed",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const row = (index: number): AuthSessions.AuthSessionRecord => ({
        sessionId: AuthSessionId.make(`member-${index}`),
        subject: `pen-member:${"a".repeat(26)}`,
        scopes: AuthStandardClientScopes,
        method: "bearer-access-token",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "bot",
          os: null,
          browser: null,
        },
        issuedAt: now,
        expiresAt: DateTime.add(now, { hours: 1 }),
        lastConnectedAt: null,
        revokedAt: null,
        principalKind: "outside_client",
        penBinding: null,
        penMemberNode: "a".repeat(26),
      });
      // More than the limit, as a database written before it could hold.
      const rows = Array.from({ length: AuthSessions.MAX_LIVE_PEN_MEMBER_SESSIONS + 1 }, (_, i) =>
        row(i),
      );
      const sessions = yield* SessionStore.SessionStore.pipe(
        Effect.provide(
          Layer.effect(SessionStore.SessionStore, SessionStore.make).pipe(
            Layer.provide(
              Layer.succeed(AuthSessions.AuthSessionRepository, {
                create: unused,
                createReplacingActive: unused,
                createIfAbsent: unused,
                getById: unused,
                listActive: () => Effect.succeed(rows),
                listUnrevoked: unused,
                revoke: unused,
                revokeAllExcept: unused,
                setLastConnectedAt: unused,
                setClientConnection: unused,
                listPenBound: () => Effect.succeed([]),
                countActivePenBound: () => Effect.succeed({ member: 0, total: 0 }),
                deleteInactivePenBound: () => Effect.succeed(0),
              }),
            ),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(SqlitePersistence.layerMemory),
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
              }),
            ),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-limit-test-" }),
            ),
          ),
        ),
      );
      // Pen is closed, so the tracked ones are denied; the one past the limit must be too.
      for (const index of [0, AuthSessions.MAX_LIVE_PEN_MEMBER_SESSIONS]) {
        const refused = yield* Effect.flip(
          sessions.readActiveScopes(AuthSessionId.make(`member-${index}`)),
        );
        expect(refused._tag).toBe("UnknownSessionTokenError");
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
