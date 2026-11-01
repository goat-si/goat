import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, type AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Client from "./DecisionClient.ts";
import * as Sessions from "../auth/SessionStore.ts";

it.effect(
  "preservation #1405: a client remote permit reloads grants and refuses revoked sessions",
  () => {
    const sessionId = AuthSessionId.make("decision-client");
    let scopes: ReadonlyArray<AuthEnvironmentScope> = [
      "orchestration:read",
      "orchestration:operate",
    ];
    let revoked = false;
    return Effect.gen(function* () {
      const caller = yield* Client.caller(EnvironmentId.make("origin"), { sessionId, scopes });
      const required = ["orchestration:read", "orchestration:operate"] as const;
      const permit = caller.reauthorize(required);
      yield* permit;
      scopes = ["orchestration:read"];
      expect(yield* permit.pipe(Effect.flip)).toMatchObject({
        requiredScope: "orchestration:operate",
      });
      scopes = required;
      revoked = true;
      expect(yield* permit.pipe(Effect.flip)).toMatchObject({
        requiredScope: "orchestration:read",
      });
    }).pipe(
      Effect.provide(
        Layer.mock(Sessions.SessionStore)({
          cookieName: "fixture",
          legacyCookieName: undefined,
          readActiveScopes: () =>
            Effect.suspend(() =>
              revoked
                ? Effect.fail(new Sessions.UnknownSessionTokenError({ sessionId }))
                : Effect.succeed(scopes),
            ),
        }),
      ),
    );
  },
);
