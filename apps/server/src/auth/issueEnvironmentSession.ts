import { AuthStandardClientScopes } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import {
  type EnvironmentAuth,
  type IssuedBearerSession,
  ServerAuthSessionTokenIssueError,
} from "./EnvironmentAuth.ts";

export const make = Effect.fn("IssuedEnvironmentSession.make")(function* (defaultSubject: string) {
  const sessions = yield* SessionStore.SessionStore;
  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) =>
    input?.subject === PairingGrantStore.DESKTOP_BOOTSTRAP_SUBJECT
      ? Effect.fail(new PairingGrantStore.ReservedAuthSubjectError())
      : sessions
          .issue({
            subject: input?.subject ?? defaultSubject,
            method: "bearer-access-token",
            scopes: input?.scopes ?? AuthStandardClientScopes,
            client: {
              ...(input?.label ? { label: input.label } : {}),
              deviceType: "bot",
            },
            ...(input?.ttl ? { ttl: input.ttl } : {}),
            ...(input?.runtimeModeCeiling ? { runtimeModeCeiling: input.runtimeModeCeiling } : {}),
          })
          .pipe(
            Effect.map(
              (issued) =>
                ({
                  sessionId: issued.sessionId,
                  token: issued.token,
                  method: "bearer-access-token",
                  scopes: issued.scopes,
                  subject: input?.subject ?? defaultSubject,
                  client: issued.client,
                  expiresAt: DateTime.toUtc(issued.expiresAt),
                }) satisfies IssuedBearerSession,
            ),
            Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
            Effect.withSpan("EnvironmentAuth.issueSession"),
          );

  return issueSession;
});
