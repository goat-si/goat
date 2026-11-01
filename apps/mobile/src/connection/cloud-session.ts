import { ClientCapabilities } from "@goat/client-runtime/platform";
import type { ManagedRelaySession } from "@goat/client-runtime/relay";
import { ConnectionBlockedError, ConnectionTransientError } from "@goat/client-runtime/connection";
import { GOAT_CONNECT_COMING_SOON, isGoatConnectEnabled } from "@goat/shared/goatConnect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export function makeMobileCloudSession(readSession: () => ManagedRelaySession | null) {
  return ClientCapabilities.CloudSession.of({
    identity: Effect.sync(() =>
      Option.fromNullishOr(isGoatConnectEnabled() ? readSession() : null),
    ),
    clerkToken: Effect.gen(function* () {
      if (!isGoatConnectEnabled()) {
        return yield* new ConnectionBlockedError({
          reason: "unsupported",
          detail: `${GOAT_CONNECT_COMING_SOON.title} · ${GOAT_CONNECT_COMING_SOON.status}. ${GOAT_CONNECT_COMING_SOON.description}`,
        });
      }
      const session = readSession();
      if (session === null) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "Sign in to GOAT Connect to connect this environment.",
        });
      }
      const token = yield* session.readClerkToken().pipe(
        Effect.mapError(
          (error) =>
            new ConnectionTransientError({
              reason: "network",
              detail: error.message,
            }),
        ),
      );
      if (token === null) {
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "The GOAT Connect session is unavailable.",
        });
      }
      return token;
    }),
  });
}
