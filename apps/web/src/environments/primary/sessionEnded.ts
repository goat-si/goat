import { ConnectionTransientError } from "@goat/client-runtime/connection";
import type { ClientCapabilities } from "@goat/client-runtime/platform";
import { makeEnvironmentHttpApiClient } from "@goat/client-runtime/rpc";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, type HttpClient } from "effect/http";

import { isPrimaryAuthGateAuthenticated } from "./auth";
import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "./httpLayer";

/** The page asking: its origin, and whether it signed in to that origin's server by cookie. */
interface PageSignIn {
  readonly origin: string;
  readonly signedInByCookie: boolean;
}

/** Refuses redirects for one request, keeping the other fetch options its context carries. */
const refusingRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.serviceOption(FetchHttpClient.RequestInit), (init) =>
    Effect.provideService(effect, FetchHttpClient.RequestInit, {
      ...Option.getOrElse(init, () => ({})),
      redirect: "error",
    }),
  );

/** One auth/session read with no retry: only the server's decoded "not signed in" is true. */
const readSessionEnded = (httpBaseUrl: string) =>
  makeEnvironmentHttpApiClient(httpBaseUrl).pipe(
    // A followed redirect could read another server's answer, where this cookie is not sent.
    Effect.flatMap((client) => refusingRedirects(client.auth.session({ headers: {} }))),
    Effect.map((session) => !session.authenticated),
    Effect.catchCause(() => Effect.succeed(false)),
  );

function sameOrigin(httpBaseUrl: string, origin: string): boolean {
  try {
    return new URL(httpBaseUrl).origin === origin;
  } catch {
    return false;
  }
}

export function makePrimaryEnvironmentAuth(input: {
  readonly page: () => PageSignIn;
  readonly httpLayer: Layer.Layer<HttpClient.HttpClient>;
}) {
  return {
    bearerToken: Effect.tryPromise({
      try: readDesktopPrimaryBearerToken,
      catch: (cause) =>
        new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: `Could not load the desktop primary credential: ${String(cause)}`,
        }),
    }).pipe(Effect.map(Option.fromNullishOr)),
    // The connection driver bounds the read; interrupting it aborts the request.
    sessionEnded: Effect.fn("PrimaryEnvironmentAuth.sessionEnded")(function* (httpBaseUrl: string) {
      const page = input.page();
      if (!page.signedInByCookie || !sameOrigin(httpBaseUrl, page.origin)) return false;
      return yield* readSessionEnded(httpBaseUrl).pipe(Effect.provide(input.httpLayer));
    }),
  } satisfies ClientCapabilities.PrimaryEnvironmentAuth["Service"];
}

/** Web's primary sign-in: the desktop bridge's bearer, or this tab's cookie at its own origin. */
export const primaryEnvironmentAuth = makePrimaryEnvironmentAuth({
  page: () => ({
    origin: window.location.origin,
    signedInByCookie:
      PrimaryEnvironmentHttpLayer.isSameOriginBrowserPrimary() && isPrimaryAuthGateAuthenticated(),
  }),
  httpLayer: PrimaryEnvironmentHttpLayer.layer,
});
