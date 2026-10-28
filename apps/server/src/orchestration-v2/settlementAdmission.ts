import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as TxRef from "effect/TxRef";

export const TARGET_CAPACITY = 256;
const TARGET_WORKERS = 8;

type Target = {
  readonly running: boolean;
  readonly rerun: boolean;
};
type State<K> = {
  readonly targets: ReadonlyMap<K, Target>;
  readonly full: "idle" | "queued" | "running" | "rerun";
  readonly refreshFull: boolean;
  readonly closed: boolean;
};

const requestFull = <K>(state: State<K>, refresh: boolean): State<K> =>
  (state.full === "queued" || state.full === "rerun") && (!refresh || state.refreshFull)
    ? state
    : {
        ...state,
        full: state.full === "running" || state.full === "rerun" ? "rerun" : "queued",
        refreshFull: state.refreshFull || refresh,
      };

export const make = Effect.fn("settlementAdmission.make")(function* <K, E, R>(options: {
  readonly targeted: (key: K) => Effect.Effect<void, E, R>;
  readonly full: (refresh: boolean) => Effect.Effect<void, E, R>;
}) {
  const state = yield* TxRef.make<State<K>>({
    targets: new Map(),
    full: "idle",
    refreshFull: false,
    closed: false,
  });
  yield* Effect.addFinalizer(() =>
    TxRef.set(state, {
      targets: new Map(),
      full: "idle",
      refreshFull: false,
      closed: true,
    }).pipe(Effect.tx),
  );

  // All reservations and both lanes' drain milestones commit in the same transaction.
  const enqueue = Effect.fn("settlementAdmission.enqueue")(function* (key: K) {
    const current = yield* TxRef.get(state);
    if (current.closed) return yield* Effect.interrupt;
    const previous = current.targets.get(key);
    if (previous === undefined && current.targets.size === TARGET_CAPACITY) {
      yield* TxRef.set(state, requestFull(current, true));
      return;
    }
    if (previous !== undefined && (!previous.running || previous.rerun)) return;
    const targets = new Map(current.targets);
    targets.set(key, {
      running: previous?.running ?? false,
      rerun: previous?.running === true,
    });
    yield* TxRef.set(state, { ...current, targets });
  }, Effect.tx);

  const enqueueFull = TxRef.get(state).pipe(
    Effect.flatMap((current) =>
      current.closed ? Effect.interrupt : TxRef.set(state, requestFull(current, false)),
    ),
    Effect.tx,
  );

  const takeTarget = Effect.gen(function* () {
    const current = yield* TxRef.get(state);
    if (current.closed) return yield* Effect.interrupt;
    for (const [key, target] of current.targets) {
      if (target.running) continue;
      const targets = new Map(current.targets);
      targets.set(key, { running: true, rerun: false });
      yield* TxRef.set(state, { ...current, targets });
      return key;
    }
    return yield* Effect.txRetry;
  }).pipe(Effect.tx);

  const finishTarget = (key: K) =>
    TxRef.update(state, (current) => {
      const previous = current.targets.get(key);
      const targets = new Map(current.targets);
      targets.delete(key);
      // Moving a dirty key to the tail keeps a hot thread behind already queued work.
      if (!current.closed && previous?.rerun) {
        targets.set(key, { running: false, rerun: false });
      }
      return { ...current, targets };
    }).pipe(Effect.tx);

  const recover = (cause: Cause.Cause<E>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logWarning("settlement admission work failed", { cause: Cause.pretty(cause) });

  for (let index = 0; index < TARGET_WORKERS; index++) {
    yield* takeTarget.pipe(
      Effect.flatMap((key) =>
        Effect.suspend(() => options.targeted(key)).pipe(
          Effect.catchCause(recover),
          Effect.ensuring(finishTarget(key)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }

  const takeFull = Effect.gen(function* () {
    const current = yield* TxRef.get(state);
    if (current.closed) return yield* Effect.interrupt;
    if (current.full !== "queued") return yield* Effect.txRetry;
    yield* TxRef.set<State<K>>(state, { ...current, full: "running", refreshFull: false });
    return current.refreshFull;
  }).pipe(Effect.tx);
  const finishFull = TxRef.update(state, (current): State<K> => ({
    ...current,
    full: !current.closed && current.full === "rerun" ? "queued" : "idle",
  })).pipe(Effect.tx);
  yield* takeFull.pipe(
    Effect.flatMap((refresh) =>
      Effect.suspend(() => options.full(refresh)).pipe(
        Effect.catchCause(recover),
        Effect.ensuring(finishFull),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const drain = TxRef.get(state).pipe(
    Effect.flatMap((current) =>
      current.targets.size === 0 && current.full === "idle" ? Effect.void : Effect.txRetry,
    ),
    Effect.tx,
  );
  const drainFull = TxRef.get(state).pipe(
    Effect.flatMap((current) => (current.full === "idle" ? Effect.void : Effect.txRetry)),
    Effect.tx,
  );
  const snapshot = TxRef.get(state).pipe(
    Effect.map((current) => ({
      reserved: current.targets.size,
      queued: [...current.targets.values()].filter((target) => !target.running).length,
      running: [...current.targets.values()].filter((target) => target.running).length,
      rerun: [...current.targets.values()].filter((target) => target.rerun).length,
      full: current.full,
      refreshFull: current.refreshFull,
      closed: current.closed,
    })),
  );
  return { enqueue, enqueueFull, drain, drainFull, snapshot };
});
