import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

/**
 * Tells a mounted client that an owner's channel tasks changed, so it reads them again. It carries
 * no task data: only the owner id inside the server and a revision on the wire.
 */
export interface ChannelTaskChanges {
  /** Owners whose tasks a committed write changed. */
  readonly announce: (ownerIds: Iterable<string>) => Effect.Effect<void>;
  /** Revision 0 at once, then one more for each burst of changes to this owner's tasks. */
  readonly revisions: (ownerId: string) => Stream.Stream<number>;
  /**
   * Runs a write and announces its owners once it committed. Inside a caller's transaction it
   * announces nothing: that caller announces after its own commit, the outermost one.
   */
  readonly afterCommit: <A, E, R>(
    write: Effect.Effect<A, E, R>,
    ownersOf: (result: A) => Iterable<string>,
  ) => Effect.Effect<A, E, R>;
}

/** Changes landing within this window reach a subscriber as one revision. */
export const TASK_CHANGES_COALESCE = Duration.millis(250);
/** Pending owner ids per server; a slow subscriber loses the oldest, which only means "read again". */
const PENDING_OWNERS = 256;

export const makeChannelTaskChanges = Effect.fn("makeChannelTaskChanges")(function* (
  sql: SqlClient.SqlClient,
) {
  const owners = yield* PubSub.sliding<string>(PENDING_OWNERS);
  const announce: ChannelTaskChanges["announce"] = (ownerIds) =>
    Effect.forEach(new Set(ownerIds), (ownerId) => PubSub.publish(owners, ownerId), {
      discard: true,
    });
  const changes: ChannelTaskChanges = {
    announce,
    // Subscribed before revision 0 goes out, so nothing announced after a client saw 0 is missed.
    revisions: (ownerId) =>
      Stream.unwrap(
        Effect.map(PubSub.subscribe(owners), (subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === ownerId),
            Stream.debounce(TASK_CHANGES_COALESCE),
            Stream.scan(
              () => 0,
              (revision) => revision + 1,
            ),
          ),
        ),
      ),
    afterCommit: (write, ownersOf) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
        Option.isSome(outer) ? write : Effect.tap(write, (result) => announce(ownersOf(result))),
      ),
  };
  return changes;
});

/** For read-only callers of the bot ledger: their reads change no task. */
export const readOnlyTaskChanges: ChannelTaskChanges = {
  announce: () => Effect.void,
  revisions: () => Stream.make(0),
  afterCommit: (write) => write,
};
