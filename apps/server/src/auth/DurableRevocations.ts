import type { AuthSessionId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type * as AuthSessions from "../persistence/AuthSessions.ts";

const CHECK_INTERVAL = Duration.seconds(5);

/**
 * Ends live sessions another process revoked or whose rows are gone: `goat auth session revoke`,
 * `goat logout` and `goat login` write SQLite from their own process. Only ids a successful read
 * left out count as ended, so a failed read ends nothing. The first check waits one interval, so a
 * short CLI command that builds this store never runs one.
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
    if (live.length === 0) return;
    const unrevoked = new Set(
      yield* NodeSqliteClient.backgroundReads(input.repository.listUnrevoked({ sessionIds: live })),
    );
    const ended = live.filter((sessionId) => !unrevoked.has(sessionId));
    if (ended.length > 0) yield* input.settle(ended);
  });
  // Logs the first failure of a run and its recovery, not every five seconds in between.
  const pass = check().pipe(
    Effect.andThen(Ref.getAndSet(failing, false)),
    Effect.flatMap((recovered) =>
      recovered
        ? Effect.logInfo("Checking for sessions revoked elsewhere works again")
        : Effect.void,
    ),
    Effect.catch((error) =>
      Ref.getAndSet(failing, true).pipe(
        Effect.flatMap((already) =>
          already
            ? Effect.void
            : Effect.logWarning(
                "Could not check for sessions revoked elsewhere; retrying every 5 seconds",
                { reason: error._tag },
              ),
        ),
      ),
    ),
  );
  yield* Effect.sleep(CHECK_INTERVAL).pipe(Effect.andThen(pass), Effect.forever, Effect.forkScoped);
});
