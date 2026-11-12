import { ChannelGatewayError } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

/**
 * Tells a mounted client that an owner's channel tasks changed, so it reads them again. It carries
 * no task data: only the owner id inside the server and a revision on the wire.
 */
export interface ChannelTaskChanges {
  /** Owners whose tasks a committed write changed. */
  readonly announce: (ownerIds: Iterable<string>) => Effect.Effect<void>;
  /**
   * Revision 0 at once, then one more for each window of changes to this owner's tasks. Fails with
   * stream_unavailable when the server holds as many streams as it allows.
   */
  readonly revisions: (ownerId: string) => Stream.Stream<number, ChannelGatewayError>;
  /**
   * Runs a write and announces its owners once it committed. Inside a caller's transaction it
   * announces nothing: that caller announces after its own commit, the outermost one.
   */
  readonly afterCommit: <A, E, R>(
    write: Effect.Effect<A, E, R>,
    ownersOf: (result: A) => Iterable<string>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * A change opens a window this long; it and everything landing in it reach a subscriber as one
 * revision when it closes, so a steady stream of changes still reports once per window.
 */
export const TASK_CHANGES_COALESCE = Duration.millis(250);
/** Change streams one server holds open, across every connection. */
const MAX_TASK_CHANGE_STREAMS = 512;
/** Change streams one connection holds open; a client shares one per server. */
export const MAX_TASK_CHANGE_STREAMS_PER_CONNECTION = 4;

/** Why a client gets no task change stream; it reads on open and focus instead, never retrying. */
export const streamUnavailable = () => new ChannelGatewayError({ reason: "stream_unavailable" });

/** Admits at most limit open streams; one over it fails with stream_unavailable. */
export const makeStreamLimit = (limit: number) => {
  let open = 0;
  return <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | ChannelGatewayError, R> =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.suspend(() =>
          open >= limit
            ? Effect.fail(streamUnavailable())
            : Effect.sync(() => {
                open += 1;
              }),
        ),
        () =>
          Effect.sync(() => {
            open -= 1;
          }),
      ).pipe(Effect.as(stream)),
    );
};

export const makeChannelTaskChanges = Effect.fn("makeChannelTaskChanges")(function* (
  sql: SqlClient.SqlClient,
  maxStreams: number = MAX_TASK_CHANGE_STREAMS,
) {
  const limited = makeStreamLimit(maxStreams);
  // One mark per subscriber, held only for its owner: a change sets it, and changes while it is
  // set add nothing, so a slow subscriber holds one pending "read again" and never misses it.
  const marks = new Map<string, Set<Queue.Queue<void>>>();
  const announce: ChannelTaskChanges["announce"] = (ownerIds) =>
    Effect.sync(() => {
      for (const ownerId of new Set(ownerIds))
        for (const mark of marks.get(ownerId) ?? []) Queue.offerUnsafe(mark, undefined);
    });
  const subscribe = (ownerId: string) =>
    Effect.acquireRelease(
      Effect.map(Queue.dropping<void>(1), (mark) => {
        const owned = marks.get(ownerId) ?? new Set();
        owned.add(mark);
        marks.set(ownerId, owned);
        return mark;
      }),
      (mark) =>
        Effect.sync(() => {
          const owned = marks.get(ownerId);
          owned?.delete(mark);
          if (owned?.size === 0) marks.delete(ownerId);
        }),
    );
  const windowClosed = (mark: Queue.Queue<void>) =>
    Queue.take(mark).pipe(
      Effect.andThen(Effect.sleep(TASK_CHANGES_COALESCE)),
      Effect.andThen(Queue.clear(mark)),
    );
  const changes: ChannelTaskChanges = {
    announce,
    // Subscribed before revision 0 goes out, so nothing announced after a client saw 0 is missed.
    revisions: (ownerId) =>
      limited(
        Stream.unwrap(
          Effect.map(subscribe(ownerId), (mark) =>
            Stream.fromEffectRepeat(windowClosed(mark)).pipe(
              Stream.scan(
                () => 0,
                (revision) => revision + 1,
              ),
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
