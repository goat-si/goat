import type { PenSnapshot, PenWatchStale } from "@goat/pen-protocol/snapshot";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

/** More members than this is treated as no list at all, never as a shortened one. */
const PEN_MEMBER_CAP = 1024;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export type PenMembershipView =
  | { readonly kind: "unavailable"; readonly reason: "no-pen" | "daemon-down" | "stale" }
  | { readonly kind: "not-member" }
  | { readonly kind: "ready"; readonly snapshot: PenSnapshot; readonly selfName: string };

export interface PenMembershipSource {
  /** Undefined when PEN_HOME is set to a path Pen itself would not use. */
  readonly stateDir: string | undefined;
  readonly stateDirExists: (stateDir: string) => Effect.Effect<boolean>;
  readonly leftMesh: (stateDir: string) => Effect.Effect<boolean>;
  readonly watch: (input: {
    readonly stateDir: string;
    readonly onSnapshot: (snapshot: PenSnapshot) => void;
    readonly onStale: (reason: PenWatchStale) => void;
  }) => () => void;
}

export interface PenMembershipTurn {
  /** False once a newer view exists; work done for an older view is dropped. */
  readonly isCurrent: () => boolean;
  /** Completes when a newer view arrives, and leaves that view to be handled next. */
  readonly superseded: Effect.Effect<void>;
}

const viewOf = (snapshot: PenSnapshot): PenMembershipView => {
  const self = snapshot.members.find((member) => member.nodeId === snapshot.self);
  return self === undefined
    ? { kind: "not-member" }
    : snapshot.members.length - 1 > PEN_MEMBER_CAP
      ? { kind: "unavailable", reason: "stale" }
      : { kind: "ready", snapshot, selfName: self.name };
};

/**
 * Follows Pen membership forever. A dead watch is `unavailable`, never a departure; only Pen's
 * left marker or a list without this machine is `not-member`. `observe` runs in the socket
 * callback so use-time checks never lag; `handle` runs one view at a time, latest wins.
 * Nothing may authorize from a view: it only proposes who to check.
 */
export const followPenMembership = Effect.fn("ssh/penMembershipWatch.follow")(function* (
  source: PenMembershipSource,
  observe: (view: PenMembershipView) => void,
  handle: (view: PenMembershipView, turn: PenMembershipTurn) => Effect.Effect<void>,
) {
  const wake = yield* Queue.sliding<void>(1);
  let latest: { readonly view: PenMembershipView } | undefined;
  const emit = (view: PenMembershipView) => {
    latest = { view };
    observe(view);
    Queue.offerUnsafe(wake, undefined);
  };

  const session = Effect.fn("ssh/penMembershipWatch.session")(function* (stateDir: string) {
    const stale = yield* Deferred.make<PenWatchStale>();
    let sawSnapshot = false;
    let ended = false;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        source.watch({
          stateDir,
          onSnapshot: (snapshot) => {
            if (ended) return;
            sawSnapshot = true;
            emit(viewOf(snapshot));
          },
          onStale: (reason) => {
            if (ended) return;
            ended = true;
            observe({
              kind: "unavailable",
              reason: reason === "connect" ? "daemon-down" : "stale",
            });
            Deferred.doneUnsafe(stale, Effect.succeed(reason));
          },
        }),
      ),
      (stop) =>
        Effect.sync(() => {
          ended = true;
          stop();
        }),
    );
    const reason = yield* Deferred.await(stale);
    emit(
      (yield* source.leftMesh(stateDir))
        ? { kind: "not-member" }
        : { kind: "unavailable", reason: reason === "connect" ? "daemon-down" : "stale" },
    );
    return sawSnapshot;
  }, Effect.scoped);

  let failures = 0;
  const attempt = Effect.gen(function* () {
    const stateDir = source.stateDir;
    if (stateDir === undefined || !(yield* source.stateDirExists(stateDir)))
      emit({ kind: "unavailable", reason: "no-pen" });
    else if (yield* session(stateDir)) failures = 0;
    yield* Effect.sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures));
    failures = Math.min(failures + 1, 6);
  });

  const turn = Effect.gen(function* () {
    yield* Queue.take(wake);
    const event = latest;
    if (event === undefined) return;
    yield* handle(event.view, {
      isCurrent: () => latest === event,
      superseded: Queue.take(wake).pipe(
        Effect.andThen(Effect.sync(() => void Queue.offerUnsafe(wake, undefined))),
      ),
    }).pipe(
      // One bad pass must not end the watch for the life of the process.
      Effect.catchCause((cause) => Effect.logWarning("pen.membership.handle.failed", cause)),
    );
  });

  return yield* Effect.all([Effect.forever(attempt), Effect.forever(turn)], {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.andThen(Effect.never));
});
