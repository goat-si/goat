import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { RECONNECT_DELAY } from "./connectionConstants.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

const OWNED_RECONNECT_SCHEDULE = Schedule.exponential(RECONNECT_DELAY).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);
// A live owned server is retried until it answers; these failures repeat however long it waits.
export const isPermanentRecoveryError = (error: unknown) => {
  if (Schema.isSchemaError(error)) return true;
  if (
    P.isTagged(error, "UnauthorizedError") ||
    P.isTagged(error, "InvalidRequestError") ||
    P.isTagged(error, "InvalidCursorError")
  ) {
    return true;
  }
  const http = OpenCode2Server.httpFailureOf(error);
  if (http !== undefined) {
    const status = http.response?.status;
    return (
      status !== undefined && status >= 400 && status < 500 && !TRANSIENT_HTTP_STATUSES.has(status)
    );
  }
  // ClientError also wraps an SSE retry request, which clears.
  return (
    P.isTagged(error, "ClientError") &&
    P.hasProperty(error, "cause") &&
    Schema.isSchemaError(error.cause)
  );
};
export const OWNED_RECOVERY_RETRY = {
  schedule: OWNED_RECONNECT_SCHEDULE,
  while: (error: unknown) => !isPermanentRecoveryError(error),
};
export class OpenCode2ServerExitedError extends Schema.TaggedError<OpenCode2ServerExitedError>()(
  "OpenCode2ServerExitedError",
  {},
) {}
