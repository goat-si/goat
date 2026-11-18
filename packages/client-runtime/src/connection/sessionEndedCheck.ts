import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RouteCheck } from "./driver.ts";
import {
  ConnectionBlockedError,
  type ConnectionTransientError,
  type PreparedConnection,
} from "./model.ts";

const HTTP_SCHEME_FOR_SOCKET: Partial<Record<string, string>> = {
  "ws:": "http:",
  "wss:": "https:",
};

/** Whether the socket and the HTTP base URL reach one server: same host and port, paired schemes. */
function sameServer(prepared: PreparedConnection): boolean {
  try {
    const socket = new URL(prepared.socketUrl);
    const http = new URL(prepared.httpBaseUrl);
    return HTTP_SCHEME_FOR_SOCKET[socket.protocol] === http.protocol && socket.host === http.host;
  } catch {
    return false;
  }
}

/** A browser signed in to its own server by cookie sees a refused upgrade only as a failed socket. */
function mayBeRefusedCookie(prepared: PreparedConnection, failure: ConnectionTransientError) {
  return (
    failure.reason === "transport" &&
    prepared.target._tag === "PrimaryConnectionTarget" &&
    prepared.httpAuthorization === null &&
    sameServer(prepared)
  );
}

// Asks once, within the route check budget: the session is gone, and the server that said so
// is this environment, so another GOAT answering on the same port cannot strand the tab.
export const classifySocketFailure = (
  prepared: PreparedConnection,
  failure: ConnectionTransientError,
  check: {
    readonly sessionEnded: ((httpBaseUrl: string) => Effect.Effect<boolean>) | undefined;
    readonly checkHost: (prepared: PreparedConnection) => Effect.Effect<RouteCheck>;
    readonly timeoutMs: number;
  },
) => {
  const sessionEnded = check.sessionEnded;
  if (sessionEnded === undefined || !mayBeRefusedCookie(prepared, failure))
    return Effect.fail(failure);
  return sessionEnded(prepared.httpBaseUrl).pipe(
    Effect.flatMap((ended) =>
      ended
        ? check.checkHost(prepared).pipe(Effect.map((answer) => answer === "answered"))
        : Effect.succeed(false),
    ),
    Effect.timeoutOption(check.timeoutMs),
    Effect.withSpan("ConnectionDriver.checkSession"),
    Effect.flatMap((ended) =>
      Effect.fail<ConnectionTransientError | ConnectionBlockedError>(
        Option.getOrElse(ended, () => false)
          ? new ConnectionBlockedError({
              reason: "authentication",
              hop: "server",
              via: "direct",
              sessionEnded: true,
              detail: `This browser is no longer signed in to ${prepared.label}.`,
            })
          : failure,
      ),
    ),
  );
};
