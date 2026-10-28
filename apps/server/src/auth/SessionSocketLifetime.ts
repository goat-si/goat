import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import type { AuthenticatedSession } from "./EnvironmentAuth.ts";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as SessionStore from "./SessionStore.ts";

export const run = Effect.fn("SessionSocketLifetime.run")(function* <E, R>(
  session: AuthenticatedSession,
  socket: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const sessions = yield* SessionStore.SessionStore;
  const access = yield* HubConnectAccess.HubConnectAccess;
  if (!HubConnectAccess.admits(session, yield* access.current)) return HttpServerResponse.empty();
  return yield* Effect.acquireUseRelease(
    sessions.markConnected(session.sessionId),
    () =>
      Effect.raceFirst(
        socket,
        Effect.raceFirst(
          access.awaitDenial(session),
          sessions.awaitInvalidation(session.sessionId),
        ).pipe(Effect.as(HttpServerResponse.empty())),
      ),
    () => sessions.markDisconnected(session.sessionId),
  );
});

/** Completes once the session loses its authority; a failed check counts as lost. */
export const watch = Effect.fn("SessionSocketLifetime.watch")(function* (
  session: AuthenticatedSession,
) {
  const sessions = yield* SessionStore.SessionStore;
  const access = yield* HubConnectAccess.HubConnectAccess;
  return Effect.gen(function* () {
    if (!HubConnectAccess.admits(session, yield* access.current)) return;
    yield* Effect.raceFirst(
      access.awaitDenial(session),
      sessions.awaitInvalidation(session.sessionId),
    );
  }).pipe(Effect.ignore);
});

// Media sockets end with their session's authority but do not count as a connected client.
export const guard = Effect.fn("SessionSocketLifetime.guard")(function* <E, R>(
  session: AuthenticatedSession,
  socket: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const access = yield* HubConnectAccess.HubConnectAccess;
  if (!HubConnectAccess.admits(session, yield* access.current)) return HttpServerResponse.empty();
  const ended = yield* watch(session);
  return yield* Effect.raceFirst(socket, ended.pipe(Effect.as(HttpServerResponse.empty())));
});
