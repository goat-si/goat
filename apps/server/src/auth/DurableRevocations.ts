import type { AuthSessionId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as AuthSessions from "../persistence/AuthSessions.ts";

const CHECK_INTERVAL = Duration.seconds(5);

/**
 * Ends live sessions that another process (the CLI) revoked or deleted. Only ids a successful read
 * left out count as ended. The first check waits one interval, so a short CLI command runs none.
 */
// Untraced: a span here would parent every pass for the server's life; each pass has its own.
export const start = Effect.fnUntraced(function* (input: {
  readonly repository: AuthSessions.AuthSessionRepository["Service"];
  /** Prunes expired grants and returns every id this process holds live. */
  readonly liveIds: Effect.Effect<ReadonlyArray<AuthSessionId>>;
  readonly settle: (ended: ReadonlyArray<AuthSessionId>) => Effect.Effect<void>;
}) {
  const failing = yield* Ref.make(false);
  const check = Effect.fn("SessionStore.settleDurableRevocations")(function* () {
    const live = yield* input.liveIds;
    if (live.length === 0) return false;
    const unrevoked = new Set(
      yield* NodeSqliteClient.backgroundReads(input.repository.listUnrevoked({ sessionIds: live })),
    );
    const ended = live.filter((sessionId) => !unrevoked.has(sessionId));
    if (ended.length > 0) yield* input.settle(ended);
    return true;
  });
  // Logs the first failure of a run and the read that ends it, not every five seconds in between.
  // A defect is a failure too, so the loop keeps going; only interruption (shutdown) ends it.
  const pass = check().pipe(
    Effect.flatMap((read) => (read ? Ref.getAndSet(failing, false) : Effect.succeed(false))),
    Effect.flatMap((recovered) =>
      recovered
        ? Effect.logInfo("Checking for sessions revoked elsewhere works again")
        : Effect.void,
    ),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Ref.getAndSet(failing, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : Effect.logWarning(
                  "Could not check for sessions revoked elsewhere; retrying every 5 seconds",
                  // A bounded category only: a defect's text could carry anything.
                  {
                    reason: Option.getOrElse(
                      Option.map(Cause.findErrorOption(cause), (error) => error._tag),
                      () => "defect",
                    ),
                  },
                ),
          ),
        ),
    ),
  );
  yield* Effect.sleep(CHECK_INTERVAL).pipe(Effect.andThen(pass), Effect.forever, Effect.forkScoped);
});
