import {
  WS_METHODS,
  type ConnectionCatalogOperation,
  type ConnectionCatalogResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";

import { subscribeDynamicWithSession } from "./client.ts";

/** Replies on the receiving socket; one operation completes before the next starts. */
export function serveConnectionCatalog<R>(
  handle: (
    operation: ConnectionCatalogOperation,
  ) => Effect.Effect<ConnectionCatalogResult, never, R>,
) {
  return subscribeDynamicWithSession(WS_METHODS.connectionCatalogServe, () => Effect.succeed({}), {
    onExpectedFailure: (cause) =>
      Effect.logDebug("Connection catalog host subscription stopped.", { cause }),
  }).pipe(
    Stream.runForEach(([session, request]) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (
          DateTime.toEpochMillis(now) >=
          DateTime.toEpochMillis(DateTime.makeUnsafe(request.expiresAt))
        ) {
          yield* Effect.logDebug("Expired connection catalog host request skipped.", {
            requestId: request.requestId,
          });
          return;
        }
        const result = yield* handle(request.operation);
        yield* session.client[WS_METHODS.connectionCatalogRespond]({
          requestId: request.requestId,
          result,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logDebug("Connection catalog host response failed.", { cause }),
          ),
        );
      }).pipe(Effect.uninterruptible),
    ),
  );
}
